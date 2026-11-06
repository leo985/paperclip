"""Actionable macOS notifications; clicking never starts or approves a run."""
from __future__ import annotations
import hashlib
import json
import os
from pathlib import Path
import re
import shlex
import shutil
import subprocess
import sys
import uuid


def notifier():
    candidates=[shutil.which('terminal-notifier'),str(Path.home()/'.local/share/paperclip/notifications/terminal-notifier.app/Contents/MacOS/terminal-notifier'),'/opt/homebrew/bin/terminal-notifier','/usr/local/bin/terminal-notifier']
    return next((p for p in candidates if p and os.path.isfile(p) and os.access(p,os.X_OK)),None)


def install_notifier():
    if notifier():return
    import platform,tarfile,tempfile,urllib.request
    if platform.machine()!='arm64' or int(platform.mac_ver()[0].split('.')[0])<14:
        raise RuntimeError('请安装 terminal-notifier 以启用通知点击定位')
    # Official Homebrew Sonoma bottle, compatible with arm64 macOS 14+.
    digest='70f5c03ad1d542ae13cbbb9d7fa589c56601c2eb121f25cc726ba4a3f8442bc5'
    token=json.load(urllib.request.urlopen('https://ghcr.io/token?service=ghcr.io&scope=repository:homebrew/core/terminal-notifier:pull',timeout=15))['token']
    request=urllib.request.Request('https://ghcr.io/v2/homebrew/core/terminal-notifier/blobs/sha256:'+digest,headers={'Authorization':'Bearer '+token})
    with urllib.request.urlopen(request,timeout=30) as response:payload=response.read(5*1024*1024+1)
    if hashlib.sha256(payload).hexdigest()!=digest:raise RuntimeError('通知工具摘要不匹配')
    parent=Path.home()/'.local/share/paperclip/notifications';parent.mkdir(parents=True,exist_ok=True,mode=0o700)
    with tempfile.TemporaryDirectory(dir=parent) as temp:
        import io
        root=Path(temp)
        with tarfile.open(fileobj=io.BytesIO(payload),mode='r:gz') as archive:
            members=[m for m in archive.getmembers() if '/terminal-notifier.app/' in m.name]
            for m in members:
                if m.name.startswith('/') or '..' in Path(m.name).parts or not (m.isfile() or m.isdir()):raise RuntimeError('通知工具归档路径无效')
            archive.extractall(root,members=members)
        app=root/'terminal-notifier/3.1.0/terminal-notifier.app'
        subprocess.run(['/usr/bin/codesign','--verify','--strict',str(app)],check=True,capture_output=True,timeout=10)
        os.replace(app,parent/'terminal-notifier.app')


def notify(title,message,*,config=None,task_id=None,run_id=None):
    binary=notifier()
    if not binary:
        # System Events is a background application. Never attribute alerts to
        # Script Editor, whose default click opens its file chooser.
        script='on run argv\ntell application "System Events" to display notification (item 2 of argv) with title (item 1 of argv) sound name "Glass"\nend run'
        result=subprocess.run(['/usr/bin/osascript','-e',script,title,message],capture_output=True,timeout=15)
        return 'submitted_without_click_action' if result.returncode==0 else 'failed'
    command=[binary,'-title',title,'-message',message,'-sound','default']
    if config:
        action=[sys.executable,str(Path(__file__).resolve()),'--config',str(config)]
        if task_id:action+=['--task',str(uuid.UUID(task_id))]
        if run_id:action+=['--run',str(uuid.UUID(run_id))]
        command+=['-execute',shlex.join(action)]
    else:command+=['-activate','com.apple.Terminal']
    # No -action/-reply: delivery returns immediately, click is handled by the app.
    result=subprocess.run(command,capture_output=True,timeout=15)
    return 'submitted' if result.returncode==0 else 'failed'


def viewer_path(run_id):
    return Path('/tmp')/('dsp7-ui-'+str(os.getuid()))/(str(uuid.UUID(run_id))+'.viewer.json')


