"""Logon-task entry point. Run with pythonw; retain local diagnostics."""
import os
from pathlib import Path
import sys
from platform_support import private_directory,own_process_job
root=private_directory(Path.home()/'.config/paperclip-dsp7-bridge')
log=root/'watcher.log'
if log.exists() and log.stat().st_size>5*1024*1024:
    os.replace(log,root/'watcher.previous.log')
with log.open('a',encoding='utf-8',buffering=1) as stream:
    sys.stdout=stream;sys.stderr=stream
    try:
        own_process_job()
        import subprocess
        python=Path(sys.executable).with_name('python.exe')
        raise SystemExit(subprocess.call([str(python),str(Path(__file__).resolve().parent/'pilot.py'),'watch'],stdout=stream,stderr=stream,stdin=subprocess.DEVNULL,creationflags=subprocess.CREATE_NO_WINDOW))
    except Exception as error:
        # Avoid dumping config/API response bodies or credentials into a log.
        print('Seat watcher stopped: '+type(error).__name__)
        raise SystemExit(2)
