"""Board-created Jira intake requests, processed only on the configured Mac."""
from platform_support import fcntl
import hashlib
import json
import os
import tempfile
from pathlib import Path
import re
import subprocess
import sqlite3
import urllib.parse

PREFIX = 'DSP7-JIRA-INTAKE'


def git(repo, *args):
    from platform_support import WINDOWS, terminate_tree
    env = dict(os.environ, GIT_TERMINAL_PROMPT='0', GCM_INTERACTIVE='never')
    # Git for Windows launches a shim and descendant Git processes. Killing
    # only the shim leaves inherited PIPE handles open and communicate() can
    # then wait forever, starving the seat heartbeat. File-backed output and
    # whole-tree termination keep timeout handling bounded.
    with tempfile.TemporaryFile(mode='w+b') as out, tempfile.TemporaryFile(mode='w+b') as err:
        child = subprocess.Popen(['git', '-C', str(repo), *args], stdin=subprocess.DEVNULL,
                                 stdout=out, stderr=err, env=env,
                                 **({'creationflags': subprocess.CREATE_NO_WINDOW} if WINDOWS else {'start_new_session': True}))
        try:
            child.wait(timeout=90)
        except subprocess.TimeoutExpired:
            terminate_tree(child)
            raise ValueError('Git 操作超时，已停止本次 Git 子进程；请检查仓库、磁盘或 Git 认证后在网页重试') from None
        out.seek(0); err.seek(0)
        output = out.read(1024*1024).decode('utf-8', errors='replace')
        error = err.read(8192).decode('utf-8', errors='replace')
        if child.returncode:
            raise ValueError('Git 操作失败：'+error.strip()[:500])
        return output.strip()




def manual_rule(b,request,issue=None,allow_paused=False):
    """Use current saved seat scope without granting automatic execution."""
    from pilot import BridgeError
    from jira_dispatch import rule_for
    rule=rule_for(b)
    if not rule or not rule.get('jiraPatConfigured') or not rule.get('readyStatuses'):
        raise BridgeError('请先在席位接单设置中配置 Jira PAT 和允许开工状态')
    if rule.get('intakePaused') and not allow_paused:raise BridgeError('席位已暂停接单，请先恢复接单')
    if not request['jira_key'].startswith(rule['jiraProjectKey']+'-'):
        raise BridgeError('工单所属 Jira 项目与席位规则不匹配；当前席位只接入 '+rule['jiraProjectKey']+' 项目')
    if request['project_id']!=rule['projectId']:
        raise BridgeError('所选项目与席位接单设置不一致')
    if issue is not None:
        f=issue['fields']
        if (f['status'].get('statusCategory') or {}).get('key')=='done':raise BridgeError('已完成工单不能接入真实开发')
        if f['status']['name'] not in rule['readyStatuses']:
            raise BridgeError('Jira 当前状态“'+f['status']['name']+'”不在席位允许状态内：'+'、'.join(rule['readyStatuses']))
        if f['issuetype']['name'] not in rule['issueTypes']:raise BridgeError('当前工单类型“'+f['issuetype']['name']+'”不在席位接单范围内')
    return rule


