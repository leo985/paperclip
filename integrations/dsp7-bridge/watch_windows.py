"""Logon-task entry point. Log bootstrap failures before loading the bridge."""
import contextlib
import datetime
import json
import os
from pathlib import Path
import sys


def main(runtime=None, bridge=None, check_startup=False, config=None):
    selected=Path(config or os.environ.get('DSP7_BRIDGE_CONFIG') or Path.home()/'.config/paperclip-dsp7-bridge/config.json')
    root=Path(runtime or selected.parent)
    root.mkdir(parents=True,exist_ok=True,mode=0o700)
    log=root/'watcher.log'
    for path in (root,log):
        if path.is_symlink() or (path.exists() and getattr(path.lstat(),'st_file_attributes',0)&0x400):
            raise RuntimeError('Watcher diagnostic path must not be a link or junction')
    if log.exists() and log.stat().st_size>5*1024*1024:
        os.replace(log,root/'watcher.previous.log')
    # Bootstrap records contain only stage/type/error codes, never credentials
    # or arbitrary exception text. Child output starts after ACL verification.
    with log.open('a',encoding='utf-8',buffering=1) as stream, contextlib.redirect_stdout(stream), contextlib.redirect_stderr(stream):
        def record(stage,**values):
            print(json.dumps({'at':datetime.datetime.now(datetime.timezone.utc).isoformat(),'watcherStage':stage,**values}),flush=True)
        stage='imports'
        try:
            record(stage)
            from platform_support import private_directory,own_process_job
            stage='directory-permissions';record(stage)
            private_directory(root)
            stage='process-job';record(stage)
            own_process_job()
            if check_startup:
                record('startup-check-passed');return 0
            import subprocess
            python=Path(sys.executable).with_name('python.exe')
            script=Path(bridge or Path(__file__).resolve().parent)/'pilot.py'
            stage='supervisor';record(stage)
            result=subprocess.run([str(python),str(script),'watch'],env=dict(os.environ,DSP7_BRIDGE_CONFIG=str(selected)),stdout=stream,stderr=stream,stdin=subprocess.DEVNULL,creationflags=getattr(subprocess,'CREATE_NO_WINDOW',0))
            record('supervisor-exited',exitCode=result.returncode)
            return result.returncode
        except Exception as error:
            record('bootstrap-failed',failedStage=stage,errorType=type(error).__name__,winerror=getattr(error,'winerror',None),errno=getattr(error,'errno',None))
            return 2


if __name__=='__main__':
    try:
        import argparse
        parser=argparse.ArgumentParser();parser.add_argument('--config',type=Path);parser.add_argument('--check-startup',action='store_true')
        args=parser.parse_args()
        raise SystemExit(main(check_startup=args.check_startup,config=args.config))
    except Exception as error:
        if sys.stderr is not None:print('Watcher diagnostics unavailable: '+type(error).__name__,file=sys.stderr)
        raise SystemExit(2)
