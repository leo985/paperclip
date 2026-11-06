"""Independent, outbound-only command lane for the watcher.

No shared SQLite connection and no background reporting in this lane. Durable
server requests plus delivery.lock/opened persist the single terminal handoff.
"""
from pathlib import Path
import json
import sqlite3
import subprocess
import threading
from platform_support import fcntl
from pilot import Bridge, BridgeError, read_json, now
from seats import seat_api, identity


def start_receiver(config_path):
    stop=threading.Event()
    def receive():
        b=None
        failures=0
        try:
            b=Bridge(config_path)
            from seat_control import setup, process_commands
            setup(b)
            while not stop.is_set():
                try:
                    latest=read_json(config_path)
                    if any(latest.get(k)!=b.cfg.get(k) for k in ('agent_id','company_id','database','harness_root','paperclip_url','credential_file')):return
                    b.cfg=latest
                    known=[r['command_id'] for r in b.db.execute("SELECT command_id FROM seat_commands WHERE opened=1 OR status IN ('accepted','running','succeeded','failed','denied','cancelled','expired') ORDER BY updated_at DESC LIMIT 100").fetchall()]
                    response=seat_api(b).request('POST','/agents/'+b.cfg['agent_id']+'/dsp7-seat-commands/wait',{**identity(b),'knownCommandIds':known})
                    if stop.is_set():break
                    if response.get('commands'):
                        # Never hold upgrade or delivery locks across long polling.
                        with (Path(b.cfg['database']).parent/'upgrade.lock').open('a') as lock:
                            try:fcntl.flock(lock,fcntl.LOCK_SH|fcntl.LOCK_NB)
                            except BlockingIOError:
                                stop.wait(1);continue
                            if (Path(b.cfg['database']).parent/'upgrade-in-progress.json').exists():
                                stop.wait(1);continue
                            from jira_dispatch import tick
                            tick(b) # Refresh authority before deciding automatic vs manual.
                            process_commands(b,response)
                    failures=0
                except (BridgeError,OSError,ValueError,sqlite3.Error,subprocess.SubprocessError):
                    failures+=1
                    if failures==1:print(json.dumps({'at':now(),'command_receiver':'指令连接暂不可用，保留心跳领取兜底；稍后自动重连'},ensure_ascii=False),flush=True)
                    stop.wait(min(30,2**min(failures,5)))
        finally:
            if b:b.db.close()
    threading.Thread(target=receive,name='seat-command-receiver',daemon=True).start()
    return stop
