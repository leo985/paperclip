"""Outbound native-run transport. Model keys remain in the user's Claude settings."""
from __future__ import annotations
import base64
import contextlib
import json
import os
from pathlib import Path, PurePosixPath
import selectors
import signal
import subprocess
import sys
import time
import uuid
from pilot import Bridge, BridgeError, atomic_json, read_json, DEFAULT_CONFIG
from seats import identity, seat_api, verify_runtime
from platform_support import WINDOWS,PipeReader,terminate_tree,own_process_job

def materialize(folder,files):
    root=folder/'.claude/skills';root.mkdir(parents=True,mode=0o700,exist_ok=True)
    size=0
    if len(files)>1000:raise BridgeError('组织技能包文件过多')
    for item in files:
        relative=PurePosixPath(item['path'])
        if relative.is_absolute() or not relative.parts or any(x in ('..','.') for x in relative.parts) or '\\' in item['path']:raise BridgeError('技能文件路径无效')
        dest=root.joinpath(*relative.parts)
        if not dest.resolve().is_relative_to(root.resolve()):raise BridgeError('技能文件越界')
        data=base64.b64decode(item['data'],validate=True);size+=len(data)
        if size>2*1024*1024:raise BridgeError('组织技能包超过传输上限')
        dest.parent.mkdir(parents=True,exist_ok=True,mode=0o700);dest.write_bytes(data);dest.chmod(0o600)
    return folder

def poll(b):
    if b.cfg.get('execution_transport')!='outbound':return
    verify_runtime(b)
    response=seat_api(b).request('POST','/agents/'+b.cfg['agent_id']+'/dsp7-outbound-poll',{**identity(b),'revision':b.cfg['seat_runtime']['revision']})
    packet=response.get('job')
    if not packet:return
    for key in ('runId','taskId','agentId','companyId','lease'):uuid.UUID(packet[key])
    if packet['agentId']!=b.cfg['agent_id'] or packet['companyId']!=b.cfg['company_id']:raise BridgeError('执行包身份不匹配')
    # The one-use dispatch is never retried if the launcher outcome is uncertain.
    folder=Path(b.cfg['database']).parent/'outbound'/packet['runId'];folder.mkdir(parents=True,mode=0o700,exist_ok=False)
    log=(folder/'worker.log').open('ab');os.chmod(folder/'worker.log',0o600)
    worker=subprocess.Popen([sys.executable,str(Path(__file__).resolve()),'run','--config',str(b.config_path)],stdin=subprocess.PIPE,stdout=log,stderr=log,start_new_session=True)
    log.close();worker.stdin.write(json.dumps(packet,ensure_ascii=False).encode());worker.stdin.close()
    b.event('_seat','outbound_worker_started',{'run_id':packet['runId'],'pid':worker.pid})

