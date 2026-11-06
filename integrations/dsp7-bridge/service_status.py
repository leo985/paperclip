"""Read-only checks of this user's login service; never starts an executor."""
from pathlib import Path
import json
import os
import plistlib
import re
import subprocess
import sys
import time


def windows_task_message(data, paused=False):
    """Explain registration separately from task health without exposing credentials."""
    prefix='Windows 登录启动任务：'+data['taskName']+'；'
    if not data['registered']:
        return prefix+'未注册。请在安装席位的 Windows 用户下执行 harness service install 补装登录启动服务，或执行 harness online 注册并启动。'
    if not data['matches']:
        return prefix+'已注册，但运行用户、登录触发器或启动路径与当前席位不一致。请执行 harness upgrade 更新客户端并核对任务；不会自动覆盖其他任务。'
    if not data['taskEnabled']:
        return prefix+'已注册，但已禁用。请在任务计划程序中启用该任务，再执行 harness online。'
    if paused:
        return prefix+'已注册、已启用；当前已手动下线，执行 harness online 恢复。'
    if not data['running']:
        result=data.get('lastResult')
        detail=('；上次运行结果 0x'+format(int(result) & 0xffffffff,'08X')) if result is not None else ''
        return prefix+'已注册、已启用，但当前未运行'+detail+'。执行 harness online；若仍异常，检查本机 watcher.log。'
    return prefix+'已注册、已启用、正在运行。此任务在当前用户登录后自动上线；未登录、退出登录、休眠或断网时可能离线。'


