"""Serial delivery lane. Native Harness identity, completion and external receipts
are verified on the enrolled device; model exit or a model-authored receipt is
never accepted as delivery. All network verification below is read-only.
"""
import contextlib
import re
import shlex
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
import time
import urllib.parse
import urllib.request
from pilot import Bridge, BridgeError, atomic_json, read_json, rows, load_module
from seats import seat_api, identity

METRICS_ARTIFACTS={'state.json','metrics-source.json','zhiyan-snapshot.json','execution-time.json','harness-report.json','payload.json','tracker-response.json','delivery-rework.json','zhiyan-delivery.json'}

STAGES={'design':('development','design','design-doc','design'),
        'coding':('development','coding','feature','feature'),
        'test-cases':('qa','testcase','testcase','testcase'),
        'functional-test':('qa','execution','execution','execution')}


def api_call(b,c,suffix,**body):
    return seat_api(b).request('POST','/agents/'+b.cfg['agent_id']+'/delivery-runs/'+c['runId']+'/'+suffix,{**identity(b),'lease':c['lease'],**body})


@contextlib.contextmanager
def domain_jira_environment(root):
    # Match native project/local Jira env discovery before Claude has loaded it.
    keys=('JIRA_BASE_URL','JIRA_PAT_TOKEN','HARNESS_MCP_CONFIG')
    prior={k:os.environ.get(k) for k in keys}
    try:
        for path in (root/'.claude/settings.json',root/'.claude/settings.local.json'):
            if path.is_file():
                env=read_json(path).get('env',{})
                for k in keys:
                    if isinstance(env.get(k),str):os.environ[k]=env[k]
        yield
    finally:
        for k,v in prior.items():
            if v is None:os.environ.pop(k,None)
            else:os.environ[k]=v


def verify_upstream_artifacts(upstream, guard):
    """Check pinned formal attachments again before a dependent run starts."""
    base, token = guard.credentials()
    origin = urllib.parse.urlsplit(base)
    opener = urllib.request.build_opener(guard.NoRedirect)
    for source in upstream:
        receipt = source.get('receipt')
        if source.get('executionMode')=='human':
            review=source.get('review') or {}
            if review.get('decision')!='approve':raise BridgeError('人工上游缺少正式完成结论')
            formal=urllib.parse.urlsplit(review.get('reference',''))
            if (formal.scheme,formal.netloc)!=(origin.scheme,origin.netloc) or formal.path!='/browse/'+str(source.get('jiraKey')):raise BridgeError('人工上游正式工单不属于当前 Jira 来源')
            # Human evidence remains an attributed attestation, never a device receipt.
        if not receipt:
            continue  # Analysis has its own publication/revision protocol.
        reference = urllib.parse.urlsplit(receipt['jiraReference'])
        if (reference.scheme,reference.netloc)!=(origin.scheme,origin.netloc) or reference.path!='/browse/'+receipt['jiraKey']:
            raise BridgeError('上游正式材料不属于当前 Jira 来源')
        linked = [artifact for artifact in receipt['artifacts'] if artifact.get('downloadUrl')]
        if not linked:
            raise BridgeError('上游材料只有指纹，缺少可回读的正式附件，请重新核验交付')
        for artifact in linked:
            url = urllib.parse.urlsplit(artifact['downloadUrl'])
            if (url.scheme,url.netloc)!=(origin.scheme,origin.netloc) or url.username or url.password or url.query or url.fragment or not re.fullmatch(r'/secure/attachment/\d+/[^/]+',url.path):
                raise BridgeError('上游附件引用无效')
            with opener.open(urllib.request.Request(url.geturl(),headers={'Authorization':'Bearer '+token}),timeout=30) as response:
                content = response.read(10*1024*1024+1)
            if not content or len(content)>10*1024*1024 or hashlib.sha256(content).hexdigest()!=artifact['sha256']:
                raise BridgeError('上游正式材料已变化，请重新核验当前交付版本')


