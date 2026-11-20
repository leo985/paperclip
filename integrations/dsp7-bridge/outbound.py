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

def execution_result(exit_code, summary, run_id):
    result = {'exitCode': exit_code, 'signal': None, 'timedOut': False,
              'billingType': 'unknown', 'costUsd': None, 'sessionId': run_id}
    models = summary.get('modelUsage') if isinstance(summary, dict) else None
    valid = isinstance(models, dict) and bool(models)
    if valid:
        valid = all(isinstance(name, str) and isinstance(value, dict) and
                    all(type(value.get(key, 0)) is int and 0 <= value.get(key, 0) <= 2147483647
                        for key in ('inputTokens', 'outputTokens', 'cacheReadInputTokens'))
                    for name, value in models.items())
    if valid:
        usage = {target: sum(value.get(source, 0) for value in models.values())
                 for target, source in [('inputTokens', 'inputTokens'), ('outputTokens', 'outputTokens'),
                                        ('cachedInputTokens', 'cacheReadInputTokens')]}
        if all(value <= 2147483647 for value in usage.values()):
            result.update(summary=str(summary.get('result') or '')[:10000], model=next(iter(models)),
                          usageBasis='per_run', usage=usage)
        else: valid = False
    if exit_code != 0 or not valid:
        result.update(exitCode=exit_code or 1,
                      errorMessage='本机会话中断或用量未知；核对本机报告后再处理，不自动重新执行')
    # Failure does not erase usage already observed. CLI's model-price estimate
    # is not a relay/subscription bill, so cost remains explicitly unknown.
    return result

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

def collect_usage_checkpoint(folder, run_id, lease, cwd, sequence, previous):
    from interactive import usage_ledger
    from datetime import datetime, timezone
    try:
        observed, status = usage_ledger(cwd, run_id)
        if status != 'observed': return sequence, previous
        result = execution_result(0, observed, run_id)
        if not result.get('usage'): return sequence, previous
        current = {'model': result['model'], 'usage': result['usage']}
        if current == previous: return sequence, previous
        # Never replace a previously observed high-water mark with a partial or
        # temporarily missing JSONL file. Server independently enforces this.
        if previous and any(current['usage'][key] < previous['usage'][key] for key in current['usage']):
            return sequence, previous
        sequence += 1
        atomic_json(folder/'usage-checkpoints'/('{:010d}.json'.format(sequence)),
                    {'runId':run_id,'lease':lease,'sequence':sequence,'observedAt':datetime.now(timezone.utc).isoformat(),**current})
        return sequence, current
    except (OSError, ValueError, BridgeError): return sequence, previous


def flush_exit_receipts(b):
    deadline=time.monotonic()+5
    root = Path(b.cfg['database']).parent / 'outbound'
    # Immutable checkpoints precede final settlement. Bounded retries never
    # overwrite or delete a newer observation while an older upload is pending.
    files = sorted(root.glob('*/startup-failure.json'))[:20] + sorted(root.glob('*/usage-checkpoints/*.json'))[:40] + sorted(root.glob('*/usage-receipt.json'))[:20] + sorted(root.glob('*/exit-receipt.json'))[:20]
    for file in files:
        if time.monotonic()>=deadline:break
        try:
            receipt = read_json(file)
            run_id = str(uuid.UUID(receipt['runId']))
            if file.name == 'startup-failure.json':
                body = {**identity(b), 'lease': receipt['lease'], 'sequence': 1, 'result': receipt['result']}
                if receipt.get('permitProtocol') == 1: body['permitProtocol'] = 1
                response = seat_api(b).request('POST', '/agents/' + b.cfg['agent_id'] + '/dsp7-outbound-runs/' + run_id, body, timeout=max(.1,min(5,deadline-time.monotonic())))
                if isinstance(response,dict) and response.get('alive') is True and response.get('sequence') == 1: file.unlink()
                continue
            checkpoint = file.parent.name == 'usage-checkpoints'
            usage = checkpoint or file.name == 'usage-receipt.json'
            body = {**identity(b), 'lease': receipt['lease']}
            body.update({'model': receipt['model'], 'usage': receipt['usage']} if usage else {'exitObserved': True})
            if checkpoint: body.update(sequence=receipt['sequence'],observedAt=receipt['observedAt'])
            if not usage and receipt.get('treeProof'): body['treeProof'] = receipt['treeProof']
            suffix = '/usage-checkpoint' if checkpoint else '/usage-final' if usage else '/stopped'
            response = seat_api(b).request('POST', '/agents/' + b.cfg['agent_id'] + '/dsp7-outbound-runs/' + run_id + suffix, body, timeout=max(.1,min(5,deadline-time.monotonic())))
            if isinstance(response,dict) and response.get('received') is True: file.unlink()
        except (BridgeError, OSError, ValueError, KeyError, TypeError):
            continue