def status(root=None):
    root=Path(root or __file__).resolve()
    if root.is_file():root=root.parent
    from seat_profiles import config_path,service_label,service_suffix
    runtime=config_path().parent
    paused=(runtime/'seat-offline.json').is_file()
    def run(args):return subprocess.run(args,capture_output=True,text=True,timeout=10)
    try:
        if sys.platform=='darwin':
            label=service_label();domain='gui/'+str(os.getuid())
            file=Path.home()/'Library/LaunchAgents'/(label+'.plist')
            value=plistlib.loads(file.read_bytes()) if file.is_file() else {}
            disabled=run(['launchctl','print-disabled',domain])
            if disabled.returncode:raise RuntimeError('launchctl unavailable')
            overridden=bool(re.search(r'"'+re.escape(label)+r'"\s*=>\s*true',disabled.stdout))
            enabled=value.get('RunAtLoad') is True and str(root/'pilot.py') in value.get('ProgramArguments',[]) and not overridden
            loaded=run(['launchctl','print',domain+'/'+label])
            running=loaded.returncode==0 and bool(re.search(r'\bstate = running\b',loaded.stdout))
        elif sys.platform=='linux':
            file=Path.home()/('.config/systemd/user/paperclip-dsp7-bridge'+service_suffix()+'.service')
            matches=file.is_file() and str(root/'pilot.py') in file.read_text(encoding='utf-8')
            enabled=matches and run(['systemctl','--user','is-enabled','--quiet',file.name]).returncode==0
            running=matches and run(['systemctl','--user','is-active','--quiet',file.name]).returncode==0
        elif sys.platform=='win32':
            from platform_support import powershell
            from seat_profiles import windows_watch_arguments
            env=dict(os.environ,PAPERCLIP_STATUS_SCRIPT=str(root/'watch_windows.py'),PAPERCLIP_STATUS_PYTHON=str(Path(sys.executable).with_name('pythonw.exe')),PAPERCLIP_TASK_SUFFIX=service_suffix(),PAPERCLIP_STATUS_ARGUMENTS=windows_watch_arguments(root),PAPERCLIP_STATUS_ROOT=str(root))
            result=powershell('''[Console]::OutputEncoding=[Text.UTF8Encoding]::new();$ErrorActionPreference='Stop';
$sid=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value;
function Is-CurrentUser($value){if($value -eq $sid){return $true};try{return ([Security.Principal.NTAccount]::new([string]$value)).Translate([Security.Principal.SecurityIdentifier]).Value -eq $sid}catch{return $false}};
$name='Zhiyan-Seat-Bridge-'+$sid+$env:PAPERCLIP_TASK_SUFFIX;
$t=$null;try{$t=Get-ScheduledTask -TaskName $name -ErrorAction Stop}catch{if($_.FullyQualifiedErrorId -notlike 'CmdletizationQuery_NotFound*'){throw}};
$ok=$false;$running=$false;$matches=$false;$taskEnabled=$false;$lastResult=$null;
if($t){$logon=@($t.Triggers | Where-Object {$_.CimClass.CimClassName -eq 'MSFT_TaskLogonTrigger' -and $_.Enabled -ne $false -and (Is-CurrentUser $_.UserId)}).Count -gt 0;
$matches=$logon -and (Is-CurrentUser $t.Principal.UserId) -and @($t.Actions).Count -eq 1 -and $t.Actions.Execute -eq $env:PAPERCLIP_STATUS_PYTHON -and $t.Actions.Arguments -eq $env:PAPERCLIP_STATUS_ARGUMENTS -and $t.Actions.WorkingDirectory -eq $env:PAPERCLIP_STATUS_ROOT;
$taskEnabled=[bool]$t.Settings.Enabled;$ok=$taskEnabled -and $matches;$running=$ok -and $t.State -eq 'Running';$lastResult=($t|Get-ScheduledTaskInfo -ErrorAction Stop).LastTaskResult};
@{taskName=$name;registered=[bool]$t;matches=[bool]$matches;taskEnabled=[bool]$taskEnabled;enabled=[bool]$ok;running=[bool]$running;lastResult=$lastResult}|ConvertTo-Json -Compress''',env=env,timeout=10)
            data=json.loads(result.stdout);enabled=data['enabled'];running=data['running']
            return {**data,'message':windows_task_message(data,paused)}
        else:return {'enabled':None,'running':None,'message':'当前系统无法核验登录启动服务。'}
        if not enabled:message='未启用登录后自动上线，或服务指向其他版本；在本机执行 harness service install 补装；路径不匹配时先更新客户端。'
        elif paused:message='已启用登录后自动上线；当前已手动下线，需执行 harness online 恢复。'
        elif not running:message='已启用登录后自动上线，但后台服务未运行；执行 harness online，仍异常时执行 harness doctor。'
        else:message='已启用登录后自动上线，后台服务正在运行；退出登录、休眠或断网时可能离线。'
        return {'enabled':bool(enabled),'running':bool(running),'message':message}
    except (OSError,ValueError,RuntimeError,subprocess.SubprocessError):
        if sys.platform=='win32':
            return {'enabled':None,'running':None,'registered':None,'message':'无法查询 Windows 登录启动任务，注册状态未知；请使用安装席位的 Windows 用户检查任务计划程序权限。此结果不代表任务未注册。'}
        return {'enabled':None,'running':None,'message':'无法核验登录启动服务；在本机执行 harness doctor，检查当前用户的系统服务权限。'}


def check(root=None):
    value=status(root)
    return {'id':'autostart','label':'登录后自动上线','status':'pass' if value['enabled'] and value['running'] else 'warn','message':value['message']}


def verify_installation(root=None):
    value=status(root)
    for _ in range(10):
        if value['enabled'] is not True or value['running'] is True:break
        if (Path(os.environ.get('DSP7_BRIDGE_CONFIG') or Path.home()/'.config/paperclip-dsp7-bridge/config.json').parent/'seat-offline.json').is_file():break
        time.sleep(1);value=status(root)
    if value['enabled'] is not True or (value['running'] is not True and not (Path(os.environ.get('DSP7_BRIDGE_CONFIG') or Path.home()/'.config/paperclip-dsp7-bridge/config.json').parent/'seat-offline.json').is_file()):
        raise RuntimeError('自动上线安装核验未通过：'+value['message'])
    print('自动上线核验通过：'+value['message'])