def prepare(b,packet,folder):
    from harness_routing import resolve_route
    c={'runId':packet['runId'],'lease':packet['lease'],'executionRoute':packet['executionRoute'],'configPath':str(b.config_path)}
    c.update(api_call(b,c,'context'));s=c['stage']
    if s.get('executionMode')=='human':raise BridgeError('人工任务不能由席位执行通道代办')
    kind,role,workflow,prefix=STAGES[s['stage']]
    if s.get('intent')=='bugfix':kind,role,workflow,prefix=('development','coding','bugfix','bugfix')
    elif s.get('intent')=='code-review':kind,role,workflow,prefix=('development','code-review','code-review','review')
    elif s.get('intent')=='design-review':kind,role,workflow,prefix=('development','design-review','design-review','design-review')
    elif s.get('intent')=='test-case-review':kind,role,workflow,prefix=('qa','test-case-review','testcase-review','testcase-review')
    cap=resolve_route(b,c['executionRoute'],c['runId'],s['taskId'],kind)
    if role not in ('design','coding','code-review','design-review','test-case-review') and role not in ('testcase','execution'):raise BridgeError('无效的领域阶段')
    root=Path(cap['root'])
    guard=load_module('delivery_prepare_guard',root/'harness/scripts/issue_guard.py')
    state=Path(guard.execution_state_path(s['jiraKey'],workflow)) if callable(getattr(guard,'execution_state_path',None)) else root/'tickets'/(prefix+'-'+s['jiraKey'])/'state.json'
    ticket=state.parent
    if state.name!='state.json' or ticket.is_symlink() or state.is_symlink() or not state.resolve().is_relative_to(root.resolve()):raise BridgeError('工单目录不属于登记的 Harness')
    with domain_jira_environment(root):
        verified=guard.resolve(s['jiraKey'],role)  # Read-only real Jira type/child admission before model launch.
        if c.get('upstream'):verify_upstream_artifacts(c['upstream'],guard)
    if verified.get('status')!='ready' or verified.get('target',{}).get('父工单号')!=s.get('parentKey'):raise BridgeError('真实 Jira 子单父工单关系已变化，请重新同步核对条目')
    state=ticket/'state.json'
    # Do not relabel an old completed native task as a new platform execution.
    binding=ticket.parent/'.platform-delivery-bindings'/(s['taskId']+'.json')
    expected={'companyId':b.cfg['company_id'],'taskId':s['taskId'],'stage':s['stage'],'jiraKey':s['jiraKey'],'parentKey':s.get('parentKey')}
    if s.get('intent'):expected['intent']=s['intent']
    legacy_binding=root/'tickets/.platform-delivery-bindings'/(s['taskId']+'.json')
    if legacy_binding!=binding and legacy_binding.is_file():
        if read_json(legacy_binding)!=expected:raise BridgeError('历史原生平台绑定不匹配')
        if not binding.exists():atomic_json(binding,expected)
    if binding.is_file():
        if read_json(binding)!=expected:raise BridgeError('原生工单平台绑定已变化，不能复用历史材料')
    else:
        if state.is_file() and read_json(state).get('状态')=='completed':raise BridgeError('本机已有已完成原生任务，请核对正式交付，不能自动重新执行')
        atomic_json(binding,expected)
    if s.get('reworkHistory'):
        protocol=root/'harness/delivery-rework-protocol.json'
        contract=read_json(protocol) if protocol.is_file() else {}
        script=root/'harness/scripts/delivery_rework.py'
        if contract.get('version')!=1 or contract.get('metrics')!='preserve-source-and-generation' or contract.get('readOnlyVerification') is not True or not script.is_file() or not script.resolve().is_relative_to(root.resolve()):raise BridgeError('请更新原生 Harness，以支持保留知言统计的原生返工协议')
    c.update(root=str(root),ticketDirectory=str(ticket),statePath=str(state),role=role,workflow=workflow)
    atomic_json(folder/'delivery-context.json',c);return c


