"""OS primitives shared by the native seat. No credentials in process arguments."""
from __future__ import annotations
import contextlib
import ctypes
import functools
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import time

WINDOWS = sys.platform == 'win32'
_PRIVATE_DIRECTORIES=set()
if WINDOWS:os.environ['PYTHONUTF8']='1'

if not WINDOWS:
    import fcntl
else:
    import msvcrt
    class fcntl:
        LOCK_EX = 2
        LOCK_NB = 4
        LOCK_UN = 8
        @staticmethod
        def flock(file, flags):
            fd = file if isinstance(file, int) else file.fileno()
            # locking() locks from the current position; use the same byte in
            # every process. Windows releases the byte-range lock on close.
            if os.fstat(fd).st_size == 0:
                os.write(fd, b'\0')
            os.lseek(fd, 0, os.SEEK_SET)
            if flags & fcntl.LOCK_UN:
                msvcrt.locking(fd, msvcrt.LK_UNLCK, 1)
                return
            while True:
                try:
                    msvcrt.locking(fd, msvcrt.LK_NBLCK, 1)
                    return
                except OSError as error:
                    if error.errno not in (13, 36): raise
                    if flags & fcntl.LOCK_NB: raise BlockingIOError('Seat lock is held') from None
                    time.sleep(.1)


def powershell(script, *, env=None, timeout=30):
    return subprocess.run(['powershell.exe', '-NoProfile', '-NonInteractive', '-Command', script],
                          env=env, capture_output=True, encoding='utf-8', errors='replace',
                          check=True, timeout=timeout, creationflags=subprocess.CREATE_NO_WINDOW if WINDOWS else 0)


def private_directory(path):
    path = Path(path)
    path.mkdir(parents=True, exist_ok=True, mode=0o700)
    if path.is_symlink() or (WINDOWS and getattr(path.lstat(),'st_file_attributes',0) & 0x400):
        raise RuntimeError('Seat directory must not be a link or junction')
    if WINDOWS and str(path.resolve()) not in _PRIVATE_DIRECTORIES:
        # Replace the DACL, rather than chmod (which does not protect Windows
        # secrets). Only this user and SYSTEM can read inherited seat files.
        env = dict(os.environ, PAPERCLIP_ACL_PATH=str(path.resolve()))
        powershell("""$ErrorActionPreference='Stop';
$p=$env:PAPERCLIP_ACL_PATH;
$sid=[System.Security.Principal.WindowsIdentity]::GetCurrent().User;
$acl=New-Object System.Security.AccessControl.DirectorySecurity;
$acl.SetOwner($sid);$acl.SetAccessRuleProtection($true,$false);
foreach($s in @($sid,[System.Security.Principal.SecurityIdentifier]::new('S-1-5-18'))){
$r=[System.Security.AccessControl.FileSystemAccessRule]::new($s,'FullControl','ContainerInherit,ObjectInherit','None','Allow');$acl.AddAccessRule($r)};
Set-Acl -LiteralPath $p -AclObject $acl""", env=env)
        _PRIVATE_DIRECTORIES.add(str(path.resolve()))
    elif not WINDOWS:
        if path.stat().st_uid != os.getuid(): raise RuntimeError('Seat directory has another owner')
        path.chmod(0o700)
    return path


def credential_private(path):
    path=Path(path)
    if not path.is_file() or path.is_symlink():return False
    if not WINDOWS:return not bool(path.stat().st_mode & 0o077)
    env=dict(os.environ, PAPERCLIP_ACL_PATH=str(path.resolve()))
    result=powershell("""$ErrorActionPreference='Stop';
[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false);
$a=Get-Acl -LiteralPath $env:PAPERCLIP_ACL_PATH;
$me=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value;
$allowed=@($me,'S-1-5-18','S-1-5-32-544');
$bad=@($a.Access | Where-Object {$_.AccessControlType -eq 'Allow' -and $_.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value -notin $allowed});
if($a.GetOwner([Security.Principal.SecurityIdentifier]).Value -eq $me -and $bad.Count -eq 0){'private'}else{'shared'}""",env=env)
    return result.stdout.strip()=='private'


