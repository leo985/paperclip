#!/usr/bin/env python3
"""Install only the current user's dedicated bridge watcher. Does not start tasks."""
import os
from pathlib import Path
import plistlib
import subprocess
import sys
root=Path(__file__).resolve().parent
from seat_profiles import config_path,service_label
runtime=config_path().parent;runtime.mkdir(parents=True,exist_ok=True,mode=0o700)
if not (runtime/'config.json').is_file():raise SystemExit('Prepare ~/.config/paperclip-dsp7-bridge/config.json first')
label=service_label()
folder=Path.home()/'Library/LaunchAgents';folder.mkdir(exist_ok=True)
file=folder/(label+'.plist')
value={'Label':label,'ProgramArguments':[sys.executable,str(root/'pilot.py'),'watch'],
       'WorkingDirectory':str(root),'RunAtLoad':True,'KeepAlive':{'SuccessfulExit':False},'ThrottleInterval':20,
       'StandardOutPath':str(runtime/'watch.log'),'StandardErrorPath':str(runtime/'watch.error.log'),
       'EnvironmentVariables':{'HOME':str(Path.home()),'PATH':'/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin','DSP7_BRIDGE_CONFIG':str(config_path())}}
domain='gui/'+str(os.getuid())
existing=subprocess.run(['launchctl','print',domain+'/'+label],capture_output=True)
if existing.returncode==0:
    if not file.is_file() or plistlib.loads(file.read_bytes()).get('ProgramArguments')!=value['ProgramArguments']:
        raise SystemExit('服务指向其他版本，请先更新客户端，不覆盖未知接入服务。')
file.write_bytes(plistlib.dumps(value));file.chmod(0o600)
subprocess.run(['launchctl','enable',domain+'/'+label],check=True)
if existing.returncode!=0:subprocess.run(['launchctl','bootstrap',domain,str(file)],check=True)
# No -k: preserve an already-running watcher and its active Claude session.
subprocess.run(['launchctl','kickstart',domain+'/'+label],check=True)
print('已启用当前用户登录后自动上线；后台接入服务已启动。')