def context_from_env():
    c=read_json(Path(os.environ['DSP7_DELIVERY_CONTEXT']))
    if c['runId']!=os.environ.get('PAPERCLIP_RUN_ID') or c['stage']['taskId']!=os.environ.get('PAPERCLIP_TASK_ID'):raise BridgeError('交付上下文与真实运行不匹配')
    folder=Path(os.environ.get('DSP7_MANAGED_FOLDER',Path(os.environ['DSP7_DELIVERY_CONTEXT']).parent))
    return Bridge(Path(c['configPath'])),c,folder


def prompt(c):
    s=c['stage'];key=s['jiraKey']
    delegated=c.get('delegatedReviewKeys') or []
    review_instruction=('平台已将以下独立评审工单安排为本工作单交付后的后续节点：'+json.dumps(delegated,ensure_ascii=False)+'。本轮只交付当前工作单；保留当前工作单自身技术质量检查，但不得初始化、流转、上传、计时或上报这些独立评审单，不得代替后续评审人完成正式决策。原生关联评审单发现与范围记录可以保留；关联评审单交付与上报由后续独立节点负责。\n') if delegated else ''
    return ('当前目录是本机已登记的 '+('研发' if STAGES[s['stage']][0]=='development' else '测试')+' Harness。先读取 CLAUDE.md，加载真实工单类型对应的技能。\n'
      +review_instruction+'完成 '+key+' 工单。本阶段执行意图：'+c['role']+'；禁止处理主单或替代其他阶段的工单身份。修复与独立评审分别使用各自工单、原生流程和正式交付。\n'
      '评审退回与历轮证据（仅修改当前工单，逐条回应最新意见并记录修改说明）：'+json.dumps(s.get('reworkHistory'),ensure_ascii=False)+'\n'
      '若存在退回记录，必须先按原生 task_sync、issue_guard verify 绑定真实工单，再执行 python harness/scripts/delivery_rework.py --state '+shlex.quote(c['statePath'])+' --context \"$DSP7_DELIVERY_CONTEXT\"。通过当前 Harness 原生恢复／重开流程执行返工，重新完成所需门禁与正式交付；不得直接复用 completed 状态或旧附件。原生流程无法重开时提交 delivery-question.json 请求负责人处理，禁止手改状态绕过。\n'
      '本轮修复失败来源（按绑定版本定位，不新建重复缺陷、不跳过门禁）：'+json.dumps(s.get('repairFailure'),ensure_ascii=False)+'\n'
      '先按原生 task_sync 和 issue_guard 流程核验真实 Jira 身份，再按原生技能初始化或恢复 '+c['workflow']+' 工作流。原生工单目录：'+c['ticketDirectory']+'。已有状态必须恢复，不得覆盖或手改状态跳阶段。\n'
      '保持原生门禁、正式 Jira 评审和 Tracker 上报回读；完成后所有交付物按原生技能上传到当前 Jira 工单。不要调用旧版 pilot agent inspect/claim/complete；本次由条目交付专用许可管理。\n'
      '遇到需要人决定的问题，在工单目录写 delivery-question.json，结构为 {"text":"需要决定的具体问题"}，然后结束本轮输出，保持会话。网页答复只解决该问题，不能代替正式 Jira 审签或跳过原生门禁。\n'
      '解决问题后删除该问题文件。完成时不要自行生成平台回执或 /exit；Stop hook 将核验原生 completed、真实工单、Tracker 及 Jira 附件，再自动结束。\n'
      '需求分析正式交接（从已核验正式引用获取原件）：\n'+json.dumps(c.get('analysis'),ensure_ascii=False)+'\n上游交付索引（通过正式引用从 Jira 获取原件，不使用其他席位的本地路径）：\n'+json.dumps(c['upstream'],ensure_ascii=False)+'\n'
      '测试环境准入引用（执行前仍需按 Harness 核验访问和待测构建）：'+c['environmentReference'])