def claude_argv(executable, args=()):
    """Run npm's JS entry via node instead of sending prompts through cmd.exe."""
    executable=str(executable)
    if WINDOWS and Path(executable).suffix.lower() in ('.cmd','.bat','.ps1'):
        script=Path(executable).parent/'node_modules/@anthropic-ai/claude-code/cli.js'
        node=Path(executable).parent/'node.exe'
        node=str(node) if node.is_file() else shutil.which('node')
        if not script.is_file() or not node:
            raise RuntimeError('Use native claude.exe or the official npm Claude installation with Node.js')
        return [node,str(script),*args]
    return [executable,*args]


def windows_git_bash():
    candidates=[os.environ.get('CLAUDE_CODE_GIT_BASH_PATH')]
    for variable in ('ProgramFiles','ProgramFiles(x86)','LOCALAPPDATA'):
        base=os.environ.get(variable)
        if base:candidates.extend([str(Path(base)/'Git/bin/bash.exe'),str(Path(base)/'Programs/Git/bin/bash.exe')])
    git=shutil.which('git')
    if git:candidates.extend([str(Path(git).parent.parent/'bin/bash.exe'),str(Path(git).parent/'bash.exe')])
    for path in candidates:
        if path and Path(path).is_file():return str(Path(path).resolve())
    raise RuntimeError('Install Git for Windows (including Git Bash), or configure CLAUDE_CODE_GIT_BASH_PATH')


def windows_argv(command):
    count=ctypes.c_int()
    fn=ctypes.windll.shell32.CommandLineToArgvW
    fn.argtypes=[ctypes.c_wchar_p,ctypes.POINTER(ctypes.c_int)]
    fn.restype=ctypes.POINTER(ctypes.c_wchar_p)
    values=fn(command,ctypes.byref(count))
    if not values:return []
    try:return [values[i] for i in range(count.value)]
    finally:
        free=ctypes.windll.kernel32.LocalFree;free.argtypes=[ctypes.c_void_p];free(ctypes.cast(values,ctypes.c_void_p))


def process_table():
    if WINDOWS:
        output=powershell("[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false); @((Get-CimInstance Win32_Process) | Select-Object ProcessId,ParentProcessId,CommandLine,CreationDate) | ConvertTo-Json -Compress",timeout=20).stdout
        data=json.loads(output or '[]');data=[data] if isinstance(data,dict) else data
        return {int(p['ProcessId']):{'parent':int(p['ParentProcessId']),'command':p.get('CommandLine') or '', 'created':p.get('CreationDate')} for p in data}
    output=subprocess.run(['/bin/ps','-axo','pid=,ppid=,command='],capture_output=True,text=True,check=True).stdout
    rows={}
    for line in output.splitlines():
        p=line.strip().split(None,2)
        if len(p)==3:rows[int(p[0])]={'parent':int(p[1]),'command':p[2]}
    return rows


def matches_claude(command, executable):
    if not WINDOWS:return False
    argv=windows_argv(command);expected=claude_argv(executable)
    return len(argv)>=len(expected) and all(os.path.normcase(os.path.abspath(a))==os.path.normcase(os.path.abspath(b)) for a,b in zip(argv,expected))


def terminate_tree(child):
    if child is None or child.poll() is not None:return
    if WINDOWS:
        # Only use the live Popen identity, never an unverified remembered PID.
        subprocess.run(['taskkill.exe','/PID',str(child.pid),'/T','/F'],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,timeout=15)
    else:
        import signal
        with contextlib.suppress(ProcessLookupError):os.killpg(child.pid,signal.SIGTERM)
    try:child.wait(timeout=8)
    except subprocess.TimeoutExpired:
        if WINDOWS:child.kill()
        else:
            import signal
            with contextlib.suppress(ProcessLookupError):os.killpg(child.pid,signal.SIGKILL)
        child.wait(timeout=5)


