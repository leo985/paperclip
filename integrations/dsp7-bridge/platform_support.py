"""OS primitives shared by the native seat. No credentials in process arguments."""
from __future__ import annotations
import contextlib
import ctypes
import functools
import json
import os
from pathlib import Path
import re
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
    from ctypes import wintypes
    class _Overlapped(ctypes.Structure):
        _fields_=[('Internal',ctypes.c_size_t),('InternalHigh',ctypes.c_size_t),
                  ('Offset',wintypes.DWORD),('OffsetHigh',wintypes.DWORD),('hEvent',wintypes.HANDLE)]
    _kernel=ctypes.WinDLL('kernel32',use_last_error=True)
    _kernel.LockFileEx.argtypes=[wintypes.HANDLE,wintypes.DWORD,wintypes.DWORD,wintypes.DWORD,wintypes.DWORD,ctypes.POINTER(_Overlapped)]
    _kernel.LockFileEx.restype=wintypes.BOOL
    _kernel.UnlockFileEx.argtypes=[wintypes.HANDLE,wintypes.DWORD,wintypes.DWORD,wintypes.DWORD,ctypes.POINTER(_Overlapped)]
    _kernel.UnlockFileEx.restype=wintypes.BOOL
    class fcntl:
        LOCK_SH=1
        LOCK_EX=2
        LOCK_NB=4
        LOCK_UN=8
        @staticmethod
        def flock(file,flags):
            fd=file if isinstance(file,int) else file.fileno()
            handle=msvcrt.get_osfhandle(fd);offset=_Overlapped()
            if flags & fcntl.LOCK_UN:
                if not _kernel.UnlockFileEx(handle,0,1,0,ctypes.byref(offset)):raise ctypes.WinError(ctypes.get_last_error())
                return
            while True:
                # Immediate acquisition with explicit retry keeps shared locks
                # compatible with exclusive installer and existing byte locks.
                if _kernel.LockFileEx(handle,1|(2 if flags & fcntl.LOCK_EX else 0),0,1,0,ctypes.byref(offset)):return
                error=ctypes.get_last_error()
                if error not in (33,158):raise ctypes.WinError(error)
                if flags & fcntl.LOCK_NB:raise BlockingIOError('Seat lock is held')
                time.sleep(.1)


def powershell(script, *, env=None, timeout=30):
    script = "[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false);\n" + script
    return subprocess.run(['powershell.exe', '-NoProfile', '-NonInteractive', '-Command', script],
                          env=env, capture_output=True, encoding='utf-8', errors='replace',
                          stdin=subprocess.DEVNULL, check=True, timeout=timeout, creationflags=subprocess.CREATE_NO_WINDOW if WINDOWS else 0)