def process_requests(b):
    from seat_lifecycle import offline_requested
    if offline_requested(b):return
    from pilot import BridgeError, TYPE_WORKFLOW, rows, now, read_json
    from seats import identity, reserve, verify_runtime
    if not b.cfg.get('web_jira_intake_enabled'): return
    local=identity(b)
    b.db.execute('''CREATE TABLE IF NOT EXISTS intake_jobs (
        task_id TEXT PRIMARY KEY, request_hash TEXT NOT NULL, status TEXT NOT NULL,
        data TEXT NOT NULL, updated_at TEXT NOT NULL)''')
    from platform_support import private_directory
    folder=private_directory(Path(b.cfg['database']).parent/'intake')
    with (folder/'worker.lock').open('a') as lock:
        try: fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
        except BlockingIOError:return
        requests=rows(b.pc.request('GET','/companies/'+b.cfg['company_id']+'/issues?'+urllib.parse.urlencode({'q':'Jira 接入申请','status':'backlog'})))
        for task in sorted(requests,key=lambda item:item.get('createdAt','')):
            raw=re.search(r'<!-- '+PREFIX+r' (.*?) -->',str(task.get('description') or ''))
            if not raw or task.get('status')!='backlog':continue
            try:request=json.loads(raw.group(1))
            except (ValueError,TypeError):continue  # Cannot determine a trusted destination.
            if not isinstance(request,dict) or request.get('version') not in (2,3,4) or request.get('seat_id')!=local['seat_id']:continue
            auto_rule=None
            job=b.db.execute('SELECT * FROM intake_jobs WHERE task_id=?',(task['id'],)).fetchone()
            try:
                verify_runtime(b)
                request_hash=hashlib.sha256(raw.group(1).encode()).hexdigest()
                auto_rule=None
                if task['id'] in b.cfg.get('_platform_dispatches',{}):
                    # The server validates current administrator/owner authority,
                    # the exact request and the saved seat scope. Local owner lists
                    # must not reject a valid administrator-issued dispatch.
                    from jira_dispatch import verify
                    auto_rule=verify(b,task['id'],start=True)
                elif task.get('createdByAgentId')==b.cfg['agent_id']:
                    from jira_dispatch import verify
                    auto_rule=verify(b,task['id'])
                    if auto_rule.get('intakePaused'):continue
                    verify(b,task['id'],start=True)
                else:
                    # Persisted owner/admin authority is checked by the server;
                    # local enrollment-time user lists may be stale.
                    from seats import seat_api
                    seat_api(b).request('POST','/agents/'+b.cfg['agent_id']+'/dsp7-jira-intake/authorize',{**local,'taskId':task['id']})
                if task.get('assigneeAgentId') or task.get('assigneeUserId'):raise ValueError('接入申请不得提前分派执行者')

                if request.get('version') not in (2,3,4) or request.get('project_id')!=task.get('projectId'):raise ValueError('申请版本或 Project 不匹配')
                for field in ('project_id',):
                    if not isinstance(request.get(field),str) or not re.fullmatch(r'[0-9a-fA-F]{8}-(?:[0-9a-fA-F]{4}-){3}[0-9a-fA-F]{12}',request[field]):raise ValueError('Project 编号无效')
                key=request.get('jira_key','')
                if not re.fullmatch(r'[A-Z][A-Z0-9_]*-\d+',key):raise ValueError('Jira 工单号无效')
                uses_seat_rule=request['version'] in (3,4)
                if uses_seat_rule and (request.get('status_source')!='seat_rule' or task.get('createdByAgentId')):raise ValueError('席位规则接入申请无效')
                rule=manual_rule(b,request) if uses_seat_rule else None
                status=request.get('ready_status','')
                if not uses_seat_rule and (not isinstance(status,str) or not status.strip() or len(status)>100):raise ValueError('请指定允许执行的 Jira 状态')
                if job and job['request_hash']!=request_hash:raise ValueError('已处理申请不能修改；请提交新的申请')
                existing=b.db.execute('SELECT task_id,config FROM pilots WHERE jira_key=?',(key,)).fetchone()
                if existing:
                    d=json.loads(existing['config'])
                    if existing['task_id']!=task['id'] or d.get('intake_task_id')!=task['id']:raise ValueError('该 Jira 已登记到另一任务，不能重复登记')
                    if uses_seat_rule:manual_rule(b,request,b.jira_issue(key))
                    reserve(b,task['id'])
                    finish(b,task,request,d)
                    continue
                if job and job['status']=='ready':continue
                if b.db.execute('SELECT count(*) FROM pilots WHERE enabled=1').fetchone()[0]:continue # Keep queued intake untouched while the seat is busy.
                project=b.pc.request('GET','/projects/'+request['project_id'])
                if project.get('companyId')!=b.cfg['company_id'] or project.get('archivedAt'):raise ValueError('Project 不可用')
                issue=b.jira_issue(key);fields=issue['fields'];workflow=TYPE_WORKFLOW.get(fields['issuetype']['name'])
                if not workflow:raise ValueError('当前 Jira 工单类型“'+str(fields['issuetype']['name'])+'”尚未支持接入；请选择支持的编码、Bug、设计或接口联调子工单')
                if (fields['status'].get('statusCategory') or {}).get('key')=='done':raise ValueError('已完成工单不能作为真实开发登记；请使用模拟入口')
                if uses_seat_rule:rule=manual_rule(b,request,issue)
                elif fields['status']['name']!=status.strip():raise ValueError('Jira 当前状态不等于指定的允许执行状态')
                if not fields.get('assignee'):raise ValueError('Jira 工单未指定研发负责人')
                if auto_rule:
                    from jira_dispatch import verify
                    verify(b,task['id'],start=True)
                # Server reservation precedes every local filesystem mutation.
                reserve(b,task['id'])
                # Harness owns repository discovery, local paths and worktrees.
                # Persist only the intake identity; no business Git command runs here.
                plan={'repository_management':'harness','workflow':workflow}
                with b.db:b.db.execute('INSERT OR REPLACE INTO intake_jobs VALUES(?,?,?,?,?)',(task['id'],request_hash,'preparing',json.dumps(plan),now()))
                latest=b.pc.request('GET','/issues/'+task['id'])
                if latest.get('status')!='backlog' or latest.get('projectId')!=request['project_id'] or raw.group(0) not in str(latest.get('description') or ''):raise ValueError('接入准备期间任务已变化，停止登记')
                if uses_seat_rule:rule=manual_rule(b,request,b.jira_issue(key))
                if auto_rule:
                    from jira_dispatch import verify
                    verify(b,task['id'],start=True)
                b.register(key,workflow,None,rule['readyStatuses'] if uses_seat_rule else [status.strip()],False,intake={'task_id':task['id'],'project_id':project['id'],'seat_id':local['seat_id'],'machine_id':local['machine_id'],'repository_management':'harness','seat_rule_intake':uses_seat_rule})
                if auto_rule or uses_seat_rule:
                    details=b.pilot(key)['details']
                    if auto_rule:details.update(jira_dispatch=True,ready_statuses=auto_rule['readyStatuses'])
                    if task['id'] in b.cfg.get('_platform_dispatches',{}):details.update(platform_dispatch=True,platform_authorization_id=b.cfg['_platform_dispatches'][task['id']])
                    if uses_seat_rule:details['seat_rule_intake']=True
                    with b.db:b.db.execute('UPDATE pilots SET config=? WHERE jira_key=?',(json.dumps(details,ensure_ascii=False),key))
                finish(b,task,request,b.pilot(key)['details'])
            except (BridgeError,ValueError,OSError,sqlite3.Error,subprocess.TimeoutExpired) as error:
                message=str(error)[:1000]
                latest=b.pc.request('GET','/issues/'+task['id'])
                # Preserve immutable request, human notes and any source evidence.
                if latest.get('status') in ('done','cancelled'):continue
                from seats import seat_api
                seat_api(b).request('POST','/agents/'+b.cfg['agent_id']+'/dsp7-jira-intake/result',{**local,'taskId':task['id'],'request':raw.group(1),'status':'blocked','message':message})
                if job:
                    with b.db:b.db.execute('UPDATE intake_jobs SET status=?,updated_at=? WHERE task_id=?',('blocked',now(),task['id']))
                if auto_rule:
                    from seat_control import once_notice,dingtalk_notice
                    saved=folder.parent/'seat-control/state.json'
                    policy=(read_json(saved) if saved.is_file() else {}).get('policy') or {}
                    once_notice(b,'intake-blocked:'+task['id'],'Paperclip：自动接入阻塞',key+' '+message)
                    dingtalk_notice(b,policy,key,'intake-blocked:'+task['id'],key+' 自动接入阻塞：'+message,task['id'],dispatch_authorized=True)