class PipeReader:
    """Threaded pipe pump: Windows select() cannot wait on subprocess pipes."""
    def __init__(self, child):
        import queue,threading
        self.queue=queue.Queue(maxsize=128);self.open=2
        def read(stream,name):
            try:
                while True:
                    chunk=os.read(stream.fileno(),32768)
                    if not chunk:break
                    self.queue.put((name,chunk))
            finally:self.queue.put((name,None))
        for name in ('stdout','stderr'):threading.Thread(target=read,args=(getattr(child,name),name),daemon=True).start()
    def read(self,timeout=.5):
        import queue
        try:name,chunk=self.queue.get(timeout=timeout)
        except queue.Empty:return []
        if chunk is None:self.open-=1;return []
        return [(name,chunk)]


def process_alive(pid):
    if not WINDOWS:
        try:os.kill(pid,0);return True
        except ProcessLookupError:return False
    kernel=ctypes.WinDLL('kernel32',use_last_error=True)
    kernel.OpenProcess.argtypes=[ctypes.c_uint32,ctypes.c_int,ctypes.c_uint32];kernel.OpenProcess.restype=ctypes.c_void_p
    kernel.WaitForSingleObject.argtypes=[ctypes.c_void_p,ctypes.c_uint32]
    kernel.CloseHandle.argtypes=[ctypes.c_void_p]
    handle=kernel.OpenProcess(0x00100000,False,pid)
    if not handle:return False
    try:return kernel.WaitForSingleObject(handle,0)==258
    finally:kernel.CloseHandle(handle)


_JOB_HANDLES=[]
def own_process_job():
    """Kill this executor's descendants if its last Job Object handle closes."""
    if not WINDOWS:return
    from ctypes import wintypes
    class BASIC(ctypes.Structure):
        _fields_=[('ProcessTime',ctypes.c_int64),('JobTime',ctypes.c_int64),('Flags',wintypes.DWORD),('MinSet',ctypes.c_size_t),('MaxSet',ctypes.c_size_t),('ActiveLimit',wintypes.DWORD),('Affinity',ctypes.c_size_t),('Priority',wintypes.DWORD),('Scheduling',wintypes.DWORD)]
    class IO(ctypes.Structure):
        _fields_=[(name,ctypes.c_uint64) for name in ('ReadOps','WriteOps','OtherOps','ReadBytes','WriteBytes','OtherBytes')]
    class EXTENDED(ctypes.Structure):
        _fields_=[('Basic',BASIC),('Io',IO),('ProcessMemory',ctypes.c_size_t),('JobMemory',ctypes.c_size_t),('PeakProcess',ctypes.c_size_t),('PeakJob',ctypes.c_size_t)]
    k=ctypes.WinDLL('kernel32',use_last_error=True)
    k.CreateJobObjectW.argtypes=[ctypes.c_void_p,ctypes.c_wchar_p];k.CreateJobObjectW.restype=ctypes.c_void_p
    k.SetInformationJobObject.argtypes=[ctypes.c_void_p,ctypes.c_int,ctypes.c_void_p,wintypes.DWORD]
    k.AssignProcessToJobObject.argtypes=[ctypes.c_void_p,ctypes.c_void_p]
    k.GetCurrentProcess.restype=ctypes.c_void_p;k.CloseHandle.argtypes=[ctypes.c_void_p]
    job=k.CreateJobObjectW(None,None)
    info=EXTENDED();info.Basic.Flags=0x00002000
    if not job or not k.SetInformationJobObject(job,9,ctypes.byref(info),ctypes.sizeof(info)) or not k.AssignProcessToJobObject(job,k.GetCurrentProcess()):
        if job:k.CloseHandle(job)
        raise OSError('Cannot establish a Windows execution Job Object; no model was started')
    _JOB_HANDLES.append(job)