def private_directory(path):
    path = Path(path)
    path.mkdir(parents=True, exist_ok=True, mode=0o700)
    if path.is_symlink() or (WINDOWS and getattr(path.lstat(),'st_file_attributes',0) & 0x400):
        raise RuntimeError('Seat directory must not be a link or junction')
    if WINDOWS and str(path.resolve()) not in _PRIVATE_DIRECTORIES:
        # Replace the DACL, rather than chmod (which does not protect Windows
        # secrets). Only this user and SYSTEM can read inherited seat files.
        env = dict(os.environ, PAPERCLIP_ACL_PATH=str(path.resolve()))
        try:
            powershell("""$ErrorActionPreference='Stop';
$p=$env:PAPERCLIP_ACL_PATH;
$sid=[System.Security.Principal.WindowsIdentity]::GetCurrent().User;
$directory=[System.IO.DirectoryInfo]::new($p);
# Windows may assign an elevated creator's files to Administrators, or keep
# SYSTEM ownership on a managed profile. Neither is another personal seat.
$trustedOwners=@($sid.Value,'S-1-5-18','S-1-5-32-544');
$owner=$directory.GetAccessControl([System.Security.AccessControl.AccessControlSections]::Owner).GetOwner([System.Security.Principal.SecurityIdentifier]).Value;
if($owner -notin $trustedOwners){throw ('Seat directory has another owner: '+$owner)};
# Read and write only the access section. Set-Acl on a freshly constructed
# descriptor can attempt to write the SACL and require SeSecurityPrivilege.
$acl=$directory.GetAccessControl([System.Security.AccessControl.AccessControlSections]::Access);
$acl.SetAccessRuleProtection($true,$false);
foreach($rule in @($acl.GetAccessRules($true,$false,[System.Security.Principal.SecurityIdentifier]))){$acl.RemoveAccessRuleSpecific($rule)};
foreach($s in @($sid,[System.Security.Principal.SecurityIdentifier]::new('S-1-5-18'))){
$r=[System.Security.AccessControl.FileSystemAccessRule]::new($s,'FullControl','ContainerInherit,ObjectInherit','None','Allow');$acl.AddAccessRule($r)};
$directory.SetAccessControl($acl)""", env=env)
        except subprocess.CalledProcessError as error:
            # ACL commands contain no secrets, but do not echo arbitrary child
            # output or a full command line from the generic installer handler.
            detail = error.stderr or error.stdout or ''
            if 'Seat directory has another owner' in detail:
                owner = re.search(r'Seat directory has another owner:\s*(S-\d+(?:-\d+)+)', detail)
                label = '（SID：'+owner.group(1)+'）' if owner else ''
                raise RuntimeError('Windows 接入目录属于其他用户'+label+'：'+str(path.resolve())+'；请使用当前用户自己的目录') from None
            raise RuntimeError('Windows 接入目录访问权限设置失败（退出码 '+str(error.returncode)+'）；请联系管理员核对该目录的所有者及访问权限，不能通过跳过后台服务安装解决') from None
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
    try:
        result=powershell("""$ErrorActionPreference='Stop';
[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false);
$file=[System.IO.FileInfo]::new($env:PAPERCLIP_ACL_PATH);
$sections=[System.Security.AccessControl.AccessControlSections]::Access -bor [System.Security.AccessControl.AccessControlSections]::Owner;
$a=$file.GetAccessControl($sections);
$me=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value;
$allowed=@($me,'S-1-5-18','S-1-5-32-544');
# Request SID rules directly. NTAccount translation can block on an unreachable
# domain controller even though all permission data is already stored locally.
$rules=$a.GetAccessRules($true,$true,[System.Security.Principal.SecurityIdentifier]);
$bad=@($rules | Where-Object {$_.AccessControlType -eq 'Allow' -and $_.IdentityReference.Value -notin $allowed});
# Match the directory owner policy, while still rejecting any Allow entry
# outside the current user, SYSTEM and Administrators.
if($a.GetOwner([Security.Principal.SecurityIdentifier]).Value -in $allowed -and $bad.Count -eq 0){'private'}else{'shared'}""",env=env)
    except subprocess.TimeoutExpired:
        raise RuntimeError('Windows 席位凭据权限校验超时（30 秒）；配置及原席位保留，请检查 PowerShell 或终端安全软件，不要删除配置或重复创建席位') from None
    return result.stdout.strip()=='private'


