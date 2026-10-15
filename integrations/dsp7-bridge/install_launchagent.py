#!/usr/bin/env python3
"""Install only the current user's dedicated bridge watcher. Does not start tasks."""
import os
from pathlib import Path
import plistlib
import subprocess
import sys
root=Path(__file__).resolve().parent
runtime=Path.home()/'.config/paperclip-dsp7-bridge';runtime.mkdir(exist_ok=True,mode=0o700)
if not (runtime/'config.json').is_file():raise SystemExit('Prepare ~/.config/paperclip-dsp7-bridge/config.json first')
label='com.leo.paperclip-dsp7-bridge'
folder=Path.home()/'Library/LaunchAgents';folder.mkdir(exist_ok=True)
file=folder/(label+'.plist')
value={'Label':label,'ProgramArguments':[sys.executable,str(root/'pilot.py'),'watch'],
       'WorkingDirectory':str(root),'RunAtLoad':True,'KeepAlive':True,'ThrottleInterval':20,
       'StandardOutPath':str(runtime/'watch.log'),'StandardErrorPath':str(runtime/'watch.error.log'),
       'EnvironmentVariables':{'HOME':str(Path.home()),'PATH':'/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin'}}
domain='gui/'+str(os.getuid())
existing=subprocess.run(['launchctl','print',domain+'/'+label],capture_output=True)
if existing.returncode==0:
    if file.is_file() and plistlib.loads(file.read_bytes()).get('ProgramArguments')==value['ProgramArguments']:
        print('本用户接入服务已运行。');raise SystemExit(0)
    raise SystemExit('LaunchAgent already installed; use launchctl kickstart -k '+domain+'/'+label+' after review')
file.write_bytes(plistlib.dumps(value));file.chmod(0o600)
subprocess.run(['launchctl','bootstrap',domain,str(file)],check=True)
print('Installed '+label+'; only explicitly enabled pilots can run.')
