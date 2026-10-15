"""Board-created Jira intake requests, processed only on the configured Mac."""
from platform_support import fcntl
import hashlib
import json
from pathlib import Path
import re
import subprocess
import sqlite3
import urllib.parse

PREFIX = 'DSP7-JIRA-INTAKE'


def git(repo, *args):
    result = subprocess.run(['git', '-C', str(repo), *args], capture_output=True, text=True, timeout=90)
    if result.returncode:
        raise ValueError('Git 操作失败：'+result.stderr.strip()[:500])
    return result.stdout.strip()


def process_requests(b):
    from pilot import BridgeError, TYPE_WORKFLOW, rows, now, atomic_json, read_json
    from seats import identity, reserve, source_repo, normalize_remote, verify_runtime
    if not b.cfg.get('web_jira_intake_enabled'): return
    local=identity(b)
    b.db.execute('''CREATE TABLE IF NOT EXISTS intake_jobs (
        task_id TEXT PRIMARY KEY, request_hash TEXT NOT NULL, status TEXT NOT NULL,
        data TEXT NOT NULL, updated_at TEXT NOT NULL)''')
    folder=Path(b.cfg['database']).parent/'intake';folder.mkdir(mode=0o700,exist_ok=True)
    with (folder/'worker.lock').open('a') as lock:
        try: fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
        except BlockingIOError:return
        requests=rows(b.pc.request('GET','/companies/'+b.cfg['company_id']+'/issues?'+urllib.parse.urlencode({'q':'Jira 接入申请','status':'backlog'})))
        for task in sorted(requests,key=lambda item:item.get('createdAt','')):
            raw=re.search(r'<!-- '+PREFIX+r' (.*?) -->',str(task.get('description') or ''))
            if not raw or task.get('status')!='backlog':continue
            try:request=json.loads(raw.group(1))
            except (ValueError,TypeError):continue  # Cannot determine a trusted destination.
            if not isinstance(request,dict) or request.get('version')!=2 or request.get('seat_id')!=local['seat_id']:continue
            auto_rule=None
            job=b.db.execute('SELECT * FROM intake_jobs WHERE task_id=?',(task['id'],)).fetchone()
            try:
                verify_runtime(b)
                request_hash=hashlib.sha256(raw.group(1).encode()).hexdigest()
                auto_rule=None
                if task.get('createdByAgentId')==b.cfg['agent_id']:
                    from jira_dispatch import verify
                    auto_rule=verify(b,task['id'])
                    if auto_rule.get('intakePaused'):continue
                    verify(b,task['id'],start=True)
                else:
                    if task.get('companyId')!=b.cfg['company_id'] or task.get('createdByAgentId') or task.get('createdByUserId') not in b.cfg.get('paperclip_intake_user_ids',[]):
                        raise ValueError('该申请的创建账号未获本机接入授权')
                    authorization='<!-- DSP7-JIRA-INTAKE-AUTH '+raw.group(1)+' -->'
                    comments=rows(b.pc.request('GET','/issues/'+task['id']+'/comments'))
                    if not any(not c.get('authorAgentId') and c.get('authorUserId')==task.get('createdByUserId') and not c.get('deletedAt') and authorization in str(c.get('body') or '') for c in comments):continue
                if task.get('assigneeAgentId') or task.get('assigneeUserId'):raise ValueError('接入申请不得提前分派执行者')

                if request.get('version')!=2 or request.get('project_id')!=task.get('projectId'):raise ValueError('申请版本或 Project 不匹配')
                for field in ('project_id','workspace_id'):
                    if not isinstance(request.get(field),str) or not re.fullmatch(r'[0-9a-fA-F]{8}-(?:[0-9a-fA-F]{4}-){3}[0-9a-fA-F]{12}',request[field]):raise ValueError('Project 或工作区编号无效')
                key=request.get('jira_key','')
                if not re.fullmatch(r'[A-Z][A-Z0-9_]*-\d+',key):raise ValueError('Jira 工单号无效')
                status=request.get('ready_status','')
                if not isinstance(status,str) or not status.strip() or len(status)>100:raise ValueError('请指定允许执行的 Jira 状态')
                if job and job['request_hash']!=request_hash:raise ValueError('已处理申请不能修改；请提交新的申请')
                existing=b.db.execute('SELECT task_id,config FROM pilots WHERE jira_key=?',(key,)).fetchone()
                if existing:
                    d=json.loads(existing['config'])
                    if existing['task_id']!=task['id'] or d.get('intake_task_id')!=task['id']:raise ValueError('该 Jira 已登记到另一任务，不能重复登记')
                    reserve(b,task['id'])
                    finish(b,task,request,d)
                    continue
                if job and job['status']=='ready':continue
                if b.db.execute('SELECT count(*) FROM pilots WHERE enabled=1').fetchone()[0]:continue # Keep queued intake untouched while the seat is busy.
                project=b.pc.request('GET','/projects/'+request['project_id'])
                if project.get('companyId')!=b.cfg['company_id'] or project.get('archivedAt'):raise ValueError('Project 不可用')
                workspace=next((w for w in project.get('workspaces',[]) if w['id']==request.get('workspace_id')),None)
                if not workspace or workspace.get('projectId')!=project['id'] or not workspace.get('repoUrl'):raise ValueError('请选择配置仓库 URL 的共享工作区')
                repo=source_repo(b,project['id'],workspace)
                roots=[Path(x).expanduser().resolve(strict=True) for x in b.cfg.get('intake_repository_roots',[])]
                if not roots or not any(repo.is_relative_to(root) for root in roots):raise ValueError('仓库路径不在本机接入白名单内')
                if repo==b.root:raise ValueError('请选择业务源码仓库，不能把 Harness 知识库作为业务源码')
                if Path(git(repo,'rev-parse','--show-toplevel')).resolve()!=repo:raise ValueError('工作区路径必须指向 Git 仓库根目录')
                if workspace.get('repoUrl'):
                    if normalize_remote(git(repo,'remote','get-url','origin'))!=normalize_remote(workspace['repoUrl']):raise ValueError('本地 origin 与 Project 仓库 URL 不匹配')
                issue=b.jira_issue(key);fields=issue['fields'];workflow=TYPE_WORKFLOW.get(fields['issuetype']['name'])
                if not workflow:raise ValueError('只接入编码、Bug 或设计子工单，不接入父需求单')
                if (fields['status'].get('statusCategory') or {}).get('key')=='done':raise ValueError('已完成工单不能作为真实开发登记；请使用模拟入口')
                if fields['status']['name']!=status.strip():raise ValueError('Jira 当前状态不等于指定的允许执行状态')
                if auto_rule and ((fields.get('assignee') or {}).get('name') or (fields.get('assignee') or {}).get('accountId'))!=auto_rule['jiraAssignee']:raise ValueError('Jira 已重新指派，停止自动接入')
                if not fields.get('assignee'):raise ValueError('Jira 工单未指定研发负责人')
                # Server reservation precedes every local filesystem mutation.
                reserve(b,task['id'])
                branch='harness/'+key
                base=workspace.get('repoRef') or workspace.get('defaultRef')
                if not base or not isinstance(base,str) or base.startswith('-'):raise ValueError('请在 Project 工作区配置 repoRef 或 defaultRef 基线分支')
                commit=git(repo,'rev-parse','--verify',base+'^{commit}')
                worktrees=Path(b.cfg['intake_worktree_root']).expanduser().resolve();worktrees.mkdir(mode=0o700,parents=True,exist_ok=True)
                target=worktrees/(repo.name+'-'+hashlib.sha256(str(repo).encode()).hexdigest()[:8])/key
                plan={'repo':str(repo),'worktree':str(target),'branch':branch,'base_ref':base,'base_commit':commit,'workflow':workflow}
                old=json.loads(job['data']) if job else None
                if old and old!=plan:raise ValueError('仓库或基线已变化，请人工核对既有接入计划')
                with b.db:b.db.execute('INSERT OR REPLACE INTO intake_jobs VALUES(?,?,?,?,?)',(task['id'],request_hash,'preparing',json.dumps(plan),now()))
                manifest=folder/(task['id']+'.json')
                if manifest.exists() and read_json(manifest)!=plan:raise ValueError('本机接入计划不匹配')
                atomic_json(manifest,plan)
                if workflow!='design':
                    if target.exists():
                        if not old or git(target,'rev-parse','--show-toplevel')!=str(target) or git(target,'symbolic-ref','--short','HEAD')!=branch:
                            raise ValueError('目标目录已存在但不属于本申请，不能覆盖')
                    else:
                        target.parent.mkdir(mode=0o700,parents=True,exist_ok=True)
                        git(repo,'worktree','add','-b',branch,str(target),commit)
                    if git(target,'rev-parse','--path-format=absolute','--git-common-dir')!=git(repo,'rev-parse','--path-format=absolute','--git-common-dir'):raise ValueError('工作树不属于登记的源仓库')
                    b.worktree_check({'workflow':workflow,'worktree':str(target),'jira_key':key})
                worktree=str(repo) if workflow=='design' else str(target)
                latest=b.pc.request('GET','/issues/'+task['id'])
                if latest.get('status')!='backlog' or latest.get('projectId')!=request['project_id'] or raw.group(0) not in str(latest.get('description') or ''):raise ValueError('接入准备期间任务已变化，停止登记')
                b.register(key,workflow,worktree,[status.strip()],False,intake={'task_id':task['id'],'project_id':project['id'],'workspace_id':workspace['id'],'source_repo':str(repo),'base_ref':base,'seat_id':local['seat_id'],'machine_id':local['machine_id'],'repo_url':workspace['repoUrl']})
                if auto_rule:
                    details=b.pilot(key)['details'];details['jira_dispatch']=True;details['ready_statuses']=auto_rule['readyStatuses']
                    with b.db:b.db.execute('UPDATE pilots SET config=? WHERE jira_key=?',(json.dumps(details,ensure_ascii=False),key))
                finish(b,task,request,b.pilot(key)['details'])
            except (BridgeError,ValueError,OSError,sqlite3.Error,subprocess.TimeoutExpired) as error:
                message=str(error)[:1000]
                latest=b.pc.request('GET','/issues/'+task['id'])
                # Preserve immutable request, human notes and any source evidence.
                if latest.get('status') in ('done','cancelled'):continue
                desc=re.sub(r'\n?<!-- DSP7-INTAKE-RESULT .*? -->','',str(latest.get('description') or ''))
                marker='<!-- DSP7-INTAKE-RESULT '+json.dumps({'status':'blocked','message':message},ensure_ascii=True)+' -->'
                b.pc.request('PATCH','/issues/'+task['id'],{'status':'blocked','description':desc+'\n'+marker+'\n\n接入未完成：'+message})
                if job:
                    with b.db:b.db.execute('UPDATE intake_jobs SET status=?,updated_at=? WHERE task_id=?',('blocked',now(),task['id']))
                if auto_rule:
                    from seat_control import once_notice,dingtalk_notice
                    saved=folder.parent/'seat-control/state.json'
                    policy=(read_json(saved) if saved.is_file() else {}).get('policy') or {}
                    once_notice(b,'intake-blocked:'+task['id'],'Paperclip：自动接入阻塞',key+' '+message)
                    dingtalk_notice(b,policy,key,'intake-blocked:'+task['id'],key+' 自动接入阻塞：'+message,task['id'],dispatch_authorized=True)



