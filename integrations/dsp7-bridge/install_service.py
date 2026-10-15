"""Install the current user's outbound watcher; never a system service."""
import os
from pathlib import Path
import shlex
import subprocess
import sys
root=Path(__file__).resolve().parent
if sys.platform=='darwin':
    subprocess.run([sys.executable,str(root/'install_launchagent.py')],check=True)
elif sys.platform=='win32':
    from platform_support import powershell
    python=Path(sys.executable).with_name('pythonw.exe')
    if not python.is_file():raise SystemExit('Python 安装缺少 pythonw.exe；请修复 Python，或用 --no-service 手动运行接入桥')
    env=dict(os.environ,PAPERCLIP_WATCH_PYTHON=str(python),PAPERCLIP_WATCH_SCRIPT=str(root/'watch_windows.py'),PAPERCLIP_WATCH_ROOT=str(root))
    powershell('''$ErrorActionPreference='Stop';
$user=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value;
$name='Zhiyan-Seat-Bridge-'+$user;
$argument='"'+$env:PAPERCLIP_WATCH_SCRIPT+'"';
$existing=Get-ScheduledTask -TaskName $name -ErrorAction SilentlyContinue;
if($existing -and ($existing.Actions.Execute -ne $env:PAPERCLIP_WATCH_PYTHON -or $existing.Actions.Arguments -ne $argument)){throw 'Existing seat task points to another version; stop and review it before switching'};
if(-not $existing){
$action=New-ScheduledTaskAction -Execute $env:PAPERCLIP_WATCH_PYTHON -Argument $argument -WorkingDirectory $env:PAPERCLIP_WATCH_ROOT;
$trigger=New-ScheduledTaskTrigger -AtLogOn -User $user;
$principal=New-ScheduledTaskPrincipal -UserId $user -LogonType Interactive -RunLevel Limited;
$settings=New-ScheduledTaskSettingsSet -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries;
Register-ScheduledTask -TaskName $name -Action $action -Trigger $trigger -Principal $principal -Settings $settings | Out-Null};
Start-ScheduledTask -TaskName $name''',env=env)
    print('已安装当前用户登录后启动的 Windows 席位任务；无需管理员密码。退出 Windows 登录或电脑休眠时席位离线。')
elif sys.platform=='linux':
    runtime=Path.home()/'.config/paperclip-dsp7-bridge'
    if not (runtime/'config.json').is_file():raise SystemExit('本机席位配置不存在')
    directory=Path.home()/'.config/systemd/user';directory.mkdir(parents=True,exist_ok=True)
    unit=directory/'paperclip-dsp7-bridge.service'
    if unit.exists():
        if str(root/'pilot.py') in unit.read_text(encoding='utf-8'):
            subprocess.run(['systemctl','--user','enable','--now',unit.name],check=True)
            raise SystemExit(0)
        raise SystemExit('服务已存在且指向其他版本，请管理员核对后切换')
    # systemd quoting is not shell quoting. Escape only ExecStart tokens.
    def quote(value):return '"'+str(value).replace('\\','\\\\').replace('"','\\"').replace('%','%%')+'"'
    unit.write_text('[Unit]\nDescription=Paperclip personal seat bridge\nAfter=network-online.target\n\n[Service]\nType=simple\nExecStart='+quote(sys.executable)+' '+quote(root/'pilot.py')+' watch\nRestart=on-failure\nRestartSec=20\n\n[Install]\nWantedBy=default.target\n');unit.chmod(0o600)
    subprocess.run(['systemctl','--user','daemon-reload'],check=True);subprocess.run(['systemctl','--user','enable','--now',unit.name],check=True)
    print('本用户后台接入服务已安装。')
else:raise SystemExit('当前后台安装支持 macOS／Linux')
