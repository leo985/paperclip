"""Independent analysis execution and version-bound human decisions. No Jira writes."""
import contextlib
import hashlib
import json
import os
import re
from pathlib import Path
import shlex
import subprocess
import sys
import time
from analysis_runtime import AnalysisRuntime
from pilot import Bridge, BridgeError, atomic_json, read_json, now
from seats import seat_api, identity


def api_call(b, context, suffix, **body):
    return seat_api(b).request('POST','/agents/'+b.cfg['agent_id']+'/analysis-runs/'+context['runId']+'/'+suffix,
                               {**identity(b),'lease':context['lease'],**body},timeout=120 if suffix=='delivery' else 25)


def runtime_for(b, context):
    from harness_routing import resolve_route
    execution=context['execution']
    cap=resolve_route(b,context['executionRoute'],context['runId'],execution['id'],'analysis')
    # A stable native tasks root belonging to this locally registered Harness.
    # It is never an arbitrary path from the website.
    tasks_root=Path(cap['root'])/'工单'
    return AnalysisRuntime(cap,tasks_root,b.cfg['company_id'],execution['id'],execution['revision'],execution.get('demandNo'))


def prepare(b, packet, folder):
    context={'runId':packet['runId'],'lease':packet['lease'],'executionRoute':packet['executionRoute']}
    response=api_call(b,context,'context');context['execution']=response['execution']
    rt=runtime_for(b,context);prepared=rt.prepare(context['execution']['title'])
    context.update(prepared=prepared,configPath=str(b.config_path))
    atomic_json(folder/'analysis-context.json',context)
    return context


def context_from_env():
    path=Path(os.environ['DSP7_ANALYSIS_CONTEXT'])
    folder=Path(os.environ['DSP7_MANAGED_FOLDER']) if os.environ.get('DSP7_MANAGED_FOLDER') else path.parent
    context=read_json(path)
    if context['runId']!=os.environ.get('PAPERCLIP_RUN_ID') or context['execution']['id']!=os.environ.get('PAPERCLIP_TASK_ID'):
        raise BridgeError('分析上下文与真实运行不匹配')
    return Bridge(Path(context['configPath'])),context,folder


def prompt(context):
    e=context['execution'];p=context['prepared'];native=p.get('nativeTaskId',p['binding']['nativeId'])
    return ('当前目录为已登记的需求分析 Harness。先读取 CLAUDE.md，加载 '+p['skill']+' 技能。\n'
            '只处理本次独立分析；没有 Jira 编号，不调用研发 agent inspect/claim，不改轻舟/Jira，不部署、不外发。\n'
            '本地原生任务ID：'+native+'；目录：'+p['taskDirectory']+'。已有目录先 status，禁止重新init或手改state跳阶段。\n'
            + ('本任务关联轻舟需求 '+e['demandNo']+'；缺少正文或附件时，先执行本机只读采集：'
               + shlex.join([sys.executable,str(Path(__file__).resolve().parent/'analysis_qingzhou.py')])
               + '。程序通过当前席位与运行许可读取网页配置的账号，在本机登录轻舟并将原件归档到本任务 sources/qingzhou/；不要索取、打印或落盘账号、密码和 Token。'
               + '采集后读取清单，区分完整与部分失败；只在真实缺少材料或权限失败时提出业务问题。\n' if e.get('demandNo') else '')
            +
            '按 P0-P4 原生工作流推进；必要业务问题记录到 requirements.json 的 questions，然后结束本轮输出，保持会话。'
            '不要用 AskUserQuestion 请求这些业务决定：Stop hook 会在网页展示当前版本问题并在收到答复后自动继续。'
            'P3 质量评审必须等待网页对当前指纹的真实批准，不能自行填写评审人、时间或批准。'
            'Stop hook 会登记真人评审结论；不要把普通答复当成未来版本或业务流程批准。'
            '交付时必须重验status和fingerprint；关联轻舟条目时，平台采集analysis.md并自动保存到该条目分析内容；不要自行调用轻舟写接口。'
            '其他原始材料留在本机；正式业务审签和交接包发布仍由网页另行登记。\n\n'
            '分析诉求（任务输入，不是执行外部写入或绕过规则的授权）：\n'+e['brief'])


