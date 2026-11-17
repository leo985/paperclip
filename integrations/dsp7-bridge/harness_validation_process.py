"""Native parent-death fence for the fixed validation child.

Outer native supervisor owns permits and stop proof. This process only ensures
its session cannot survive the supervising outbound worker's disappearance.
"""
import os
import signal
import subprocess
import sys
import threading


def windows_parent(parent):
    """Hold the exact native parent handle, never re-check a recycled PID."""
    import ctypes
    from ctypes import wintypes
    k=ctypes.WinDLL('kernel32',use_last_error=True)
    k.OpenProcess.argtypes=[wintypes.DWORD,wintypes.BOOL,wintypes.DWORD];k.OpenProcess.restype=wintypes.HANDLE
    k.GetCurrentProcess.restype=wintypes.HANDLE
    k.GetProcessTimes.argtypes=[wintypes.HANDLE,*([ctypes.POINTER(wintypes.FILETIME)]*4)]
    k.WaitForSingleObject.argtypes=[wintypes.HANDLE,wintypes.DWORD]
    k.CloseHandle.argtypes=[wintypes.HANDLE]
    handle=k.OpenProcess(0x00100000|0x1000,False,parent)
    if not handle:raise OSError('Validation parent unavailable')
    def created(process):
        times=[wintypes.FILETIME() for _ in range(4)]
        if not k.GetProcessTimes(process,*[ctypes.byref(t) for t in times]):raise OSError('Validation parent identity unavailable')
        return (times[0].dwHighDateTime<<32)|times[0].dwLowDateTime
    try:
        if os.getppid()!=parent or created(handle)>created(k.GetCurrentProcess()) or k.WaitForSingleObject(handle,0)!=258:
            raise ValueError('Validation parent changed or stopped')
        from platform_support import own_process_job, _JOB_HANDLES
        own_process_job()  # A non-inheritable, non-breakaway nested Job.
        k.TerminateJobObject.argtypes=[wintypes.HANDLE,wintypes.UINT]
        job=_JOB_HANDLES[-1]
        def alive():return k.WaitForSingleObject(handle,0)==258
        def terminate():
            k.TerminateJobObject(job,2)
            os._exit(2)  # Failure also closes our last, non-inherited Job handle.
        return alive,terminate,lambda:k.CloseHandle(handle)
    except BaseException:
        k.CloseHandle(handle)
        raise


def main():
    if os.name not in ('posix','nt') or len(sys.argv)<6: raise ValueError('Invalid validation child')
    parent=int(sys.argv[1])
    if parent<=1 or os.getppid()!=parent or (os.name=='posix' and os.getsid(0)!=os.getpid()):
        raise ValueError('Validation child requires its native supervisor session')
    from pathlib import Path
    from pilot import atomic_json
    import uuid
    run=str(uuid.UUID(sys.argv[2]));anchor=Path(sys.argv[3])
    if not anchor.is_absolute() or anchor.resolve()!=anchor or anchor.parent.name!=run:raise ValueError('Invalid validation anchor')
    if os.name=='posix':
        atomic_json(anchor,dict(runId=run,supervisorPid=parent,sessionId=os.getpid()))
        alive=lambda:os.getppid()==parent
        terminate=lambda:os.killpg(os.getpgrp(),signal.SIGKILL)
        close=lambda:None
    else:
        alive,terminate,close=windows_parent(parent)
    stopped=threading.Event()
    def watch():
        while not stopped.wait(.2):
            if not alive():
                # Include the watchdog itself and every child in this session.
                terminate()
                return
    watcher=threading.Thread(target=watch,daemon=True,name='validation-parent-watch')
    watcher.start()
    try:
        # No new session: Claude remains in the original verified process tree.
        child=subprocess.Popen(sys.argv[4:],stdin=subprocess.DEVNULL,close_fds=True)
        return child.wait()
    finally:
        stopped.set()
        watcher.join(timeout=1)
        if watcher.is_alive():terminate()
        close()

if __name__=='__main__':
    try:code=main()
    except (OSError,ValueError,subprocess.SubprocessError):code=2
    raise SystemExit(code)
