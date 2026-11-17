"""Original watcher's per-run native Job handles; never reconstruct cold evidence.

A worker receives no packet bytes until it belongs to this watcher's Job. Only
that Job can be stopped after the exact worker handle signals exit. Losing this
watcher loses recovery evidence; a later watcher must retain unknown capacity.
"""
import ctypes
import datetime
import json
import os
from pathlib import Path
import threading
import time
import uuid

_ACTIVE = {}
_LOCK = threading.Lock()


class Job:
    def __init__(self):
        from ctypes import wintypes
        class BASIC(ctypes.Structure):
            _fields_=[('ProcessTime',ctypes.c_int64),('JobTime',ctypes.c_int64),('Flags',wintypes.DWORD),('MinSet',ctypes.c_size_t),('MaxSet',ctypes.c_size_t),('ActiveLimit',wintypes.DWORD),('Affinity',ctypes.c_size_t),('Priority',wintypes.DWORD),('Scheduling',wintypes.DWORD)]
        class IO(ctypes.Structure):
            _fields_=[(name,ctypes.c_uint64) for name in ('ReadOps','WriteOps','OtherOps','ReadBytes','WriteBytes','OtherBytes')]
        class EXTENDED(ctypes.Structure):
            _fields_=[('Basic',BASIC),('Io',IO),('ProcessMemory',ctypes.c_size_t),('JobMemory',ctypes.c_size_t),('PeakProcess',ctypes.c_size_t),('PeakJob',ctypes.c_size_t)]
        self.k=ctypes.WinDLL('kernel32',use_last_error=True)
        self.k.CreateJobObjectW.argtypes=[ctypes.c_void_p,ctypes.c_wchar_p];self.k.CreateJobObjectW.restype=ctypes.c_void_p
        self.k.SetInformationJobObject.argtypes=[ctypes.c_void_p,ctypes.c_int,ctypes.c_void_p,wintypes.DWORD]
        self.k.AssignProcessToJobObject.argtypes=[ctypes.c_void_p,ctypes.c_void_p]
        self.k.QueryInformationJobObject.argtypes=[ctypes.c_void_p,ctypes.c_int,ctypes.c_void_p,wintypes.DWORD,ctypes.c_void_p]
        self.k.TerminateJobObject.argtypes=[ctypes.c_void_p,wintypes.UINT]
        self.k.CloseHandle.argtypes=[ctypes.c_void_p]
        self.handle=self.k.CreateJobObjectW(None,None) # Unnamed and non-inheritable.
        info=EXTENDED();info.Basic.Flags=0x2000 # KILL_ON_JOB_CLOSE; no breakaway.
        if not self.handle or not self.k.SetInformationJobObject(self.handle,9,ctypes.byref(info),ctypes.sizeof(info)):
            self.close();raise OSError('Cannot establish validation recovery Job')

    def assign(self,worker):
        # Popen owns the original Windows process handle, not a reopened PID.
        if not self.k.AssignProcessToJobObject(self.handle,int(worker._handle)):
            raise OSError('Cannot bind validation worker to recovery Job')

    def count(self):
        class ACCOUNTING(ctypes.Structure):
            _fields_=[('User',ctypes.c_int64),('Kernel',ctypes.c_int64),('PeriodUser',ctypes.c_int64),('PeriodKernel',ctypes.c_int64),('Faults',ctypes.c_uint32),('Total',ctypes.c_uint32),('Active',ctypes.c_uint32),('Terminated',ctypes.c_uint32)]
        value=ACCOUNTING()
        if not self.k.QueryInformationJobObject(self.handle,1,ctypes.byref(value),ctypes.sizeof(value),None):
            raise OSError('Validation recovery Job query failed')
        return value.Active

    def terminate(self):
        if not self.k.TerminateJobObject(self.handle,2):raise OSError('Validation recovery Job stop failed')

    def close(self):
        if self.handle:self.k.CloseHandle(self.handle);self.handle=None


