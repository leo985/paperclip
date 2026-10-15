import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
const ui=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const source=process.env.DSP7_BRIDGE_SOURCE||path.resolve(ui,'../integrations/dsp7-bridge');
const script=`from pathlib import Path
import hashlib,json,sys,zipfile
source=Path(sys.argv[1]);public=Path(sys.argv[2]);public.mkdir(parents=True,exist_ok=True)
names=['jira_dispatch.py','pilot.py','seats.py','seat_control.py','onboard.py','interactive.py','interactive_wait.py','jira_intake.py','claude-interactive-wrapper','install_launchagent.py','config.example.json','README.md','outbound.py','quick_install.py','install_service.py','platform_support.py','windows_terminal.py','watch_windows.py','harness_entry.py','install_windows.ps1']
with zipfile.ZipFile(public/'dsp7-bridge.zip','w',zipfile.ZIP_DEFLATED) as z:
 for name in names:z.write(source/name,arcname=name)
(public/'dsp7-install.py').write_bytes((source/'quick_install.py').read_bytes())
(public/'dsp7-install.ps1').write_bytes((source/'install_windows.ps1').read_bytes())
(public/'dsp7-bridge-manifest.json').write_text(json.dumps({'sha256':hashlib.sha256((public/'dsp7-bridge.zip').read_bytes()).hexdigest(),'format':1})+'\\n')
print('Built personal seat installer and verified bridge bundle')`;
const r=spawnSync('python3',['-c',script,source,path.join(ui,'public')],{stdio:'inherit'});if(r.status!==0)process.exit(r.status||1);