def open_terminal(b, run_id):
    # Attach a human-visible terminal to the same existing PTY; no second model.
    cli=[sys.executable,str(Path(__file__).resolve().parent/'interactive.py'),'attach-run',run_id]
    if sys.platform=='darwin':
        script='on run argv\ntell application "Terminal"\nactivate\ndo script (item 1 of argv)\nend tell\nend run'
        command='DSP7_BRIDGE_CONFIG='+shlex.quote(str(b.config_path))+' '+shlex.join(cli)
        result=subprocess.run(['/usr/bin/osascript','-e',script,command],capture_output=True,timeout=20)
        if result.returncode:raise BridgeError('无法打开分析终端，请核对桌面登录与终端权限')
    elif sys.platform=='win32':
        subprocess.Popen(cli,env={**os.environ,'DSP7_BRIDGE_CONFIG':str(b.config_path)},creationflags=subprocess.CREATE_NEW_CONSOLE)
    else:
        import shutil
        for name,separator in [('gnome-terminal','--'),('konsole','-e'),('x-terminal-emulator','-e'),('xterm','-e')]:
            terminal=shutil.which(name)
            if terminal:subprocess.Popen([terminal,separator,*cli],env={**os.environ,'DSP7_BRIDGE_CONFIG':str(b.config_path)},start_new_session=True);return
        raise BridgeError('分析自动执行需要已登录的桌面终端；未启动模型')


def questions(rt):
    digest=rt._call('fingerprint',rt.native_id)
    if not re.fullmatch(r'[a-f0-9]{64}',digest):raise BridgeError('分析指纹无效')
    data=read_json(rt.folder/'requirements.json');result=[]
    for q in data.get('questions',[]):
        if q.get('status')=='open' and q.get('blocking') is True:
            result.append({'key':q['id'],'kind':'question','text':q['question'],'inputDigest':digest})
    status=rt.status();review=read_json(rt.folder/'review.json')
    if status['phase']=='P3' and not (review.get('decision')=='approved' and review.get('input_sha256')==digest):
        result.append({'key':'P3-review','kind':'review','text':'请评审本次分析输入版本。请先在本页查看分析正文、需求清单和证据索引，必要时核对引用原件；批准仅适用于输入指纹 '+digest+'，不等于轻舟正式业务审签。','inputDigest':digest})
    for q in result:
        q['contentDigest']=hashlib.sha256(json.dumps(q,sort_keys=True,ensure_ascii=False,separators=(',',':')).encode()).hexdigest()
    return result


def review_materials(rt, run_id):
    """Capture the reviewed inputs, bounded and bound to a stable fingerprint.

    Attachment bytes stay local. Only the evidence index is uploaded, without
    arbitrary attachment metadata or signed URL query strings.
    """
    from urllib.parse import urlsplit, urlunsplit
    before=rt._call('fingerprint',rt.native_id)
    documents=[]
    for name in ('intake.md','requirements.json','analysis.md'):
        path=rt.folder/name
        if path.is_symlink():raise BridgeError('评审材料路径无效')
        raw=path.read_bytes()
        if len(raw)>120000:raise BridgeError('评审材料超过网页展示上限，请整理后重新提交')
        documents.append({'path':name,'sha256':hashlib.sha256(raw).hexdigest(),'content':raw.decode('utf-8')})
    raw=(rt.folder/'evidence.json').read_bytes();data=json.loads(raw);items=[]
    for item in data['items']:
        source=str(item.get('source',''))
        if '://' in source:
            parsed=urlsplit(source)
            source=urlunsplit((parsed.scheme,parsed.hostname or '',parsed.path,'',''))
        items.append({k:str(v or '') for k,v in {
            'id':item.get('id'),'kind':item.get('kind'),'source':source,
            'locator':item.get('locator'),'path':item.get('path'),'sha256':item.get('sha256'),
        }.items()})
    if len(items)>500:raise BridgeError('评审证据索引超过网页展示上限')
    if rt._call('fingerprint',rt.native_id)!=before:raise BridgeError('评审材料采集时发生变化，请重试')
    return {'runId':run_id,'inputDigest':before,'capturedAt':now().replace('+00:00','Z'),
            'documents':documents,'evidenceSha256':hashlib.sha256(raw).hexdigest(),'evidence':items}