def _windows_claude_package_entry(executable):
    """Resolve installed npm metadata without executing a shell shim."""
    shim = Path(executable)
    prefixes = [shim.parent, shim.resolve().parent]
    for name in ('NPM_CONFIG_PREFIX', 'npm_config_prefix', 'APPDATA'):
        value = os.environ.get(name)
        if value:
            prefixes.append(Path(value) / 'npm' if name == 'APPDATA' else Path(value))
    checked = []
    for prefix in dict.fromkeys(prefixes):
        package = prefix / 'node_modules/@anthropic-ai/claude-code'
        checked.append(package)
        metadata = package / 'package.json'
        target = 'cli.js'
        if metadata.is_file():
            try:
                data = json.loads(metadata.read_text(encoding='utf-8-sig'))
                binary = data.get('bin')
                target = binary.get('claude') if isinstance(binary, dict) else binary
            except (OSError, ValueError, AttributeError):
                raise RuntimeError('Claude npm 安装的 package.json 无效，请修复 Claude 安装') from None
            if data.get('name') != '@anthropic-ai/claude-code' or not isinstance(target, str) or not target:
                continue
        entry = (package / target).resolve()
        try:
            entry.relative_to(package.resolve())
        except ValueError:
            raise RuntimeError('Claude npm 入口超出安装包目录，请核对 Claude 安装') from None
        if entry.is_file() and entry.suffix.lower() in ('.js', '.cjs', '.mjs', '.exe'):
            return entry
    raise RuntimeError('找到了 Claude 启动脚本，但未找到有效的 Claude npm 程序入口；请执行 npm root -g 核对安装目录。检查位置：'+str(checked[0]))


def _windows_node(executable):
    """Include standard installs when Node is missing from a stale PATH."""
    candidates = [Path(executable).parent / 'node.exe', shutil.which('node.exe'), shutil.which('node')]
    for name in ('ProgramW6432', 'ProgramFiles', 'ProgramFiles(x86)'):
        if os.environ.get(name):
            candidates.append(Path(os.environ[name]) / 'nodejs/node.exe')
    for name in ('NVM_SYMLINK', 'FNM_MULTISHELL_PATH'):
        if os.environ.get(name):
            candidates.append(Path(os.environ[name]) / 'node.exe')
    if os.environ.get('LOCALAPPDATA'):
        candidates.append(Path(os.environ['LOCALAPPDATA']) / 'Programs/nodejs/node.exe')
    if os.environ.get('VOLTA_HOME'):
        candidates.append(Path(os.environ['VOLTA_HOME']) / 'bin/node.exe')
    for candidate in candidates:
        if candidate and Path(candidate).is_file():
            return str(Path(candidate))
    raise RuntimeError('Claude npm 程序已找到，但找不到 Node.js；请确认 node --version 可运行，安装或修复 Node.js 后重新打开 PowerShell。也可登记原生 claude.exe')


def claude_argv(executable, args=()):
    """Resolve npm JS or native entries; keep prompts out of cmd.exe."""
    executable=str(executable)
    if WINDOWS and Path(executable).suffix.lower() in ('.cmd','.bat','.ps1'):
        entry = _windows_claude_package_entry(executable)
        if entry.suffix.lower() == '.exe':
            return [str(entry), *args]
        return [_windows_node(executable), str(entry), *args]
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
        output=powershell("[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false); @((Get-CimInstance Win32_Process) | Select-Object ProcessId,ParentProcessId,CommandLine,CreationDate,ExecutablePath) | ConvertTo-Json -Compress",timeout=20).stdout
        data=json.loads(output or '[]');data=[data] if isinstance(data,dict) else data
        return {int(p['ProcessId']):{'parent':int(p['ParentProcessId']),'command':p.get('CommandLine') or '', 'created':p.get('CreationDate'),'image':p.get('ExecutablePath')} for p in data}
    output=subprocess.run(['/bin/ps','-axo','pid=,ppid=,command='],capture_output=True,text=True,check=True).stdout
    rows={}
    for line in output.splitlines():
        p=line.strip().split(None,2)
        if len(p)==3:rows[int(p[0])]={'parent':int(p[1]),'command':p[2]}
    return rows


def matches_claude(command, executable, image=None):
    if not WINDOWS:return False
    argv=windows_argv(command);expected=claude_argv(executable)
    normalize=lambda p:os.path.normcase(os.path.abspath(p))
    if image and normalize(image)!=normalize(expected[0]):return False
    # Pywinpty launches with an explicit application path and a command line
    # beginning with a space. CommandLineToArgvW then returns an empty argv[0].
    # Accept that form only with the independently observed process image.
    if argv and argv[0]=='':
        if not image:return False
        argv=[image,*argv[1:]]
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
