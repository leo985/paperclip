"""Verify the managed execution boundary, never infer a tree exit from a PID.
POSIX children remain in the launcher session plus explicitly registered PTY
sessions. Windows children inherit the supervisor's non-breakaway Job Object.
An inspection failure is unknown and cannot produce a stopped receipt.
"""
import contextlib
import ctypes
import json
import os
from pathlib import Path
import signal
import subprocess
import threading
import time
from platform_support import WINDOWS, _JOB_HANDLES
from pilot import BridgeError


def posix_members(sessions):
    raw = subprocess.run(['/bin/ps', '-axo', 'pid=,stat='], capture_output=True, text=True, check=True, timeout=5).stdout
    result = []
    for line in raw.splitlines():
        fields = line.split()
        if len(fields) != 2: raise BridgeError('进程检查结果不完整')
        pid = int(fields[0])
        try: sid = os.getsid(pid)
        except ProcessLookupError: continue
        if sid in sessions and not fields[1].startswith('Z'): result.append(pid)
    return result


def windows_members():
    if not _JOB_HANDLES: raise BridgeError('受管进程缺少 Windows Job Object')
    k = ctypes.WinDLL('kernel32', use_last_error=True)
    k.QueryInformationJobObject.argtypes = [ctypes.c_void_p, ctypes.c_int, ctypes.c_void_p, ctypes.c_uint32, ctypes.c_void_p]
    class IDS(ctypes.Structure):
        _fields_ = [('assigned', ctypes.c_uint32), ('count', ctypes.c_uint32), ('ids', ctypes.c_size_t * 8192)]
    values = IDS()
    if not k.QueryInformationJobObject(_JOB_HANDLES[0], 3, ctypes.byref(values), ctypes.sizeof(values), None) or values.count > 8192 or values.assigned != values.count:
        raise BridgeError('Windows 受管进程检查失败')
    return [int(pid) for pid in values.ids[:values.count] if pid != os.getpid()]


def kill_job_member(pid):
    k = ctypes.WinDLL('kernel32', use_last_error=True)
    k.OpenProcess.argtypes = [ctypes.c_uint32, ctypes.c_int, ctypes.c_uint32]; k.OpenProcess.restype = ctypes.c_void_p
    k.IsProcessInJob.argtypes = [ctypes.c_void_p, ctypes.c_void_p, ctypes.POINTER(ctypes.c_int)]
    k.TerminateProcess.argtypes = [ctypes.c_void_p, ctypes.c_uint32]; k.CloseHandle.argtypes = [ctypes.c_void_p]
    handle = k.OpenProcess(0x0001 | 0x0100, False, pid)
    if not handle: return
    try:
        member = ctypes.c_int()
        if not k.IsProcessInJob(handle, _JOB_HANDLES[0], ctypes.byref(member)): raise BridgeError('无法核对 Job 进程身份')
        if member.value and not k.TerminateProcess(handle, 1): raise BridgeError('无法停止 Job 进程')
    finally: k.CloseHandle(handle)


class ProcessTree:
    def __init__(self, run_id, anchor=None):
        self.run_id = run_id; self.anchor = Path(anchor) if anchor else None
        self.sessions = set(); self.child = None; self.lock = threading.Lock()
        self.initialized = False

    def attach(self, child):
        self.child = child
        if not WINDOWS and child is not None: self.sessions.add(child.pid)  # Popen(start_new_session=True)
        self.initialized = True

    def members(self):
        if not self.initialized: raise BridgeError('尚未建立受管进程身份')
        if self.anchor and self.anchor.exists():
            record = json.loads(self.anchor.read_text(encoding='utf-8'))
            if record.get('runId') != self.run_id or record.get('supervisorPid') != os.getpid() or type(record.get('sessionId')) is not int or record['sessionId'] <= 1:
                raise BridgeError('PTY 进程树锚点不匹配')
            self.sessions.add(record['sessionId'])
        return windows_members() if WINDOWS else posix_members(self.sessions)

    def stop(self, _child=None, timeout=8):
        with self.lock:
            deadline = time.monotonic() + timeout
            while True:
                members = self.members()
                for pid in members:
                    if WINDOWS: kill_job_member(pid)
                    else:
                        # Recheck membership immediately before signalling. Never
                        # signal a PID which has been recycled outside our sessions.
                        with contextlib.suppress(ProcessLookupError):
                            if os.getsid(pid) in self.sessions: os.kill(pid, signal.SIGKILL)
                if self.child: self.child.poll()
                if not members: return
                if time.monotonic() >= deadline: raise BridgeError('受管进程树停止待核验')
                time.sleep(.1)

    def proof(self):
        started = time.time()
        if self.members(): raise BridgeError('受管进程树尚有活动进程')
        time.sleep(.3)
        if self.members(): raise BridgeError('受管进程树重新出现活动进程')
        from datetime import datetime, timezone
        iso = lambda stamp: datetime.fromtimestamp(stamp, timezone.utc).isoformat()
        return {'protocolVersion': 1, 'runId': self.run_id, 'isolation': 'not-started' if self.child is None else 'windows-job' if WINDOWS else 'posix-sessions',
                'firstObservedAt': iso(started), 'observedAt': iso(time.time()), 'observations': 2, 'remaining': 0}