def poll(b):
    if b.cfg.get('execution_transport')!='outbound':return
    verify_runtime(b)
    flush_exit_receipts(b)
    response=seat_api(b).request('POST','/agents/'+b.cfg['agent_id']+'/dsp7-outbound-poll',{**identity(b),'revision':b.cfg['seat_runtime']['revision'],'permitProtocol':1,'supervisionProtocol':2})
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

def record_startup_failure(packet, folder, error):
    # Only preflight failures before any heartbeat or spawn have an unambiguous
    # first receipt. Never reuse sequence 1 after a possibly delivered request.
    if (folder/'launch-attempt.json').exists() or packet.get('_receipt_attempted'):
        return
    # Exception text can include local input or API responses. Only these fixed
    # diagnostics are allowed into the server-bound receipt; traceback stays local.
    known = {
        'Harness 仓库、profile、文件或版本已变化，请空闲时重新登记',
        'Harness 路由版本已变化，请重新核验授权',
        '分析 Harness 文件或版本已变化，请重新登记能力',
        '本机 Claude 版本、配置或 Harness 路径已变化，请运行 harness seat register 刷新',
        '席位正在升级，未启动任务',
        '本机已暂停新运行，请执行 harness online 恢复',
    }
    detail = str(error) if isinstance(error, BridgeError) and str(error) in known else '请查看本机 worker.log 中的具体原因'
    receipt = {'runId': packet['runId'], 'lease': packet['lease'],
               'result': {'exitCode': 1, 'signal': None, 'timedOut': False,
                          'errorMessage': '本机启动校验失败，未启动 Claude：' + detail}}
    if packet.get('permit'): receipt['permitProtocol'] = 1
    atomic_json(folder/'startup-failure.json', receipt)


def run(config_path):
    own_process_job()
    packet=json.loads(sys.stdin.buffer.read(10*1024*1024+1));b=Bridge(config_path)
    run_id=str(uuid.UUID(packet['runId']))
    folder=Path(b.cfg['database']).parent/'outbound'/run_id
    try:
        _run(b,packet,config_path)
    except BaseException as error:
        # Setup/version failures occur before the launch try/finally. They also
        # need a durable no-start receipt, but never fabricate one after spawn.
        if isinstance(error, Exception):
            record_startup_failure(packet, folder, error)
        if packet.get('permit') and not (folder/'launch-attempt.json').exists():
            from process_tree import ProcessTree
            tree=ProcessTree(run_id);tree.attach(None)
            atomic_json(folder/'exit-receipt.json',{'runId':run_id,'lease':packet['lease'],'treeProof':tree.proof()})
        flush_exit_receipts(b)
        raise