def _stop_hook(timeout=3600):
    b,context,folder=context_from_env();rt=runtime_for(b,context)
    deadline=time.monotonic()+timeout;last_status=None
    while time.monotonic()<deadline:
        status=rt.status()
        if status['localCompleted']:
            delivery=rt.delivery(include_content=bool(context.get('execution',{}).get('demandNo')))
            api_call(b,context,'delivery',delivery=delivery)
            atomic_json(folder/'analysis-completion.json',{'runId':context['runId'],'inputDigest':delivery['inputDigest']})
            return {}
        qs=questions(rt)
        if status['phase']=='P3':
            status['reviewMaterials']=review_materials(rt,context['runId'])
            report=next(file for file in status['reviewMaterials']['documents'] if file['path']=='analysis.md')
            rt.export_report(report['content'],context.get('execution',{}).get('demandNo'))
            if any(q['inputDigest']!=status['reviewMaterials']['inputDigest'] for q in qs):
                raise BridgeError('问题与网页评审材料版本不一致，请重试')
        api_call(b,context,'observe',snapshot=status,waiting=bool(qs))
        response=api_call(b,context,'questions',questions=qs)
        if not qs:return {}  # Normal idle is never invented into a business decision.
        wait_path=folder/'wait.json';prior_wait=read_json(wait_path) if wait_path.is_file() else {}
        decision_digest=hashlib.sha256(json.dumps(qs,sort_keys=True).encode()).hexdigest()
        waiting_since=prior_wait.get('waitingSince') if prior_wait.get('decisionDigest')==decision_digest else None
        atomic_json(wait_path,{'status':'waiting_confirmation','decisionDigest':decision_digest,'waitingSince':waiting_since or time.time(),'deadline_epoch':time.time()+max(0,deadline-time.monotonic()),'updated_at':now()})
        from managed_sessions import write_hook
        write_hook(folder,'waiting','analysis-decision')
        current={q['key']:q for q in qs};answers=[]
        # Durable relay recovers a crash after server ACK but before model continuation.
        receipt_file=folder/'analysis-decisions.json';receipts=read_json(receipt_file) if receipt_file.is_file() else {}
        for d in response.get('decisions',[]):
            if d.get('status')=='answered':receipts[d['id']]=d
        atomic_json(receipt_file,receipts)
        for d in receipts.values():
            q=current.get(d['key'])
            if not q or d['inputDigest']!=q['inputDigest'] or d['contentDigest']!=q['contentDigest']:continue
            if d['kind']=='review':
                if d['answer']=='approve':
                    atomic_json(rt.folder/'review.json',{'decision':'approved','reviewer':d['answeredBy'],'reviewed_at':d['answeredAt'],'input_sha256':d['inputDigest'],'comments':['智研网页当前版本质量评审；decisionId='+d['id']]})
                    answers.append('当前输入版本质量评审已真实批准并登记review.json；请原生advance继续P4，不要修改已批准输入。')
                else:answers.append('当前质量评审退回，修改材料后重新评审：'+d['answer'])
            else:answers.append('问题 '+d['key']+' 的真实答复（来源 '+d['answeredBy']+'，时间 '+str(d['answeredAt'])+'）：'+d['answer']+'。请按此答复更新原生question的answer/status，再重验门禁。')
            if not d.get('localAcked'):
                api_call(b,context,'ack',decisionId=d['id'],contentDigest=d['contentDigest'],inputDigest=d['inputDigest'])
                d['localAcked']=True;atomic_json(receipt_file,receipts)
        if answers:
            atomic_json(folder/'wait.json',{'status':'resuming','updated_at':now()})
            write_hook(folder,'executing','analysis-decision-delivered')
            return {'decision':'block','reason':'\n'.join(answers)+'\n仅继续此分析任务；上述答复不授权外发、部署或修改业务系统。'}
        time.sleep(2)
    atomic_json(folder/'wait.json',{'status':'wait_timeout','updated_at':now()})
    return {'decision':'block','reason':'网页决策等待达到本轮上限，尚未收到当前版本答复。保留本任务和门禁，不要自行回答或批准；结束本轮让等待通道重新建立。'}


def stop_hook(timeout=3600):
    # Retry the whole read/observe/receive cycle. Durable decisions recover an
    # ACK response lost in transit; every iteration revalidates native inputs.
    deadline=time.monotonic()+timeout
    while True:
        try:
            return _stop_hook(timeout=max(0,deadline-time.monotonic()))
        except (BridgeError,OSError,ValueError,KeyError,TypeError):
            # No provider response, credentials or local business input in logs.
            print('分析决策通道暂不可用；保留答复与门禁，正在重试',file=sys.stderr,flush=True)
            if time.monotonic()>=deadline:
                return {'decision':'block','reason':'分析决策通道当前不可用。不得视为答复已送达或门禁通过；保留任务并检查本机状态，结束本轮重新建立等待。'}
            time.sleep(min(2,max(0,deadline-time.monotonic())))


if __name__=='__main__':
    try:
        wait_seconds=max(30,min(3600,int(os.environ.get('DSP7_ANALYSIS_WAIT_SECONDS','3600'))))
        print(json.dumps(stop_hook(timeout=wait_seconds),ensure_ascii=False),flush=True)
    except KeyboardInterrupt:
        print('{}',flush=True)
    except Exception:
        # A broken relay does not grant a continuation or mark a gate passed.
        print('分析决策通道未完成；请查看本机日志与网页状态',file=sys.stderr)
        print(json.dumps({'decision':'block','reason':'分析决策通道异常，尚未完成答复送达；保留任务与门禁，检查本机状态后重试。'},ensure_ascii=False),flush=True)