def finish(b,task,request,details):
    from pilot import now
    latest=b.pc.request('GET','/issues/'+task['id'])
    key=details['jira_key']
    if latest.get('status') in ('done','cancelled') or latest.get('projectId')!=request['project_id']:raise ValueError('任务已结束或 Project 已变化，不能继续登记')
    description=str(latest.get('description') or '')
    result={'status':'ready','message':'接入已完成，等待自动调度' if details.get('jira_dispatch') else '接入已完成，等待本地启动','jira_key':key,'worktree':details['worktree'],'seat_id':details['seat_id'],'seat_name':b.cfg['seat']['name']}
    description=re.sub(r'\n?<!-- DSP7-INTAKE-RESULT .*? -->','',description)
    marker='DSP7-PILOT:'+key
    if marker not in description:
        description+='\n\n'+marker+'\nJira 工单：'+key+'\n工作流：'+details['workflow']+'\nHarness 根目录：'+str(b.root)+'\n源码目录：'+details['worktree']+'\n领域状态：'+details['state_path']+'\n先通过 pilot.py agent inspect、agent claim 领取执行权；加载 Harness CLAUDE.md 并按登记工作流执行。阶段、阻塞和完成通过 agent stage/block/complete 回写；待确认保持同会话 Stop hook 等待。正式工程确认仍在 Jira。不得绕过领域完成门禁。'
    description+='\n<!-- DSP7-INTAKE-RESULT '+json.dumps(result,ensure_ascii=True)+' -->'
    description+='\n\n接入已完成。在所选席位 '+b.cfg['seat']['name']+' 运行：`harness start '+key+' --confirm-no-other-executor`。登记不等于开工；启动前核对无其他执行者。'
    if details.get('jira_dispatch'):
        description=re.sub(r'\n\n接入已完成。在所选席位 .*$', '\n\n接入已完成，等待席位空闲后自动执行；阻塞时通知席位负责人。',description)
    # Keep unassigned/backlog; local start performs assignment and wake under intent.
    b.pc.request('PATCH','/issues/'+task['id'],{'title':key+' '+details['title'],'description':description,'status':'backlog','projectWorkspaceId':request['workspace_id'],'assigneeAdapterOverrides':{'useProjectWorkspace':False}})
    with b.db:b.db.execute('UPDATE intake_jobs SET status=?,updated_at=? WHERE task_id=?',('ready',now(),task['id']))
    b.event(key,'web_intake_registered',{'task_id':task['id'],'project_id':request['project_id'],'worktree':details['worktree'],'seat_id':details['seat_id'],'seat_name':b.cfg['seat']['name']})
