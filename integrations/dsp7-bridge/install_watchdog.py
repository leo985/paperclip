"""Install an idempotent, user-session timer for the selected seat."""
import json
import os
from pathlib import Path
import plistlib
import subprocess
import sys
import time

from platform_support import private_directory, powershell
from seat_profiles import config_path, service_label, service_suffix
from seat_watchdog import INTERVAL_SECONDS, write_json


def install_mac(directory):
    label = service_label() + '.watchdog'
    folder = Path.home() / 'Library/LaunchAgents'
    folder.mkdir(parents=True, exist_ok=True)
    file = folder / (label + '.plist')
    args = [sys.executable, str(directory / 'watchdog.py')]
    value = {
        'Label': label, 'ProgramArguments': args, 'WorkingDirectory': str(directory),
        'RunAtLoad': True, 'StartInterval': INTERVAL_SECONDS,
        'StandardOutPath': str(directory / 'scheduler.log'),
        'StandardErrorPath': str(directory / 'scheduler.error.log'),
        'EnvironmentVariables': {'HOME': str(Path.home()), 'PATH': '/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin'},
    }
    target = 'gui/' + str(os.getuid()) + '/' + label
    loaded = subprocess.run(['launchctl', 'print', target], capture_output=True)
    if file.exists():
        old = plistlib.loads(file.read_bytes())
        if (old.get('ProgramArguments') != args or old.get('WorkingDirectory') != str(directory)
                or old.get('StartInterval') != INTERVAL_SECONDS or old.get('RunAtLoad') is not True):
            raise RuntimeError('席位巡检服务路径或周期不一致，未覆盖；请核对原巡检任务。')
    elif loaded.returncode == 0:
        raise RuntimeError('已加载的席位巡检服务缺少登记文件，未覆盖。')
    file.write_bytes(plistlib.dumps(value))
    file.chmod(0o600)
    subprocess.run(['launchctl', 'enable', target], check=True, capture_output=True)
    if loaded.returncode != 0:
        subprocess.run(['launchctl', 'bootstrap', 'gui/' + str(os.getuid()), str(file)], check=True, capture_output=True)
    # Do not kickstart: online may be running from this very timer.


def install_windows(directory):
    executable = Path(sys.executable).with_name('pythonw.exe')
    if not executable.is_file():
        raise RuntimeError('Python 安装缺少 pythonw.exe；请修复 Python 安装')
    env = dict(os.environ, PAPERCLIP_TASK_SUFFIX=service_suffix(),
               PAPERCLIP_WATCHDOG_PYTHON=str(executable),
               PAPERCLIP_WATCHDOG_ARGS='"' + str(directory / 'watchdog.py') + '"',
               PAPERCLIP_WATCHDOG_ROOT=str(directory))
    # Interactive token preserves the bridge's login/visible-terminal contract.
    # Existing tasks are queried/started without re-registering or -Force.
    result = powershell(r'''$ErrorActionPreference='Stop';
$sid=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value;
$name='Zhiyan-Seat-Watchdog-'+$sid+$env:PAPERCLIP_TASK_SUFFIX;
function Is-CurrentUser($value){if($value -eq $sid){return $true};try{return ([Security.Principal.NTAccount]::new([string]$value)).Translate([Security.Principal.SecurityIdentifier]).Value -eq $sid}catch{return $false}};
$task=$null;try{$task=Get-ScheduledTask -TaskName $name -ErrorAction Stop}catch{if($_.FullyQualifiedErrorId -notlike 'CmdletizationQuery_NotFound*'){throw}};
if($task){
  $periodic=@($task.Triggers | Where-Object {$_.Enabled -ne $false -and $_.Repetition.Interval -eq 'PT1M'}).Count -gt 0;
  $matches=(Is-CurrentUser $task.Principal.UserId) -and $task.Principal.LogonType -eq 'Interactive' -and @($task.Actions).Count -eq 1 -and $task.Actions.Execute -eq $env:PAPERCLIP_WATCHDOG_PYTHON -and $task.Actions.Arguments -eq $env:PAPERCLIP_WATCHDOG_ARGS -and $task.Actions.WorkingDirectory -eq $env:PAPERCLIP_WATCHDOG_ROOT -and $periodic;
  if(-not $matches){throw 'Seat watchdog identity, path or interval mismatch; refusing to overwrite'};
  if(-not $task.Settings.Enabled){throw 'Seat watchdog task is disabled; enable it before installing'};
  if($task.Settings.ExecutionTimeLimit -ne 'PT10M'){$task.Settings.ExecutionTimeLimit='PT10M';Set-ScheduledTask -TaskName $name -Settings $task.Settings | Out-Null};
}else{
  $action=New-ScheduledTaskAction -Execute $env:PAPERCLIP_WATCHDOG_PYTHON -Argument $env:PAPERCLIP_WATCHDOG_ARGS -WorkingDirectory $env:PAPERCLIP_WATCHDOG_ROOT;
  $trigger=New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) -RepetitionInterval (New-TimeSpan -Minutes 1);
  $principal=New-ScheduledTaskPrincipal -UserId $sid -LogonType Interactive -RunLevel Limited;
  $settings=New-ScheduledTaskSettingsSet -ExecutionTimeLimit (New-TimeSpan -Minutes 10) -MultipleInstances IgnoreNew -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries;
  Register-ScheduledTask -TaskName $name -Action $action -Trigger $trigger -Principal $principal -Settings $settings | Out-Null;
};
@{registered=$true;enabled=$true}|ConvertTo-Json -Compress''', env=env)
    state = json.loads(result.stdout)
    if not state.get('registered') or not state.get('enabled'):
        raise RuntimeError('Windows 席位巡检任务核验失败')