def register_viewer(run_id):
    from pilot import atomic_json
    marker=viewer_path(run_id)
    stamp=subprocess.check_output(['/bin/ps','-p',str(os.getpid()),'-o','lstart='],text=True,timeout=5).strip()
    atomic_json(marker,{'pid':os.getpid(),'tty':os.ttyname(sys.stdin.fileno()),'started':stamp})
    return marker


def viewer_ttys(run_id):
    try:
        marker=json.loads(viewer_path(run_id).read_text());pid=marker['pid'];tty=marker['tty']
        if type(pid) is not int or pid<=0 or not re.fullmatch(r'/dev/ttys\d+',tty):return []
        stamp=subprocess.check_output(['/bin/ps','-p',str(pid),'-o','lstart='],text=True,timeout=5).strip()
        actual=subprocess.check_output(['/bin/ps','-p',str(pid),'-o','tty='],text=True,timeout=5).strip()
        return [tty] if stamp==marker['started'] and '/dev/'+actual==tty else []
    except (OSError,ValueError,KeyError,subprocess.SubprocessError):return []


def terminal_ttys(run_id):
    result=subprocess.run(['/bin/ps','-axo','tty=,command='],capture_output=True,text=True,timeout=5)
    found=[]
    for line in result.stdout.splitlines():
        parts=line.strip().split(None,1)
        if len(parts)!=2:continue
        tty,command=parts
        try:args=shlex.split(command)
        except ValueError:continue
        # Match this exact attach client, never a prompt containing a run UUID.
        if len(args)==4 and re.fullmatch(r'python(?:\d+(?:\.\d+)*)?',Path(args[0]).name.lower()) and Path(args[1]).name=='interactive.py' and args[2:]==['attach',run_id] and re.fullmatch(r'ttys\d+',tty):
            found.append('/dev/'+tty)
    return found


def focus_terminal(tty):
    script='''on run argv
set targetTTY to item 1 of argv
tell application "Terminal"
repeat with w in windows
repeat with t in tabs of w
if tty of t is targetTTY then
set selected tab of w to t
set miniaturized of w to false
set index of w to 1
activate
return "focused"
end if
end repeat
end repeat
end tell
return "missing"
end run'''
    result=subprocess.run(['/usr/bin/osascript','-e',script,tty],capture_output=True,text=True,timeout=10)
    return result.returncode==0 and result.stdout.strip()=='focused'


def open_target(config,task_id=None,run_id=None):
    cfg=json.loads(Path(config).read_text())
    if task_id:task_id=str(uuid.UUID(task_id))
    if run_id:run_id=str(uuid.UUID(run_id))
    if task_id and run_id:
        folder=Path(cfg['database']).parent/'interactive/runs'/run_id
        try:info=json.loads((folder/'session.json').read_text())
        except (OSError,ValueError):info={}
        if info.get('run_id')==run_id and info.get('task_id')==task_id and info.get('status')=='running' and not (folder/'summary.json').exists():
            for tty in dict.fromkeys(viewer_ttys(run_id)+terminal_ttys(run_id)):
                if focus_terminal(tty):return 'terminal'
    from urllib.parse import urlsplit
    base=cfg['paperclip_url'].rstrip('/');url=urlsplit(base)
    if url.scheme not in ('http','https') or not url.hostname or url.username or url.password:raise ValueError('Invalid server URL')
    target=base+('/DSP/issues/'+task_id if task_id else '/DSP/seats')
    subprocess.run(['/usr/bin/open',target],check=True,timeout=10)
    return 'web'


if __name__=='__main__':
    import argparse
    p=argparse.ArgumentParser();p.add_argument('--install',action='store_true');p.add_argument('--config');p.add_argument('--task');p.add_argument('--run');a=p.parse_args()
    try:
        if a.install:install_notifier()
        elif a.config:open_target(a.config,a.task,a.run)
        else:p.error('--config is required')
    except (OSError,ValueError,RuntimeError,subprocess.SubprocessError):sys.exit(1)