def run(config_path):
    own_process_job()
    packet=json.loads(sys.stdin.buffer.read(10*1024*1024+1));b=Bridge(config_path);verify_runtime(b)
    run_id=str(uuid.UUID(packet['runId']));task_id=str(uuid.UUID(packet['taskId']))
    if packet['agentId']!=b.cfg['agent_id'] or packet['companyId']!=b.cfg['company_id']:raise BridgeError('执行包身份不匹配')
    row=b.db.execute('SELECT jira_key FROM pilots WHERE task_id=?',(task_id,)).fetchone()
    if not row:raise BridgeError('本机没有登记此任务')
    pilot=b.pilot(row['jira_key']);folder=Path(b.cfg['database']).parent/'outbound'/run_id
    # Only a verified local startup intent may run a model. Interactive wrapper
    # consumes that exact intent and repeats Jira/reservation/lease checks.
    asset_root=materialize(folder/'assets',packet.get('skills') or [])
    d=pilot['details'];cwd=Path(d['state_path']).parent if d.get('mode')=='replay' else Path(d.get('worktree') or b.root)
    env=dict(os.environ);env.update(PAPERCLIP_API_URL=b.cfg['paperclip_url'].rstrip('/'),PAPERCLIP_API_KEY=packet['authToken'],PAPERCLIP_RUN_ID=run_id,PAPERCLIP_TASK_ID=task_id,PAPERCLIP_AGENT_ID=b.cfg['agent_id'],PAPERCLIP_COMPANY_ID=b.cfg['company_id'],PAPERCLIP_WAKE_REASON=packet['reason'],DSP7_BRIDGE_CONFIG=str(config_path),DSP7_OUTBOUND_WORKER_PID=str(os.getpid()))
    cli=[sys.executable,str(Path(__file__).resolve().parent/'claude-interactive-wrapper'),'--print','--output-format','stream-json','--verbose','--add-dir',str(b.root),'--add-dir',str(asset_root),'--add-dir',str(Path(__file__).resolve().parent)]
    internal=str(Path(__file__).resolve().parent/'pilot.py')
    import shlex
    local_agent=shlex.join([sys.executable.replace('\\','/'),internal.replace('\\','/')])
    cli+=['--allowedTools','Bash('+local_agent+' agent:*)']
    if packet.get('mcp'):
        entries={}
        for i,server in enumerate(packet['mcp']):
            url=server['url']
            # Runtime MCP URLs derived on the server may be loopback addresses;
            # same-instance routes use the locally configured reachable origin.
            import urllib.parse
            parsed=urllib.parse.urlsplit(url)
            if parsed.hostname in ('localhost','127.0.0.1'):url=b.cfg['paperclip_url'].rstrip('/')+parsed.path
            entries['paperclip-'+str(i)]={'type':'http','url':url,'headers':{'Authorization':'Bearer '+server['token']}}
        cfg=folder/'mcp.json';atomic_json(cfg,{'mcpServers':entries});cfg.chmod(0o600)
        cli+=['--mcp-config',str(cfg)]
    child=None;seq=0;buffer='';summary=None;last_pulse=0;last_success=time.monotonic();api=seat_api(b)
    endpoint='/agents/'+b.cfg['agent_id']+'/dsp7-outbound-runs/'+run_id
    def send(stream=None,chunk=None,result=None):
        nonlocal seq,last_success
        body={**identity(b),'lease':packet['lease'],'sequence':seq+1}
        if chunk:body.update(stream=stream,chunk=chunk)
        if result:body['result']=result
        response=api.request('POST',endpoint,body)
        if not response.get('alive'):raise BridgeError('服务端运行或租约已结束，停止本机对应进程')
        seq+=1;last_success=time.monotonic()
    def stop(*args):raise KeyboardInterrupt
    signal.signal(signal.SIGTERM,stop);signal.signal(signal.SIGINT,stop)
    try:
        send();child=subprocess.Popen(cli,cwd=cwd,env=env,stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE,start_new_session=True)
        child.stdin.write(packet['prompt'].encode());child.stdin.close()
        import codecs
        decoders={s:codecs.getincrementaldecoder('utf-8')(errors='replace') for s in ('stdout','stderr')}
        reader=PipeReader(child)
        while reader.open or child.poll() is None:
            for stream,raw in reader.read():
                chunk=decoders[stream].decode(raw);send(stream,chunk)
                if stream=='stdout':
                    buffer+=chunk
                    while '\n' in buffer:
                        line,buffer=buffer.split('\n',1)
                        with contextlib.suppress(ValueError):
                            item=json.loads(line)
                            if item.get('type')=='result':summary=item
                    if len(buffer)>65536:buffer=buffer[-65536:]
            if time.monotonic()-last_pulse>=5:
                try:send()
                except BridgeError:
                    if time.monotonic()-last_success>=30:raise
                last_pulse=time.monotonic()
        result={'exitCode':child.returncode,'signal':None,'timedOut':False,'billingType':'unknown','costUsd':None,'sessionId':run_id}
        if child.returncode==0 and summary and summary.get('modelUsage'):
            models=summary['modelUsage'];values=list(models.values())
            result.update(summary=str(summary.get('result') or '')[:10000],model=next(iter(models)),usageBasis='per_run',usage={'inputTokens':sum(v.get('inputTokens',0) for v in values),'outputTokens':sum(v.get('outputTokens',0) for v in values),'cachedInputTokens':sum(v.get('cacheReadInputTokens',0) for v in values)})
        else:result.update(exitCode=child.returncode or 1,errorMessage='本机会话中断或用量未知；核对本机报告后再处理，不自动重新执行')
        send(result=result)
    finally:
        terminate_tree(child)
        # Run-only MCP credentials should not remain after execution.
        with contextlib.suppress(FileNotFoundError):(folder/'mcp.json').unlink()

if __name__=='__main__':
    import argparse
    parser=argparse.ArgumentParser();parser.add_argument('action',choices=['run']);parser.add_argument('--config',type=Path,default=DEFAULT_CONFIG);args=parser.parse_args()
    try:run(args.config)
    except (BridgeError,OSError,ValueError,KeyboardInterrupt):print('本机执行监督器已停止；请核对运行状态与本机报告，不自动重试。',file=sys.stderr);sys.exit(2)