def _run(b,packet,config_path):
    if (Path(b.cfg['database']).parent/'upgrade-in-progress.json').exists():raise BridgeError('席位正在升级，未启动任务')
    verify_runtime(b)
    from seat_lifecycle import offline_requested
    if offline_requested(b):raise BridgeError('本机已暂停新运行，请执行 harness online 恢复')
    run_id=str(uuid.UUID(packet['runId']));task_id=str(uuid.UUID(packet['taskId']))
    if packet['agentId']!=b.cfg['agent_id'] or packet['companyId']!=b.cfg['company_id']:raise BridgeError('执行包身份不匹配')
    from harness_routing import resolve_route,assert_legacy_development_root
    analysis=packet.get('executionKind')=='analysis'
    delivery=packet.get('executionKind')=='delivery'
    folder=Path(b.cfg['database']).parent/'outbound'/run_id
    if delivery:
        from delivery_execution import prepare
        delivery_context=prepare(b,packet,folder)
        cwd=Path(delivery_context['root'])
    elif analysis:
        from analysis_execution import prepare
        analysis_context=prepare(b,packet,folder)
        resolved=resolve_route(b,packet.get('executionRoute'),run_id,task_id,'analysis')
        cwd=Path(resolved['root'])
    else:
        resolved=resolve_route(b,packet.get('executionRoute'),run_id,task_id,'development')
        assert_legacy_development_root(b,resolved)
        row=b.db.execute('SELECT jira_key FROM pilots WHERE task_id=?',(task_id,)).fetchone()
        if not row:raise BridgeError('本机没有登记此任务')
        pilot=b.pilot(row['jira_key']);d=pilot['details']
        from harness_launch import launch_context
        cwd=Path(launch_context(b,d)['cwd'])
    asset_root=materialize(folder/'assets',packet.get('skills') or [])
    env=dict(os.environ);env.update(PAPERCLIP_API_URL=b.cfg['paperclip_url'].rstrip('/'),PAPERCLIP_API_KEY=packet['authToken'],PAPERCLIP_RUN_ID=run_id,PAPERCLIP_TASK_ID=task_id,PAPERCLIP_AGENT_ID=b.cfg['agent_id'],PAPERCLIP_COMPANY_ID=b.cfg['company_id'],PAPERCLIP_WAKE_REASON=packet['reason'],DSP7_BRIDGE_CONFIG=str(config_path),DSP7_OUTBOUND_WORKER_PID=str(os.getpid()),DSP7_PROCESS_TREE_ANCHOR=str(folder/'process-tree-anchor.json'))
    if delivery:env.update(DSP7_EXECUTION_KIND='delivery',DSP7_DELIVERY_CONTEXT=str(folder/'delivery-context.json'),HARNESS_SESSION_ID=run_id,HARNESS_TASK_ID=delivery_context['stage']['jiraKey'])
    if analysis:env.update(DSP7_EXECUTION_KIND='analysis',DSP7_ANALYSIS_CONTEXT=str(folder/'analysis-context.json'))
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
    from execution_permit import ExecutionPermit
    from process_tree import ProcessTree
    tree=ProcessTree(run_id,folder/'process-tree-anchor.json')
    guard=ExecutionPermit(terminate=tree.stop) if packet.get('permit') else None
    child=None;seq=0;buffer='';summary=None;last_pulse=0;last_success=time.monotonic();api=seat_api(b);usage_sequence=0;usage_previous=None
    endpoint='/agents/'+b.cfg['agent_id']+'/dsp7-outbound-runs/'+run_id
    def send(stream=None,chunk=None,result=None):
        nonlocal seq,last_success
        if guard: guard.check()
        body={**identity(b),'lease':packet['lease'],'sequence':seq+1}
        if guard:body['permitProtocol']=1
        if chunk:body.update(stream=stream,chunk=chunk)
        if result:body['result']=result
        request_started=time.monotonic()
        packet['_receipt_attempted']=True
        response=api.request('POST',endpoint,body)
        if not response.get('alive'):raise BridgeError('服务端运行或租约已结束，停止本机对应进程')
        if guard: guard.renew(response.get('permit'),request_started)
        seq+=1;last_success=time.monotonic()
    def stop(*args):raise KeyboardInterrupt
    signal.signal(signal.SIGTERM,stop);signal.signal(signal.SIGINT,stop)
    try:
        send()
        # Repeat file/version checks at the last launch boundary. Capability
        # registration alone never changes the legacy task's root or identity.
        resolved=resolve_route(b,packet.get('executionRoute'),run_id,task_id,packet['deliveryKind'] if delivery else 'analysis' if analysis else 'development')
        if not analysis and not delivery:assert_legacy_development_root(b,resolved)
        if guard:guard.start()
        atomic_json(folder/'launch-attempt.json',{'runId':run_id,'state':'spawn_attempted'})
        child=subprocess.Popen(cli,cwd=cwd,env=env,stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE,start_new_session=True)
        tree.attach(child)
        if guard:guard.attach(child)
        child.stdin.write(packet['prompt'].encode());child.stdin.close()
        import codecs
        decoders={s:codecs.getincrementaldecoder('utf-8')(errors='replace') for s in ('stdout','stderr')}
        reader=PipeReader(child)
        while reader.open or child.poll() is None:
            for stream,raw in reader.read():
                chunk=decoders[stream].decode(raw)
                if stream=='stdout':
                    buffer+=chunk
                    while '\n' in buffer:
                        line,buffer=buffer.split('\n',1)
                        with contextlib.suppress(ValueError):
                            item=json.loads(line)
                            if item.get('type')=='result':summary=item
                    if len(buffer)>65536:buffer=buffer[-65536:]
                send(stream,chunk)
            if time.monotonic()-last_pulse>=5:
                if guard:
                    usage_sequence,usage_previous=collect_usage_checkpoint(folder,run_id,packet['lease'],cwd,usage_sequence,usage_previous)
                    flush_exit_receipts(b)
                if analysis and not (Path(b.cfg['database']).parent/'interactive/runs'/run_id/'analysis-completion.json').exists():
                    # Progress is observed while Claude works, not only at Stop.
                    # Partial file saves may be transient; never infer completion.
                    with contextlib.suppress(BridgeError,OSError,ValueError,KeyError):
                        from analysis_execution import runtime_for,api_call
                        snapshot=runtime_for(b,analysis_context).status()
                        wait_path=Path(b.cfg['database']).parent/'interactive/runs'/run_id/'wait.json'
                        waiting=wait_path.is_file() and read_json(wait_path).get('status')=='waiting_confirmation'
                        api_call(b,analysis_context,'observe',snapshot=snapshot,waiting=waiting)
                try:send()
                except BridgeError:
                    if time.monotonic()-last_success>=30:raise
                last_pulse=time.monotonic()
        result=execution_result(child.returncode,summary,run_id)
        send(result=result)
    finally:
        proof=None
        if guard:
            try:
                if child is None: tree.attach(None)
                tree.stop();proof=tree.proof()
            except (BridgeError,OSError,ValueError,subprocess.SubprocessError):
                atomic_json(folder/'tree-stop-pending.json',{'runId':run_id,'state':'unknown','reason':'managed_tree_not_verified'})
            finally:guard.close()
            usage_sequence,usage_previous=collect_usage_checkpoint(folder,run_id,packet['lease'],cwd,usage_sequence,usage_previous)
            if child is None or child.poll() is not None:
                final=execution_result(child.returncode if child is not None else 1,summary,run_id)
                if final.get('usage') is not None:
                    atomic_json(folder/'usage-receipt.json',{'runId':run_id,'lease':packet['lease'],'model':final['model'],'usage':final['usage']})
                atomic_json(folder/'exit-receipt.json',{'runId':run_id,'lease':packet['lease'],**({'treeProof':proof} if proof else {})})
                flush_exit_receipts(b)
        else:terminate_tree(child)
        # Run-only MCP credentials should not remain after execution.
        with contextlib.suppress(FileNotFoundError):(folder/'mcp.json').unlink()

if __name__=='__main__':
    import argparse
    parser=argparse.ArgumentParser();parser.add_argument('action',choices=['run']);parser.add_argument('--config',type=Path,default=DEFAULT_CONFIG);args=parser.parse_args()
    try:run(args.config)
    except (BridgeError,OSError,ValueError,KeyboardInterrupt):
        import traceback
        traceback.print_exc()
        print('本机执行监督器已停止；请核对运行状态与本机报告，不自动重试。',file=sys.stderr);sys.exit(2)