def install_linux(directory):
    folder = Path.home() / '.config/systemd/user'
    folder.mkdir(parents=True, exist_ok=True)
    name = 'paperclip-dsp7-watchdog' + service_suffix()
    def quote(value):
        return '"' + str(value).replace('\\', '\\\\').replace('"', '\\"').replace('%', '%%') + '"'
    command = quote(sys.executable) + ' ' + quote(directory / 'watchdog.py')
    service = '[Unit]\nDescription=Paperclip seat recovery check\n\n[Service]\nType=oneshot\nExecStart=' + command + '\nTimeoutStartSec=600\n'
    timer = '[Unit]\nDescription=Paperclip seat recovery timer\n\n[Timer]\nOnActiveSec=60\nOnUnitActiveSec=60\nAccuracySec=1\nUnit=' + name + '.service\n\n[Install]\nWantedBy=timers.target\n'
    unit = folder / (name + '.service')
    timer_file = folder / (name + '.timer')
    if unit.exists() and unit.read_text(encoding='utf-8') not in (service, service.replace('TimeoutStartSec=600', 'TimeoutStartSec=90')):
        raise RuntimeError('席位巡检服务路径或配置不一致，未覆盖。')
    if timer_file.exists() and timer_file.read_text(encoding='utf-8') != timer:
        raise RuntimeError('席位巡检定时器配置不一致，未覆盖。')
    for file, value in ((unit, service), (timer_file, timer)):
        file.write_text(value, encoding='utf-8')
        file.chmod(0o600)
    subprocess.run(['systemctl', '--user', 'daemon-reload'], check=True, capture_output=True)
    subprocess.run(['systemctl', '--user', 'enable', '--now', timer_file.name], check=True, capture_output=True)
    subprocess.run(['systemctl', '--user', 'is-active', '--quiet', timer_file.name], check=True, capture_output=True)


def install(root):
    config = config_path()
    directory = private_directory(config.parent / 'seat-watchdog')
    # A stable, dependency-free entry survives bundle replacement. Recovery reads
    # quick_setup.bridge from the current config, including after rollback.
    script = directory / 'watchdog.py'
    temporary = directory / 'watchdog.new'
    temporary.write_bytes((Path(root) / 'seat_watchdog.py').read_bytes())
    temporary.chmod(0o600)
    os.replace(temporary, script)
    updater = directory / 'remote_upgrade.new'
    updater.write_bytes((Path(root) / 'seat_remote_upgrade.py').read_bytes())
    updater.chmod(0o600)
    os.replace(updater, directory / 'remote_upgrade.py')
    settings = {'config': str(config), 'bridge': str(root), 'python': sys.executable, 'installed_at': time.time()}
    # Reusing a service must not continually renew the startup grace period.
    try:
        previous = json.loads((directory / 'settings.json').read_text(encoding='utf-8'))
        if all(previous.get(k) == settings[k] for k in ('config', 'bridge', 'python')):
            settings['installed_at'] = previous['installed_at']
    except (OSError, ValueError, KeyError, TypeError):
        pass
    write_json(directory / 'settings.json', settings)
    for name in ('scheduler.log', 'scheduler.error.log'):
        file = directory / name
        file.touch(mode=0o600, exist_ok=True)
        file.chmod(0o600)
    if sys.platform == 'darwin':
        install_mac(directory)
    elif sys.platform == 'win32':
        install_windows(directory)
    elif sys.platform == 'linux':
        install_linux(directory)
    else:
        raise RuntimeError('当前系统不支持席位定时巡检')
    print('已启用席位每分钟巡检；心跳超时或服务停止时自动上线，手动下线和升级期间跳过。')