def artifact_index(folder):
    result=[]
    for p in sorted(folder.rglob('*')):
        if not p.is_file() or p.is_symlink() or not p.resolve().is_relative_to(folder.resolve()):continue
        if any(x.startswith('.') for x in p.relative_to(folder).parts) or p.name in ('delivery-question.json',):continue
        if p.suffix.lower() not in ('.md','.json','.docx','.xlsx','.pdf','.html','.txt','.csv'):continue
        if p.stat().st_size==0 or p.stat().st_size>10*1024*1024:continue
        result.append({'path':p.relative_to(folder).as_posix(),'sha256':hashlib.sha256(p.read_bytes()).hexdigest()})
        if len(result)>100:raise BridgeError('交付物过多，请核对工单目录')
    return result


def tracker_receipt(root,key,state):
    env={}
    for path in (root/'.mcp.json',root/'.claude/mcp.local.json'):
        if path.is_file():
            for name,v in read_json(path).get('mcpServers',{}).items():
                if 'tracker' in name.lower():env.update(v.get('env',{}))
    settings=root/'.claude/settings.local.json'
    if settings.is_file():env.update(read_json(settings).get('env',{}))
    env.update(os.environ)
    url=env.get('HARNESS_API_URL') or env.get('TRACKER_API_URL') or env.get('TRACKER_API')
    token=env.get('HARNESS_API_KEY') or env.get('TRACKER_API_KEY') or env.get('TRACKER_KEY')
    report=state.get('Harness上报') or {}
    project=report.get('项目ID') or env.get('TRACKER_PROJECT_ID') or env.get('HARNESS_PROJECT_ID')
    if not url or not project:raise BridgeError('缺少 Tracker 回读配置，不能推定交付完成')
    query=urllib.parse.urlencode({'projectId':project,'ticketNo':key})
    request=urllib.request.Request(url.rstrip('/')+'/tickets?'+query,headers={'X-API-Key':token} if token else {})
    with urllib.request.urlopen(request,timeout=20) as response:data=json.load(response)
    matches=[x for x in rows(data) if x.get('ticket_no')==key and str(x.get('project_id'))==str(project)]
    if len(matches)!=1 or not matches[0].get('id'):raise BridgeError('Tracker 工单与项目回读不匹配')
    if report and (report.get('状态')!='success' or str(report.get('回执ID'))!=str(matches[0]['id'])):raise BridgeError('原生上报与 Tracker 回执不匹配')
    verify_zhiyan_readback(Path(root),state,matches[0])
    return str(matches[0]['id'])