def release(worker,config_path,cfg,packet,folder):
    """Bind before the first packet byte. Caller has spawned only a stdin gate."""
    job = None
    key = None
    state = None
    try:
        if os.name!='nt' or packet.get('executionKind')!='validation':raise ValueError('Windows validation only')
        run=str(uuid.UUID(packet['runId']));uuid.UUID(packet['lease'])
        expected=(Path(cfg['database']).parent/'outbound'/run).resolve()
        if Path(folder)!=expected:raise ValueError('Invalid recovery folder')
        if packet['companyId']!=cfg['company_id'] or packet['agentId']!=cfg['agent_id']:raise ValueError('Invalid recovery identity')
        key=(str(Path(config_path).resolve()),run)
        job=Job()
        job.assign(worker)
        with _LOCK:
            if key in _ACTIVE:raise ValueError('Recovery identity already bound')
            state=dict(job=job,worker=worker,folder=expected,companyId=cfg['company_id'],seatId=cfg['agent_id'],
                machineId=cfg['seat']['machine_id'],runId=run,lease=packet['lease'])
            _ACTIVE[key]=state
        worker.stdin.write(json.dumps(packet,ensure_ascii=False).encode('utf8'))
        worker.stdin.close()
    except BaseException:
        # Clean only this attempt, using its original handles. Never remove a
        # previous binding when a duplicate identity is rejected.
        if job is not None:job.close()
        try:
            if worker.stdin is not None:worker.stdin.close()
        finally:
            try:
                if worker.poll() is None:worker.terminate()
                worker.wait(timeout=8)
            finally:
                with _LOCK:
                    if state is not None and _ACTIVE.get(key) is state:
                        del _ACTIVE[key]
        raise


def recover(b):
    from pilot import atomic_json,read_json
    config=str(Path(b.config_path).resolve())
    with _LOCK:
        for key,state in list(_ACTIVE.items()):
            if key[0]!=config or state['worker'].poll() is None:continue
            job=state['job'];folder=state['folder'];journal=folder/'validation-recovery.json'
            try:
                if (state['companyId']!=b.cfg['company_id'] or state['seatId']!=b.cfg['agent_id'] or
                    state['machineId']!=b.cfg['seat']['machine_id']):continue
                if not journal.is_file() or journal.resolve()!=journal or journal.stat().st_size>4096:
                    # No trusted launched journal: stop our tree but do not
                    # synthesize a no-start claim or replace native settlement.
                    job.close();del _ACTIVE[key];continue
                saved=read_json(journal)
                fields=('runId','companyId','seatId','machineId','lease')
                if any(saved.get(k)!=state[k] for k in fields) or saved.get('supervisorPid')!=state['worker'].pid:continue
                if saved.get('receiptQueued') is True:
                    job.close();del _ACTIVE[key];continue # Normal exit/ACK owns settlement.
                receipt_path=folder/'exit-receipt.json'
                receipt=dict(runId=state['runId'],lease=state['lease'])
                if receipt_path.exists():
                    if receipt_path.resolve()!=receipt_path or receipt_path.stat().st_size>4096:continue
                    receipt=read_json(receipt_path)
                    if not isinstance(receipt,dict) or receipt.get('runId')!=state['runId'] or receipt.get('lease')!=state['lease']:continue
                    if 'treeProof' in receipt:continue # Preserve existing evidence byte-for-byte.
                    if set(receipt)!={'runId','lease'}:continue
                job.terminate()
                first=time.time()
                if job.count():continue
                time.sleep(.3)
                if job.count():continue
                iso=lambda t:datetime.datetime.fromtimestamp(t,datetime.timezone.utc).isoformat()
                proof=dict(protocolVersion=1,runId=state['runId'],isolation='windows-job',firstObservedAt=iso(first),observedAt=iso(time.time()),observations=2,remaining=0)
                atomic_json(receipt_path,{**receipt,'treeProof':proof})
                atomic_json(journal,{**saved,'receiptQueued':True})
                job.close();del _ACTIVE[key]
            except (OSError,ValueError,KeyError,TypeError):
                continue # Retain native handle and unknown capacity for retry.