def finish(b,task,request,details):
    from pilot import now, WORKFLOWS, INTEGRATION_INSTRUCTIONS, agent_entry_instructions
    latest=b.pc.request('GET','/issues/'+task['id'])
    key=details['jira_key']
    if latest.get('status') in ('done','cancelled') or latest.get('projectId')!=request['project_id']:raise ValueError('任务已结束或 Project 已变化，不能继续登记')
    description=str(latest.get('description') or '')
    result={'status':'ready','message':'派单准备已完成，等待席位自动打开本机终端执行' if details.get('jira_dispatch') else '接入已完成，等待本地启动','jira_key':key,'worktree':details['worktree'],'seat_id':details['seat_id'],'seat_name':b.cfg['seat']['name']}
    description=re.sub(r'\n?<!-- DSP7-INTAKE-RESULT .*? -->','',description)
    marker='DSP7-PILOT:'+key
    if marker not in description:
        description+='\n\n'+marker+'\nJira 工单：'+key+'\n工作流：'+WORKFLOWS[details['workflow']]+'\nHarness 根目录：'+str(b.root)+'\n源码目录：'+('由 Harness 套件管理' if details.get('repository_management')=='harness' else details['worktree'])+'\n领域状态：'+details['state_path']+'\n'+agent_entry_instructions()+' 加载 Harness CLAUDE.md 并按登记工作流执行；待确认保持同会话 Stop hook 等待。正式工程确认仍在 Jira。不得绕过领域完成门禁。'
    if details['workflow']=='integration' and INTEGRATION_INSTRUCTIONS not in description:description+='\n'+INTEGRATION_INSTRUCTIONS
    description+='\n<!-- DSP7-INTAKE-RESULT '+json.dumps(result,ensure_ascii=True)+' -->'
    description+='\n\n接入已完成。在所选席位 '+b.cfg['seat']['name']+' 运行：`harness start '+key+' --confirm-no-other-executor`。登记不等于开工；启动前核对无其他执行者。'
    if details.get('jira_dispatch'):
        description=re.sub(r'\n\n接入已完成。在所选席位 .*$', '\n\n接入已完成，等待席位空闲后自动执行；阻塞时通知席位负责人。',description)
    # Keep unassigned/backlog; local start performs assignment and wake under intent.
    from seats import identity,seat_api
    raw=latest['description'].split('<!-- DSP7-JIRA-INTAKE ',1)[1].split(' -->',1)[0]
    seat_api(b).request('POST','/agents/'+b.cfg['agent_id']+'/dsp7-jira-intake/result',{**identity(b),'taskId':task['id'],'request':raw,'status':'ready','message':result['message'],'receipt':{'title':key+' '+details['title'],'description':description}})
    with b.db:b.db.execute('UPDATE intake_jobs SET status=?,updated_at=? WHERE task_id=?',('ready',now(),task['id']))
    b.event(key,'web_intake_registered',{'task_id':task['id'],'project_id':request['project_id'],'worktree':details['worktree'],'seat_id':details['seat_id'],'seat_name':b.cfg['seat']['name']})