def verify_zhiyan_readback(root,state,remote):
    from datetime import datetime
    # A caller with a native path passes it explicitly through the execution context below.
    state_path=state.get('_paperclip_state_path')
    if not state_path:return
    folder=Path(state_path).parent;metadata=folder/'metrics-source.json'
    if not metadata.is_file():
        if state.get('类型') in ('design-review','testcase-review'):raise BridgeError('独立领域评审缺少知言统计归属')
        return
    meta=read_json(metadata)
    if meta.get('source')=='execution_time':return  # Preserve established legacy sources.
    if meta.get('source')!='zhiyan':raise BridgeError('未知统计来源，不能核验交付')
    if any(meta.get(k) for k in ('waiting','reset_pending','reset_requires_sync','reset_requires_start')):raise BridgeError('知言统计仍在等待或重置，不能核验交付')
    snapshot_path=folder/'zhiyan-snapshot.json'
    if not snapshot_path.is_file():raise BridgeError('缺少知言统计快照，请先完成原生上报')
    snapshot=read_json(snapshot_path)
    if not isinstance(snapshot.get('payload'),dict) or not snapshot['payload']:raise BridgeError('知言快照缺少实际统计字段')
    project='tracker:'+str(remote.get('project_id'))
    if (snapshot.get('source'),snapshot.get('project'),snapshot.get('ticket_no'))!=('zhiyan',project,state['工单号']) or (meta.get('project'),meta.get('ticket_no'))!=(project,state['工单号']):raise BridgeError('知言快照与当前工单/项目不匹配')
    if not snapshot.get('snapshot_id') or meta.get('acknowledged_snapshot_id')!=snapshot['snapshot_id'] or meta.get('pending_snapshot_id'):raise BridgeError('当前知言统计快照尚未上报回读确认')
    generation=snapshot.get('metrics_generation',0)
    if type(generation) is not int or generation<0 or generation!=meta.get('metrics_generation',0) or generation!=remote.get('metrics_generation',0):raise BridgeError('知言统计代次与 Tracker 不一致')
    def normalize(v):
        if isinstance(v,dict):return {k:normalize(x) for k,x in v.items()}
        if isinstance(v,list):return sorted([normalize(x) for x in v],key=lambda x:json.dumps(x,sort_keys=True))
        if isinstance(v,str):
            try:
                stamp=datetime.fromisoformat(v.replace('Z','+00:00'))
                if stamp.tzinfo:return stamp.replace(microsecond=stamp.microsecond//1000*1000).timestamp()
            except ValueError:pass
        return v
    metrics=dict(snapshot.get('payload') or {});metrics.pop('harness_blocked_minutes',None)
    if snapshot.get('coverage',{}).get('timing')=='complete' and 'human_wait_minutes' in snapshot.get('diagnostics',{}):metrics['harness_blocked_minutes']=snapshot['diagnostics']['human_wait_minutes']
    for key,value in metrics.items():
        actual=remote.get(key)
        if isinstance(actual,str) and isinstance(value,(dict,list)):actual=json.loads(actual)
        if normalize(actual)!=normalize(value):raise BridgeError('Tracker 知言统计回读不一致：'+key)


def verify_jira_confirmation(root, key, state, base, token, opener):
    """Re-resolve the native confirmation on a private copy, never mutate its state.

    The registered Harness owns comment identity and decision semantics. A local
    approved flag alone is insufficient, including when a comment was edited,
    removed, or superseded after the native helper last read it.
    """
    current = (state.get('Jira确认') or {}).get('当前')
    if not current:
        return
    if current.get('状态') != 'approved' or not isinstance(current.get('回复'), dict):
        raise BridgeError('正式 Jira 确认缺少已核验回复')
    native = load_module('delivery_confirmation', root/'harness/scripts/jira_confirmation.py')
    comments = []
    total = None
    for start in range(0, 1000, 100):
        url = base.rstrip('/')+'/rest/api/2/issue/'+key+'/comment?'+urllib.parse.urlencode({'startAt':start,'maxResults':100})
        with opener.open(urllib.request.Request(url,headers={'Authorization':'Bearer '+token,'Accept':'application/json'}),timeout=15) as response:
            raw = response.read(2_000_001)
        if len(raw)>2_000_000:
            raise BridgeError('正式 Jira 确认响应过大')
        page = json.loads(raw)
        count = page.get('total')
        batch = page.get('comments')
        if type(count) is not int or not 0<=count<=1000 or page.get('startAt')!=start or not isinstance(batch,list) or any(not isinstance(item,dict) for item in batch) or (total is not None and total!=count):
            raise BridgeError('正式 Jira 确认分页不完整')
        total = count
        comments.extend(batch)
        if len(comments)==total:
            break
        if len(batch)!=100 or len(comments)>total:
            raise BridgeError('正式 Jira 确认分页不完整')
    else:
        raise BridgeError('正式 Jira 确认超过读取上限')
    import copy
    import tempfile
    probe = copy.deepcopy(state)
    probe['Jira确认']['当前']['状态'] = 'pending'
    # Native resolution writes progress; confine those writes to a disposable copy.
    with tempfile.TemporaryDirectory(prefix='paperclip-confirmation-') as temporary:
        candidate = Path(temporary)/'state.json'
        atomic_json(candidate,probe)
        status, resolved = native.resolve_confirmation(candidate,probe,comments)
    original_reply = current['回复']
    reply = (resolved or {}).get('回复') or {}
    fields = ('评论ID','原文','评论时间','评论人')
    if status!='approved' or any(not original_reply.get(field) or original_reply.get(field)!=reply.get(field) for field in fields):
        raise BridgeError('正式 Jira 结论已变化或无法回读，请重新完成原生确认')


def collect_test_results(state, folder, artifacts):
    evidence = state.get('证据') or {}
    names = {'total':'用例总数','passed':'通过数','failed':'失败数','blocked':'阻塞数','skipped':'跳过数'}
    counts = {key:evidence.get(name) for key,name in names.items()}
    if any(type(value) is not int or not 0<=value<=1_000_000 for value in counts.values()) or counts['total']<=0 or sum(counts[key] for key in ('passed','failed','blocked','skipped'))!=counts['total']:
        raise BridgeError('功能测试结果缺失或计数无法对账，不能把报告完成当作测试通过')
    version = (state.get('环境信息') or {}).get('被测版本')
    if not isinstance(version,str) or not version.strip() or len(version.strip())>500:
        raise BridgeError('功能测试缺少明确被测版本')
    source = next((artifact for artifact in artifacts if artifact['path']=='execution-records.md'),None)
    if not source:
        raise BridgeError('功能测试缺少逐条执行记录')
    # Read the native table contract; compare its rows with native state counters.
    record_bytes = (folder/'execution-records.md').read_bytes()
    if hashlib.sha256(record_bytes).hexdigest()!=source['sha256']:
        raise BridgeError('功能测试逐条记录已变化')
    rows = []
    result_column = None
    id_column = None
    for line in record_bytes.decode('utf-8').splitlines():
        if not line.strip().startswith('|'):continue
        cells = [cell.strip() for cell in line.strip().strip('|').split('|')]
        if '用例ID' in cells and '结果' in cells:
            id_column, result_column = cells.index('用例ID'), cells.index('结果')
            continue
        if result_column is None or len(cells)<=max(id_column,result_column):continue
        if re.fullmatch(r':?-+:?',cells[result_column]):continue
        if cells[result_column] not in ('Passed','Failed','Blocked','Skipped') or not cells[id_column]:
            raise BridgeError('功能测试逐条记录结果不明确')
        rows.append((cells[id_column],cells[result_column]))
    if len(rows)!=counts['total'] or len({row[0] for row in rows})!=len(rows) or any(sum(row[1]==label for row in rows)!=counts[key] for key,label in (('passed','Passed'),('failed','Failed'),('blocked','Blocked'),('skipped','Skipped'))):
        raise BridgeError('功能测试逐条记录与汇总不一致')
    return {**counts,'testedVersion':version.strip(),'sourcePath':source['path'],'sourceSha256':source['sha256']}


def collect_receipt(b,c):
    root=Path(c['root']);folder=Path(c['ticketDirectory']);path=Path(c['statePath'])
    if not path.is_file():return None
    before=path.read_bytes();state=json.loads(before)
    if state.get('工单号')!=c['stage']['jiraKey']:raise BridgeError('原生状态工单身份不匹配')
    previous=[r['previous']['receipt'] for r in c['stage'].get('reworkHistory',[]) if r.get('previous',{}).get('receipt')]
    if any(hashlib.sha256(before).hexdigest()==r.get('stateDigest') for r in previous):return None
    if c['stage'].get('parentKey') and state.get('父工单号')!=c['stage']['parentKey']:raise BridgeError('原生状态父工单身份不匹配')
    if state.get('状态')!='completed':return None
    confirmation=(state.get('Jira确认') or {}).get('当前')
    if confirmation and confirmation.get('状态')!='approved':raise BridgeError('仍有待确认的正式 Jira 门禁')
    # Native identity verification also enforces the Harness task-sync admission.
    contract=read_json(root/'harness/delivery-rework-protocol.json') if (root/'harness/delivery-rework-protocol.json').is_file() else {}
    readonly=['--read-only'] if contract.get('readOnlyVerification') is True else []
    result=subprocess.run([sys.executable,str(root/'harness/scripts/issue_guard.py'),'verify','--state',str(path),*readonly],cwd=root,env={**os.environ,'HARNESS_SESSION_ID':c['runId'],'HARNESS_TASK_ID':c['stage']['jiraKey']},capture_output=True,timeout=30)
    if result.returncode:raise BridgeError('原生工单核验未通过，请检查本机 issue_guard 与 task_sync')
    after=path.read_bytes()
    if after!=before:
        updated=json.loads(after)
        if {k:v for k,v in updated.items() if k!='工单身份'}!={k:v for k,v in state.items() if k!='工单身份'}:raise BridgeError('身份核验期间业务状态变化，请重新核验')
        if readonly:raise BridgeError('原生只读身份核验改写了账本，请修复 Harness')
        before=after;state=updated
    if previous and state.get('平台交付派发')!=c['stage'].get('dispatchId'):raise BridgeError('请先执行当前派发的原生返工重开，不能复用旧完成状态')
    phase=state.get('Phase状态') or state.get('阶段状态') or {}
    if not phase or any(isinstance(v,dict) and v.get('状态') in ('pending','in-progress','blocked','failed') for v in phase.values()):raise BridgeError('原生阶段仍有未完成门禁')
    receipt=tracker_receipt(root,c['stage']['jiraKey'],{**state,'_paperclip_state_path':str(path)})
    artifacts=artifact_index(folder)
    if not artifacts:raise BridgeError('缺少非空交付物')
    if previous and not any(Path(a['path']).name not in METRICS_ARTIFACTS and not any(old['path']==a['path'] and old['sha256']==a['sha256'] for r in previous for old in r['artifacts']) for a in artifacts):return None
    # Use credentials from this registered domain, not another seat or arbitrary server URL.
    guard=load_module('delivery_issue_guard_'+c['stage']['stage'].replace('-','_'),root/'harness/scripts/issue_guard.py')
    base,token=guard.credentials()
    issue_url=base.rstrip('/')+'/rest/api/2/issue/'+c['stage']['jiraKey']+'?fields=attachment'
    opener=urllib.request.build_opener(guard.NoRedirect)
    verify_jira_confirmation(root,c['stage']['jiraKey'],state,base,token,opener)
    with opener.open(urllib.request.Request(issue_url,headers={'Authorization':'Bearer '+token}),timeout=20) as response:issue=json.load(response)
    matched=False;digests={a['sha256'] for a in artifacts}
    for a in issue.get('fields',{}).get('attachment',[]):
        url=urllib.parse.urlparse(a.get('content',''));origin=urllib.parse.urlparse(base)
        if (url.scheme,url.netloc)!=(origin.scheme,origin.netloc) or not 0<int(a.get('size',0))<=10*1024*1024:continue
        with opener.open(urllib.request.Request(url.geturl(),headers={'Authorization':'Bearer '+token}),timeout=30) as response:content=response.read(10*1024*1024+1)
        digest=hashlib.sha256(content).hexdigest()
        if digest in digests:
            matched=True
            if re.fullmatch(r'/secure/attachment/\d+/[^/]+',url.path) and not url.query and not url.fragment and not url.username and not url.password:
                for artifact in artifacts:
                    if artifact['sha256']==digest:artifact['downloadUrl']=url.geturl()
    if not matched:raise BridgeError('Jira 尚无与本次本地交付物指纹相同的附件，请上传交付物后重试')
    if path.read_bytes()!=before or artifact_index(folder)!=[{k:v for k,v in artifact.items() if k!='downloadUrl'} for artifact in artifacts]:raise BridgeError('核验期间交付物变化，请重新核验')
    s=c['stage']
    test_results = collect_test_results(state,folder,artifacts) if s['stage']=='functional-test' else None
    code_review = None
    domain_review = None
    if s.get('intent') in ('code-review','design-review','test-case-review'):
        source = next((artifact for artifact in artifacts if artifact['path']==state.get('报告路径')),None)
        if state.get('评审结果')!='passed' or state.get('交付状态')!='completed' or state.get('完成状态已核验') is not True or not state.get('被审版本') or not source:
            raise BridgeError('独立评审未通过或缺少被审版本、正式完成核验及报告')
        if s.get('intent') in ('design-review','test-case-review') and state['被审版本']!={'inputDigest':s['inputDigest'],'workKeys':s.get('reviewWorkKeys')}:raise BridgeError('领域评审的被审输入或工作单范围与当前派发不匹配')
        version = json.dumps(state['被审版本'],ensure_ascii=False,sort_keys=True,separators=(',',':')).encode()
        evidence = {'decision':'passed','reviewedVersionDigest':hashlib.sha256(version).hexdigest(),'sourcePath':source['path'],'sourceSha256':source['sha256']}
        if s.get('intent')=='code-review':code_review=evidence
        else:domain_review=evidence
    return {**({'domainReview':domain_review} if domain_review else {}),**({'testResults':test_results} if test_results else {}),**({'codeReview':code_review} if code_review else {}),'protocolVersion':1,'taskId':s['taskId'],'runId':c['runId'],'stage':s['stage'],'jiraKey':s['jiraKey'],'inputDigest':s['inputDigest'],'stateDigest':hashlib.sha256(before).hexdigest(),'trackerReceiptId':receipt,'jiraReference':base.rstrip('/')+'/browse/'+s['jiraKey'],'artifacts':artifacts}


def stop_hook(timeout=3600):
    b,c,folder=context_from_env();deadline=time.monotonic()+timeout
    while time.monotonic()<deadline:
        r=None
        try:r=collect_receipt(b,c)
        except Exception:
            # Keep raw HTTP bodies/credentials local and out of platform observations.
            api_call(b,c,'observe',observation={'waiting':True,'message':'原生交付核验未通过，请核对本机 issue_guard、Tracker 和 Jira 附件。'})
            question=Path(c['ticketDirectory'])/'delivery-question.json'
            if not question.is_file():atomic_json(question,{'text':'原生交付核验未通过：请核对本机 issue_guard、Tracker 回执和 Jira 附件。处理后答复以继续核验，不要伪造状态。'})
        if r:
            api_call(b,c,'delivery',receipt=r);atomic_json(folder/'delivery-completion.json',{'runId':c['runId']});return {}
        question=Path(c['ticketDirectory'])/'delivery-question.json'
        if not question.is_file():
            api_call(b,c,'observe',observation={'waiting':False,'message':'原生 Harness 执行中，尚未达到交付门禁'})
            return {'decision':'block','reason':'当前原生 Harness 任务尚未交付，请按 CLAUDE.md 与原生技能继续完成当前工单。若确实需要人工决定，请写 delivery-question.json 并结束本轮输出等待真实答复；不得自行批准正式门禁。'}
        text=str(read_json(question).get('text','')).strip()
        if not text:raise BridgeError('人工问题不能为空')
        digest=hashlib.sha256(question.read_bytes()).hexdigest()
        response=api_call(b,c,'question',text=text[:4000],digest=digest)
        prior=read_json(folder/'wait.json') if (folder/'wait.json').is_file() else {}
        atomic_json(folder/'wait.json',{'status':'waiting_confirmation','waitingSince':prior.get('waitingSince',time.time()) if prior.get('decisionDigest')==digest else time.time(),'decisionDigest':digest})
        if response.get('answer'):
            atomic_json(folder/'wait.json',{'status':'resuming'})
            return {'decision':'block','reason':'当前版本真实人工答复：'+response['answer']+'。请处理问题后删除 delivery-question.json，再按原生门禁继续。此答复不能代替正式审签。'}
        time.sleep(2)
    return {}

if __name__=='__main__':
    try:print(json.dumps(stop_hook(),ensure_ascii=False),flush=True)
    except (Exception,KeyboardInterrupt):
        print('条目交付通道未完成，请检查本机日志和网页状态；未授予继续或完成。',file=sys.stderr)
        print('{}',flush=True)
