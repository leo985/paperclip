"""Install the current user's outbound watcher; never a system service."""
import os
from pathlib import Path
import shlex
import subprocess
import sys

def install_windows_service(root, executable=None, run_powershell=None):
    """Start an existing matching task without requiring permission to rewrite it."""
    import json
    from platform_support import powershell
    from seat_profiles import service_suffix,windows_watch_arguments
    run_powershell=run_powershell or powershell
    python=Path(executable or sys.executable).with_name('pythonw.exe')
    if not python.is_file():raise RuntimeError('Python 安装缺少 pythonw.exe；请修复 Python 安装')
    env=dict(os.environ,PAPERCLIP_WATCH_PYTHON=str(python),PAPERCLIP_WATCH_SCRIPT=str(root/'watch_windows.py'),PAPERCLIP_WATCH_ROOT=str(root),PAPERCLIP_TASK_SUFFIX=service_suffix(),PAPERCLIP_WATCH_ARGUMENTS=windows_watch_arguments(root))
    lookup="""$ErrorActionPreference='Stop';
$user=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value;
$name='Zhiyan-Seat-Bridge-'+$user+$env:PAPERCLIP_TASK_SUFFIX;
$argument=$env:PAPERCLIP_WATCH_ARGUMENTS;
$existing=Get-ScheduledTask -TaskName $name -ErrorAction SilentlyContinue;
function Is-CurrentUser($value){if($value -eq $user){return $true};try{return ([Security.Principal.NTAccount]::new([string]$value)).Translate([Security.Principal.SecurityIdentifier]).Value -eq $user}catch{return $false}};
$matches=$false;
if($existing){
$logon=@($existing.Triggers | Where-Object {$_.CimClass.CimClassName -eq 'MSFT_TaskLogonTrigger' -and $_.Enabled -ne $false -and (Is-CurrentUser $_.UserId)}).Count -gt 0;
$matches=@($existing.Actions).Count -eq 1 -and $existing.Actions.Execute -eq $env:PAPERCLIP_WATCH_PYTHON -and $existing.Actions.Arguments -eq $argument -and $existing.Actions.WorkingDirectory -eq $env:PAPERCLIP_WATCH_ROOT -and (Is-CurrentUser $existing.Principal.UserId) -and $logon;
};
"""
    result=run_powershell(lookup+"@{exists=[bool]$existing;matches=[bool]$matches;enabled=[bool]($existing -and $existing.Settings.Enabled);running=[bool]($existing -and $existing.State -eq 'Running')}|ConvertTo-Json -Compress",env=env)
    state=json.loads(result.stdout)
    if state['exists']:
        if not state['matches']:raise RuntimeError('Windows 登录任务与本席位路径、用户或登录触发器不一致；未覆盖，请核对原任务或更新客户端')
        if not state['enabled']:raise RuntimeError('Windows 登录任务已被禁用；请任务所有者启用后再执行 harness online')
        if not state['running']:
            # Recheck before starting in case another process changed the task.
            run_powershell(lookup+"if(-not $existing -or -not $matches -or -not $existing.Settings.Enabled){throw 'Seat task changed; refusing to start'};Start-ScheduledTask -TaskName $name",env=env)
    else:
        # No -Force: a task created concurrently must never be overwritten.
        run_powershell(lookup+"if($existing){throw 'Seat task appeared; retry online without overwriting'};\n"+WINDOWS_TASK_CREATION,env=env)
    print('已确认本用户登录启动任务并启动接入服务；已有任务不会重复注册。')


WINDOWS_TASK_CREATION = '$action=New-ScheduledTaskAction -Execute $env:PAPERCLIP_WATCH_PYTHON -Argument $argument -WorkingDirectory $env:PAPERCLIP_WATCH_ROOT;\n$trigger=New-ScheduledTaskTrigger -AtLogOn -User $user;\n$principal=New-ScheduledTaskPrincipal -UserId $user -LogonType Interactive -RunLevel Limited;\n$settings=New-ScheduledTaskSettingsSet -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries;\nRegister-ScheduledTask -TaskName $name -Action $action -Trigger $trigger -Principal $principal -Settings $settings | Out-Null;\nStart-ScheduledTask -TaskName $name'


def service_error_message(error):
    detail=str(getattr(error,'stderr','') or '')
    if any(word in detail.lower() for word in ('0x80070005','access is denied','permissiondenied','拒绝访问')):
        return 'Windows 计划任务访问被拒绝（0x80070005）。已有任务不会强制重注册；请任务所有者核对该任务的启动权限。'
    if isinstance(error,RuntimeError):return str(error)
    return 'Windows 后台服务操作失败，请核对计划任务状态和本机 watcher.log。'


def main():
    root=Path(__file__).resolve().parent
    if sys.platform=='darwin':
        subprocess.run([sys.executable,str(root/'install_launchagent.py')],check=True)
    elif sys.platform=='win32':
        install_windows_service(root)
    elif sys.platform=='linux':
        from seat_profiles import config_path,service_suffix
        runtime=config_path().parent
        if not (runtime/'config.json').is_file():raise SystemExit('本机席位配置不存在')
        directory=Path.home()/'.config/systemd/user';directory.mkdir(parents=True,exist_ok=True)
        unit=directory/('paperclip-dsp7-bridge'+service_suffix()+'.service')
        if unit.exists():
            if str(root/'pilot.py') in unit.read_text(encoding='utf-8'):
                subprocess.run(['systemctl','--user','enable','--now',unit.name],check=True)
            else:raise SystemExit('服务已存在且指向其他版本，请管理员核对后切换')
        # systemd quoting is not shell quoting. Escape only ExecStart tokens.
        def quote(value):return '"'+str(value).replace('\\','\\\\').replace('"','\\"').replace('%','%%')+'"'
        if not unit.exists():
            unit.write_text('[Unit]\nDescription=Paperclip personal seat bridge\nAfter=network-online.target\n\n[Service]\nType=simple\nEnvironment='+quote('DSP7_BRIDGE_CONFIG='+str(config_path()))+'\nExecStart='+quote(sys.executable)+' '+quote(root/'pilot.py')+' watch\nRestart=on-failure\nRestartSec=20\n\n[Install]\nWantedBy=default.target\n');unit.chmod(0o600)
            subprocess.run(['systemctl','--user','daemon-reload'],check=True);subprocess.run(['systemctl','--user','enable','--now',unit.name],check=True)
        print('本用户后台接入服务已安装。')
    else:raise SystemExit('当前后台安装支持 macOS／Linux')

    from service_status import verify_installation
    verify_installation(root)
    if os.environ.get('PAPERCLIP_SEAT_WATCHDOG_RECOVERY') != '1':
        from install_watchdog import install
        install(root)

if __name__=='__main__':
    try:main()
    except (subprocess.CalledProcessError,RuntimeError) as error:
        # Machine-readable parent diagnostic, without command lines or credentials.
        import json
        print('PAPERCLIP_SERVICE_ERROR: '+json.dumps({'message':service_error_message(error)},ensure_ascii=False),file=sys.stderr)
        raise SystemExit(1)
