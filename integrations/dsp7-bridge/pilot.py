#!/usr/bin/env python3
"""Explicit-ticket Jira/Paperclip bridge for enrolled macOS, Linux and Windows seats."""
from __future__ import annotations
import argparse
import contextlib
import datetime as dt
from platform_support import fcntl
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import re
import sqlite3
import shlex
import subprocess
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

DEFAULT_CONFIG = Path(os.environ.get('DSP7_BRIDGE_CONFIG') or Path.home()/'.config/paperclip-dsp7-bridge/config.json')
ACTIVE = {'queued','running','scheduled_retry'}
TERMINAL = {'succeeded','failed','cancelled','timed_out'}
WORKFLOWS = {'feature':'jira-feature-dev','bugfix':'jira-bug-fix','design':'jira-design-doc'}
TYPE_WORKFLOW = {'编码':'feature','前端编码':'feature','功能':'feature','内部缺陷':'bugfix','线上问题':'bugfix','系统设计':'design','系统设计补充':'design'}

class BridgeError(RuntimeError): pass

def now(): return dt.datetime.now(dt.timezone.utc).isoformat()
def digest(value): return hashlib.sha256(json.dumps(value,ensure_ascii=False,sort_keys=True).encode()).hexdigest()
def read_json(path):
    try:
        value=json.loads(Path(path).read_text(encoding='utf-8'))
    except (OSError,json.JSONDecodeError) as e: raise BridgeError('JSON 文件无法读取: '+str(path)) from e
    if not isinstance(value,dict):raise BridgeError('JSON 必须是对象: '+str(path))
    return value

def atomic_json(path,value):
    import tempfile
    path=Path(path);path.parent.mkdir(parents=True,exist_ok=True)
    fd,name=tempfile.mkstemp(dir=path.parent,prefix=path.name+'.')
    try:
        with os.fdopen(fd,'w',encoding='utf-8') as f:json.dump(value,f,ensure_ascii=False,indent=2);f.write('\n')
        os.replace(name,path)
    finally:
        if os.path.exists(name):os.unlink(name)

class Api:
    def __init__(self,base,token,run_id=None):
        self.base=base.rstrip('/');self.token=token;self.run_id=run_id
        p=urllib.parse.urlsplit(self.base)
        if p.scheme not in ('http','https') or not p.hostname or p.username or p.password or p.query or p.fragment:
            raise BridgeError('API origin 格式无效')
    def request(self,method,path,body=None):
        headers={'Content-Type':'application/json','Accept':'application/json'}
        if self.token:headers['Authorization']='Bearer '+self.token
        if self.run_id:headers['X-Paperclip-Run-Id']=self.run_id
        req=urllib.request.Request(self.base+path,data=json.dumps(body,ensure_ascii=False).encode() if body is not None else None,headers=headers,method=method)
        try:
            with urllib.request.urlopen(req,timeout=25) as r:
                raw=r.read(5*1024*1024+1)
                if len(raw)>5*1024*1024:raise BridgeError('API 响应过大')
                return json.loads(raw) if raw else {}
        except urllib.error.HTTPError as e:
            try:message=str(json.loads(e.read(8192)).get('error') or '')[:500]
            except (ValueError,UnicodeDecodeError):message=''
            raise BridgeError(f'API {method} {path.split("?")[0]} HTTP {e.code}: {message}') from e
        except (urllib.error.URLError,TimeoutError,OSError):raise BridgeError('API 网络异常') from None

def load_module(name,path):
    spec=importlib.util.spec_from_file_location(name,path);module=importlib.util.module_from_spec(spec)
    sys.modules[name]=module;spec.loader.exec_module(module);return module

def processes_for_run(run_id):
    if sys.platform=='win32':
        from platform_support import process_table,windows_argv,matches_claude
        executable=(read_json(DEFAULT_CONFIG).get('seat_runtime') or {}).get('claudeCommand')
        if not executable:return []
        found=[]
        for pid,p in process_table().items():
            if not matches_claude(p['command'],executable):continue
            args=windows_argv(p['command'])
            if any(a=='--session-id' and i+1<len(args) and args[i+1]==run_id for i,a in enumerate(args)):found.append(pid)
        return sorted(found)
    # Never print process command lines: other processes can carry secrets.
    out=subprocess.run(['/bin/ps','-axo','pid=,command='],capture_output=True,text=True,check=True).stdout
    owned=[]
    for line in out.splitlines():
        parts=line.strip().split(None,1)
        if len(parts)!=2:continue
        # ps flattens argv and the prompt can contain unmatched shell quotes.
        # Parse only the launch prefix, never the user-authored prompt suffix.
        marker=' --session-id '
        prefix,sep,suffix=parts[1].partition(marker)
        if not sep:continue
        try:args=shlex.split(prefix)
        except ValueError:continue
        executable='/usr/local/bin/claude'
        with contextlib.suppress(OSError,ValueError,KeyError):
            executable=(read_json(DEFAULT_CONFIG).get('seat_runtime') or {}).get('claudeCommand') or executable
        if not args or args[0]!=executable:continue
        session=suffix.split(None,1)[0] if suffix else ''
        if session==run_id:owned.append(int(parts[0]))
    return owned

def stop_run_locally(run_id):
    """Terminate only the verified local Claude run tree; no unrelated sessions."""
    import signal
    roots=processes_for_run(run_id)
    if not roots:return []
    if sys.platform=='win32':
        from platform_support import process_table
        snapshot=process_table()
        for pid in roots:
            current=process_table().get(pid)
            if not current:continue
            if current!=snapshot.get(pid):raise BridgeError('Windows 进程身份已变化；禁止停止或释放租约')
            subprocess.run(['taskkill.exe','/PID',str(pid),'/T','/F'],capture_output=True,timeout=15)
        if processes_for_run(run_id):raise BridgeError('本机运行停止失败；禁止释放租约')
        return roots
    out=subprocess.run(['/bin/ps','-axo','pid=,ppid=,command='],capture_output=True,text=True,check=True).stdout
    processes={}
    for line in out.splitlines():
        parts=line.strip().split(None,2)
        if len(parts)==3:processes[int(parts[0])]=(int(parts[1]),parts[2])
    owned=set(roots)
    while True:
        added={pid for pid,(parent,_) in processes.items() if parent in owned}-owned
        if not added:break
        owned|=added
    for sig in (signal.SIGTERM,signal.SIGKILL):
        for pid in sorted(owned,reverse=True):
            current=subprocess.run(['/bin/ps','-p',str(pid),'-o','command='],capture_output=True,text=True).stdout.strip()
            if not current or current!=processes.get(pid,(None,''))[1]:continue
            try:os.kill(pid,sig)
            except ProcessLookupError:pass
        for _ in range(10):
            if not processes_for_run(run_id):return sorted(owned)
            time.sleep(.5)
    if processes_for_run(run_id):raise BridgeError('本机运行停止失败；禁止释放租约')
    return sorted(owned)

def rows(value):
    if isinstance(value,list):return value
    if isinstance(value,dict):
        for key in ('issues','runs','items','data','members'):
            if isinstance(value.get(key),list):return value[key]
    raise BridgeError('API 列表响应不兼容')

def jira_fingerprint(issue):
    f=issue['fields']
    return digest({k:f.get(k) for k in ('summary','description','issuetype','parent','attachment')})

class Bridge:
    def __init__(self,config_path=DEFAULT_CONFIG,agent=False):
        self.config_path=Path(config_path);self.cfg=read_json(self.config_path)
        self.root=Path(self.cfg['harness_root']).resolve()
        self.jc=load_module('dsp7_jira_confirmation',self.root/'harness/scripts/jira_confirmation.py')
        self.notify=load_module('dsp7_dingtalk_notify',self.root/'harness/scripts/dingtalk_notify.py')
        path=Path(self.cfg['database']);path.parent.mkdir(parents=True,exist_ok=True,mode=0o700)
        self.db=sqlite3.connect(path,timeout=20);self.db.row_factory=sqlite3.Row
        self.db.execute('PRAGMA journal_mode=WAL');self.db.execute('PRAGMA busy_timeout=20000')
        self.db.executescript('''
        CREATE TABLE IF NOT EXISTS pilots (
          jira_key TEXT PRIMARY KEY, task_id TEXT UNIQUE, config TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'registered', enabled INTEGER NOT NULL DEFAULT 0,
          consumed_confirmation TEXT, last_phase TEXT, last_error TEXT,
          last_wakeup TEXT, updated_at TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS events (
          id INTEGER PRIMARY KEY, jira_key TEXT NOT NULL, run_id TEXT,
          kind TEXT NOT NULL, data TEXT NOT NULL, created_at TEXT NOT NULL,
          published INTEGER NOT NULL DEFAULT 0);
        CREATE TABLE IF NOT EXISTS leases (
          jira_key TEXT PRIMARY KEY, run_id TEXT NOT NULL, created_at TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS notices (
          notice_key TEXT PRIMARY KEY, jira_key TEXT NOT NULL, status TEXT NOT NULL,
          updated_at TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS runs (
          run_id TEXT PRIMARY KEY, jira_key TEXT NOT NULL, data TEXT NOT NULL,
          updated_at TEXT NOT NULL);
        ''');os.chmod(path,0o600)
        self.agent_mode=agent
        if agent:
            e={k:os.environ.get(k,'') for k in ('PAPERCLIP_API_URL','PAPERCLIP_API_KEY','PAPERCLIP_RUN_ID','PAPERCLIP_TASK_ID','PAPERCLIP_AGENT_ID')}
            if not all(e.values()):raise BridgeError('必须在真实 Paperclip run 中执行 agent 子命令')
            if e['PAPERCLIP_AGENT_ID']!=self.cfg['agent_id']:raise BridgeError('Agent 不匹配')
            url=e['PAPERCLIP_API_URL'].rstrip('/')
            p=urllib.parse.urlsplit(url);host=urllib.parse.urlsplit(self.cfg['paperclip_url']).hostname
            if p.hostname not in (host,'localhost','127.0.0.1'):raise BridgeError('运行期 API origin 不匹配')
            self.pc=Api(url if url.endswith('/api') else url+'/api',e['PAPERCLIP_API_KEY'],e['PAPERCLIP_RUN_ID'])
            self.env=e
        else:
            credential=Path(self.cfg['credential_file'])
            from platform_support import credential_private
            if not credential_private(credential):raise BridgeError('接入凭证文件必须仅当前用户可读')
            c=read_json(credential)
            if c['companyId']!=self.cfg['company_id']:raise BridgeError('服务身份 company 不匹配')
            self.pc=Api(self.cfg['paperclip_url'].rstrip('/')+'/api',c['token'])
    def jira_config(self):
        if self.cfg.get('jira_dispatch_credentials'):
            if not getattr(self,'_jira_credentials',None):
                from seats import identity,seat_api
                self._jira_credentials=seat_api(self).request('POST','/agents/'+self.cfg['agent_id']+'/dsp7-jira-dispatch/credentials',identity(self))
            credentials=self._jira_credentials
            return credentials['baseUrl'],credentials['token']
        credential=self.cfg.get('jira_credential_file')
        if credential:
            path=Path(credential)
            from platform_support import credential_private
            if not credential_private(path):raise BridgeError('Jira 凭证必须仅当前用户可读')
            c=read_json(path);return c['base_url'],c['token']
        return self.jc.resolve_jira_config()
    def jira(self):
        base,token=self.jira_config();return Api(base,token)
    def jira_issue(self,key):
        return self.jira().request('GET','/rest/api/2/issue/'+urllib.parse.quote(key,safe='-'))
    def event(self,key,kind,data,run_id=None):
        with self.db:self.db.execute('INSERT INTO events(jira_key,run_id,kind,data,created_at) VALUES(?,?,?,?,?)',(key,run_id,kind,json.dumps(data,ensure_ascii=False),now()))
    def update(self,key,**fields):
        fields['updated_at']=now()
        if set(fields)-{'task_id','status','enabled','consumed_confirmation','last_phase','last_error','last_wakeup','updated_at'}:raise BridgeError('非法字段')
        with self.db:self.db.execute('UPDATE pilots SET '+','.join(k+'=?' for k in fields)+' WHERE jira_key=?',[*fields.values(),key])
    def pilot(self,key):
        r=self.db.execute('SELECT * FROM pilots WHERE jira_key=?',(key,)).fetchone()
        if not r:raise BridgeError('未登记试点工单')
        return dict(r)|{'details':json.loads(r['config'])}
    def state(self,pilot,required=True):
        p=Path(pilot['details']['state_path'])
        if not p.exists() and not required:return {}
        s=read_json(p)
        if s.get('工单号')!=pilot['jira_key']:raise BridgeError('领域 state 工单身份不匹配')
        return s
    def validate_jira(self,pilot):
        from seats import check
        check(self,pilot)
        issue=self.jira_issue(pilot['jira_key']);f=issue['fields'];d=pilot['details']
        if d.get('intake_task_id'):
            task=self.pc.request('GET','/issues/'+pilot['task_id'])
            project=self.pc.request('GET','/projects/'+d['project_id'])
            workspace=next((w for w in project.get('workspaces',[]) if w['id']==d['source_workspace_id']),None)
            if task.get('projectId')!=d['project_id'] or task.get('projectWorkspaceId')!=d['source_workspace_id'] or (task.get('assigneeAdapterOverrides') or {}).get('useProjectWorkspace') is not False or project.get('companyId')!=self.cfg['company_id'] or project.get('archivedAt') or not workspace:raise BridgeError('Project 或源工作区已变化，需人工重新核验')
            from seats import source_repo, normalize_remote
            if str(source_repo(self,d['project_id'],workspace))!=d['source_repo'] or normalize_remote(workspace.get('repoUrl'))!=normalize_remote(d.get('source_repo_url')) or (workspace.get('repoRef') or workspace.get('defaultRef'))!=d['source_base_ref']:raise BridgeError('本席位仓库映射或共享仓库／基线已变化，停止执行')
            if d['workflow']!='design':
                from jira_intake import git
                if git(d['worktree'],'rev-parse','--path-format=absolute','--git-common-dir')!=git(d['source_repo'],'rev-parse','--path-format=absolute','--git-common-dir'):raise BridgeError('工作树不再属于该席位登记的源仓库')
        assignee=f.get('assignee') or {};account=assignee.get('name') or assignee.get('accountId')
        if account!=d.get('source_assignee',d['assignee']):raise BridgeError('Jira 经办人变化，需人工重新登记')
        if TYPE_WORKFLOW.get(f['issuetype']['name'])!=d['workflow']:raise BridgeError('Jira 工单类型变化')
        if jira_fingerprint(issue)!=d['jira_fingerprint']:raise BridgeError('Jira 需求或附件变化，停止自动续传并重新核验')
        if f['status']['name'] not in d['ready_statuses']:raise BridgeError('Jira 状态不在明确授权的可执行范围')
        return issue
    def worktree_check(self,d):
        if d.get('mode')=='replay' or d['workflow']=='design':return
        p=subprocess.run([sys.executable,str(self.root/'harness/scripts/harness_cli.py'),'worktree-check','--repo',d['worktree'],'--ticket',d['jira_key']],capture_output=True,text=True,timeout=30)
        if p.returncode:raise BridgeError('源码 worktree 门禁失败；请在登记的路径单独核验')
    def register(self,key,workflow,worktree,ready_statuses,notify_authorized=False,intake=None):
        if not re.fullmatch(r'[A-Z][A-Z0-9_]*-\d+',key):raise BridgeError('Jira 工单号格式无效')
        if self.db.execute('SELECT 1 FROM pilots WHERE jira_key=?',(key,)).fetchone():raise BridgeError('工单已登记；不能覆盖已有交接')
        if self.db.execute('SELECT COUNT(*) FROM pilots WHERE enabled=1').fetchone()[0]:raise BridgeError('第一期只允许一个启用的工单')
        issue=self.jira_issue(key);f=issue['fields'];assignee=f.get('assignee') or {};account=assignee.get('name') or assignee.get('accountId')
        if not account:raise BridgeError('Jira 工单尚未指定经办人')
        if TYPE_WORKFLOW.get(f['issuetype']['name'])!=workflow:raise BridgeError('工单类型与指定 workflow 不符；不执行父需求单')
        state_path=self.root/'tickets'/f'{workflow}-{key}'/'state.json'
        if workflow=='design':state_path=self.root/'tickets'/f'design-{key}'/'state.json'
        if state_path.exists():
            s=read_json(state_path)
            if s.get('工单号')!=key or s.get('状态')=='completed':raise BridgeError('既有 state 不匹配或已完成')
        details={'jira_key':key,'workflow':workflow,'worktree':str(Path(worktree).resolve()),'state_path':str(state_path),
                 'assignee':account,'assignee_name':assignee.get('displayName') or account,'title':f['summary'],
                 'jira_fingerprint':jira_fingerprint(issue),'ready_statuses':ready_statuses,'notifications_authorized':notify_authorized}
        self.worktree_check(details)
        if intake:details.update(execution_mode='interactive',intake_task_id=intake['task_id'],project_id=intake['project_id'],source_workspace_id=intake['workspace_id'],source_repo=intake['source_repo'],source_base_ref=intake['base_ref'],seat_id=intake['seat_id'],machine_id=intake['machine_id'],source_repo_url=intake['repo_url'])
        with self.db:self.db.execute('INSERT INTO pilots(jira_key,task_id,config,updated_at) VALUES(?,?,?,?)',(key,intake['task_id'] if intake else None,json.dumps(details,ensure_ascii=False),now()))
        self.event(key,'registered',{'workflow':workflow,'assignee':account,'ready_statuses':ready_statuses})
        return {'jira_key':key,'status':'registered','enabled':False,'state_path':str(state_path)}
    def register_replay(self,key,new_attempt=False):
        previous=self.db.execute('SELECT 1 FROM pilots WHERE jira_key=?',(key,)).fetchone()
        if previous:
            old=self.pilot(key)
            if not new_attempt:raise BridgeError('工单已登记')
            if old['details'].get('mode')!='replay' or old['enabled']:raise BridgeError('仅允许已停用的模拟工单创建新轮次')
            runs=self.runs_for(old)
            if any(r['status'] in ACTIVE for r in runs):raise BridgeError('旧轮次仍有活动运行')
            self.lease_clear(old,runs)
            self.event(key,'replay_attempt_archived',{'task_id':old['task_id'],'details':old['details'],'status':old['status']})
        issue=self.jira_issue(key);f=issue['fields'];source=(f.get('assignee') or {}).get('name') or (f.get('assignee') or {}).get('accountId')
        workflow=TYPE_WORKFLOW.get(f['issuetype']['name'])
        if not workflow:raise BridgeError('模拟源工单类型不支持')
        folder=Path(self.cfg['database']).parent/'replays'/key
        attempt_id=None
        if new_attempt:
            import uuid
            attempt_id='replay-'+uuid.uuid4().hex[:10];folder=folder/attempt_id
        folder.mkdir(parents=True,exist_ok=True,mode=0o700)
        reviewer='replay-reviewer'
        state={'工单号':key,'类型':workflow,'标题':f['summary'],'状态':'in-progress','当前Phase':'P1','模拟验收':True,'经办人':{'账号':reviewer,'显示名':'模拟确认人'}}
        atomic_json(folder/'state.json',state);atomic_json(folder/'comments.json',{'comments':[]})
        atomic_json(folder/'source-summary.json',{'key':key,'summary':f['summary'],'type':f['issuetype']['name'],'status':f['status']['name'],'source_read_at':now()})
        d={'mode':'replay','attempt_id':attempt_id,'jira_key':key,'workflow':workflow,'worktree':None,'state_path':str(folder/'state.json'),'comments_path':str(folder/'comments.json'),
           'source_assignee':source,'assignee':reviewer,'assignee_name':'模拟确认人','title':f['summary'],
           'jira_fingerprint':jira_fingerprint(issue),'ready_statuses':[f['status']['name']],'notifications_authorized':False}
        with self.db:
            if previous:self.db.execute("UPDATE pilots SET task_id=NULL,config=?,status='registered',enabled=0,consumed_confirmation=NULL,last_phase=NULL,last_error=NULL,last_wakeup=NULL,updated_at=? WHERE jira_key=?",(json.dumps(d,ensure_ascii=False),now(),key))
            else:self.db.execute('INSERT INTO pilots(jira_key,config,updated_at) VALUES(?,?,?)',(key,json.dumps(d,ensure_ascii=False),now()))
        self.event(key,'replay_registered',{'source_type':f['issuetype']['name'],'source_status':f['status']['name'],'external_write':False})
        return {'jira_key':key,'mode':'replay','enabled':False,'state_path':d['state_path']}
    def replay_confirm(self,key,verdict):
        pilot=self.pilot(key);d=pilot['details']
        if d.get('mode')!='replay':raise BridgeError('合成回复仅允许模拟任务')
        state=self.state(pilot);cur=self.jc.current_confirmation(state)
        if not cur or cur['状态']!='pending':raise BridgeError('没有待确认事项')
        cid=cur['确认编号'];folder=Path(d['comments_path']).parent
        with (folder/'.confirmation.lock').open('a') as lock:
            fcntl.flock(lock,fcntl.LOCK_EX)
            receipts_path=folder/'paperclip-confirmation-receipts.json'
            if receipts_path.exists() and cid in read_json(receipts_path).get('decisions',{}):
                raise BridgeError('该确认编号已有页面审批决定；不能通过终端覆盖')
            comments=read_json(d['comments_path'])
            comments['comments'].append({'id':'replay-'+str(len(comments['comments'])+1),'created':now(),'body':'#'+cid+' '+('同意' if verdict=='approve' else '拒绝'),'author':{'name':d['assignee'],'displayName':d['assignee_name']},'simulated':True})
            atomic_json(d['comments_path'],comments);self.event(key,'synthetic_confirmation',{'confirmation':cid,'verdict':verdict,'external_write':False})
        return {'jira_key':key,'confirmation':cid,'verdict':verdict,'simulated':True}
    def ensure_task(self,pilot):
        if pilot['task_id']:return self.pc.request('GET','/issues/'+pilot['task_id'])
        marker='DSP7-PILOT:'+pilot['jira_key']
        if pilot['details'].get('attempt_id'):marker+=':'+pilot['details']['attempt_id']
        # Query before retrying an uncertain create; exact marker prevents title collisions.
        tasks=rows(self.pc.request('GET','/companies/'+self.cfg['company_id']+'/issues?'+urllib.parse.urlencode({'q':marker})))
        found=[x for x in tasks if marker in str(x.get('description',''))]
        if len(found)>1:raise BridgeError('同一试点工单出现多个任务，请人工核对')
        d=pilot['details']
        desc=f'''{marker}
Jira: {self.jira_config()[0]}/browse/{pilot['jira_key']}
工作流: {WORKFLOWS[d['workflow']]}
研发负责人: {d['assignee_name']} ({d['assignee']})
源码 worktree: {d['worktree']}
领域 state: {d['state_path']}
通过 {subprocess.list2cmdline([sys.executable,str(Path(__file__).resolve()),'agent','inspect']) if sys.platform=='win32' else shlex.join([sys.executable,str(Path(__file__).resolve()),'agent','inspect'])} 获取当前任务。
开始前 agent claim；阶段切换调用 agent stage；需要确认调用 agent block 并退出；领域交付完成后 agent complete。
必须遵守 base-harness 门禁；不要调用旧 task_api.py complete 绕过领域完成核验。'''
        if d.get('mode')=='replay':
            desc+='\n明确模式：replay。仅验证已完成工单的模拟闭环，禁止修改 Jira／tracker／业务源码。\n调用 agent inspect、agent claim 后调用 agent replay；第一次阻塞后立即结束，确认后再次运行 agent replay。\n模拟资料只在登记的 replay state 目录中读取和生成，不加载完整工程开发技能，不修改原 Harness state。'
        # Backlog without assignee suppresses automatic execution until mapping is persisted.
        task=found[0] if found else self.pc.request('POST','/companies/'+self.cfg['company_id']+'/issues',{'title':d['jira_key']+' '+d['title'],'description':desc,'status':'backlog','priority':'medium'})
        if task.get('status') in ('done','cancelled'):raise BridgeError('候选映射任务已关闭；不能重新使用')
        if task.get('companyId')!=self.cfg['company_id']:raise BridgeError('任务 company 不匹配')
        self.update(pilot['jira_key'],task_id=task['id']);return task
    def runs_for(self,pilot):
        allruns=rows(self.pc.request('GET','/companies/'+self.cfg['company_id']+'/heartbeat-runs'))
        def linked(r):
            context=r.get('contextSnapshot') or {};return r.get('issueId')==pilot['task_id'] or context.get('issueId')==pilot['task_id'] or context.get('taskId')==pilot['task_id']
        return [r for r in allruns if r.get('agentId')==self.cfg['agent_id'] and linked(r)]
    def save_runs(self,pilot,runs):
        for r in runs:
            summary={k:r.get(k) for k in ('id','status','startedAt','finishedAt','usageJson','costUsd','error')}
            summary['token_source']='Paperclip claude_local usageJson'
            usage=r.get('usageJson') or {}
            summary['reported_model']=usage.get('model')
            summary['costUsd']=usage.get('costUsd',r.get('costUsd'))
            summary['billingType']=usage.get('billingType')
            summary['cost_kind']='CLI/adapter reported or estimated cost; not provider subscription bill'
            if r.get('startedAt') and r.get('finishedAt'):
                try:summary['elapsed_seconds']=(dt.datetime.fromisoformat(r['finishedAt'].replace('Z','+00:00'))-dt.datetime.fromisoformat(r['startedAt'].replace('Z','+00:00'))).total_seconds()
                except (ValueError,TypeError):pass
            summary['usage_status']='available' if r.get('usageJson') else 'unknown'
            local=Path(self.cfg['database']).parent/'interactive'/'runs'/r['id']/'summary.json'
            if local.is_file():
                detail=read_json(local)
                summary['interactive']=detail
                summary['usage_status']=detail.get('usage_status','unknown')
                summary['token_source']='Claude persisted transcript, deduplicated by message ID'
                if summary['usage_status']=='unknown':summary['usageJson']=None
                summary['costUsd']=None
                summary['cost_kind']='unknown; interactive transcript has no authoritative cost ledger'
                if detail.get('status')=='no_model_invocation':
                    summary['token_source']='No Claude process or model invocation; automatic wake skipped'
                    summary['reported_model']=None
                    summary['costUsd']=0
                    summary['cost_kind']='No model invocation'
            with self.db:self.db.execute('INSERT INTO runs VALUES(?,?,?,?) ON CONFLICT(run_id) DO UPDATE SET data=excluded.data,updated_at=excluded.updated_at',(r['id'],pilot['jira_key'],json.dumps(summary,ensure_ascii=False),now()))
    def lease_clear(self,pilot,runs):
        lease=self.db.execute('SELECT * FROM leases WHERE jira_key=?',(pilot['jira_key'],)).fetchone()
        if not lease:return
        record=next((r for r in runs if r['id']==lease['run_id']),None)
        if not record:record=self.pc.request('GET','/heartbeat-runs/'+lease['run_id'])
        if record.get('status') in TERMINAL and not processes_for_run(lease['run_id']):
            with self.db:self.db.execute('DELETE FROM leases WHERE jira_key=? AND run_id=?',(pilot['jira_key'],lease['run_id']))
        else:raise BridgeError('旧运行尚未确认停止，不能释放工单执行权')
    def wake(self,pilot,reason,confirmation=None,interactive_nonce=None):
        intent=digest({'task':pilot['task_id'],'reason':reason,'confirmation':confirmation})
        if pilot['last_wakeup']==intent:return
        # Persist the intent first. An uncertain request is NOT automatically resent.
        self.update(pilot['jira_key'],last_wakeup=intent,status='wakeup_pending',last_error=None)
        body={'source':'automation','triggerDetail':'callback','reason':reason,'payload':{'issueId':pilot['task_id'],'taskId':pilot['task_id']},'idempotencyKey':'dsp7-'+intent,'forceFreshSession':True}
        if interactive_nonce:body['payload']['dsp7InteractiveNonce']=interactive_nonce
        result=self.pc.request('POST','/agents/'+self.cfg['agent_id']+'/wakeup',body)
        self.event(pilot['jira_key'],'wakeup',{'intent':intent,'result':result,'confirmation':confirmation})
        if result.get('status')=='skipped':raise BridgeError('唤醒未接受；请查看 wakeup 记录后人工恢复')
        self.update(pilot['jira_key'],status='dispatched',consumed_confirmation=confirmation if confirmation else pilot['consumed_confirmation'])
    def notify_block(self,pilot,state):
        cur=self.jc.current_confirmation(state)
        if not cur:return
        cid=cur['确认编号'];notice_key=pilot['jira_key']+':'+cid
        notice=self.db.execute('SELECT status FROM notices WHERE notice_key=?',(notice_key,)).fetchone()
        if notice and notice['status'] in ('sent','unknown'):return
        mode=self.cfg.get('notifications','local');message=f"{pilot['jira_key']} 等待 Jira 决策 #{cid}；请打开工单确认。"
        if mode=='dingtalk':
            if not pilot['details'].get('notifications_authorized'):raise BridgeError('尚未授权该试点的钉钉提醒')
            # Existing Harness delivery deduplication and unknown-outcome policy are reused.
            args=self.notify.build_parser().parse_args(['--event','confirmation','--state',pilot['details']['state_path'],'--details='+cur['待确认事项']])
            context=self.notify.build_context(args,state,os.environ,self.notify._local_environment())
            fingerprint=self.notify.notification_fingerprint(context,confirmation_id=cid)
            old=(state.get('钉钉通知') or {}).get('confirmation') or {}
            if old.get('指纹')==fingerprint and old.get('状态') in ('sent','unknown'):
                status=old['状态']
            else:
                webhook=self.notify.resolve_setting('DINGTALK_WEBHOOK_URL',os.environ,self.notify._local_environment())
                if not webhook:raise BridgeError('未配置钉钉 Webhook')
                # Record unknown before sending, so a crash cannot cause blind re-delivery.
                with self.db:self.db.execute('INSERT OR REPLACE INTO notices VALUES(?,?,?,?)',(notice_key,pilot['jira_key'],'unknown',now()))
                try:
                    _,attempts=self.notify.send_with_retry(webhook,self.notify.build_payload(context,confirmation_id=cid));status='sent'
                    self.notify._record_state(Path(pilot['details']['state_path']),state,'confirmation',fingerprint,status,attempts=attempts)
                except self.notify.NotificationError as e:
                    status='unknown' if e.unknown else 'failed'
                    self.notify._record_state(Path(pilot['details']['state_path']),state,'confirmation',fingerprint,status,error=str(e))
        elif mode=='local':
            from seat_control import notify
            delivery=notify('智研协同平台：工单待确认',message)
            status='sent' if delivery=='submitted' else delivery
        else:raise BridgeError('未知通知模式')
        with self.db:self.db.execute('INSERT OR REPLACE INTO notices VALUES(?,?,?,?)',(notice_key,pilot['jira_key'],status,now()))
        self.event(pilot['jira_key'],'notification',{'confirmation':cid,'channel':mode,'status':status})
    def sync_page_confirmation(self,pilot,state,task,active=False):
        """Replay only: translate an authenticated board comment into a simulated reply."""
        if pilot['details'].get('mode')!='replay':return
        current=self.jc.current_confirmation(state)
        if not current or current.get('状态')!='pending':return
        allowed=self.cfg.get('paperclip_replay_approver_user_ids') or []
        if not isinstance(allowed,list) or not all(isinstance(x,str) and x for x in allowed):
            raise BridgeError('模拟页面审批用户配置无效')
        if not allowed:return
        cid=current['确认编号'];requested=self.jc.parse_time(current.get('请求时间'))
        if not requested:raise BridgeError('待确认请求时间无效')
        comments=rows(self.pc.request('GET','/issues/'+task['id']+'/comments'))
        folder=Path(pilot['details']['comments_path']).parent
        receipt_path=folder/'paperclip-confirmation-receipts.json'
        with (folder/'.confirmation.lock').open('a') as lock:
            fcntl.flock(lock,fcntl.LOCK_EX)
            receipts=read_json(receipt_path) if receipt_path.exists() else {'decisions':{}}
            receipt=receipts['decisions'].get(cid)
            if not receipt:
                local_existing=read_json(pilot['details']['comments_path'])
                for old in local_existing.get('comments',[]):
                    if cid in str(old.get('body') or '') and not old.get('source'):
                        if self.jc.classify_reply(str(old['body']),cid)[0] in ('approved','rejected'):
                            return  # Preserve an earlier explicit terminal simulation decision.
                candidates=[]
                for comment in comments:
                    body=str(comment.get('body') or '').strip()
                    # The rich-text editor escapes a leading Markdown hash.
                    if body.startswith('\\#'):body=body[1:]
                    match=re.fullmatch(r'#?'+re.escape(cid)+r'\s+(同意|拒绝)(?:[：: \n]+[^\n]+)?',body)
                    created=self.jc.parse_time(comment.get('createdAt'))
                    if not match or not created or created<requested or created>dt.datetime.now(dt.timezone.utc)+dt.timedelta(minutes=5):continue
                    if comment.get('authorAgentId') or comment.get('authorUserId') not in allowed or not comment.get('id'):continue
                    if comment.get('deletedAt'):continue
                    candidates.append((created,str(comment['id']),comment,match.group(1)))
                if not candidates:return
                # The first valid decision is immutable for this confirmation ID.
                created,comment_id,comment,verdict=min(candidates,key=lambda x:(x[0],x[1]))
                receipt={'confirmation':cid,'task_id':task['id'],'source':'paperclip_comment','source_comment_id':comment_id,
                         'source_author_user_id':comment['authorUserId'],'source_created_at':comment['createdAt'],
                         'source_body':comment['body'],'verdict':'approved' if verdict=='同意' else 'rejected',
                         'simulated':True,'external_jira_write':False,'received_at':now()}
                receipts['decisions'][cid]=receipt;atomic_json(receipt_path,receipts)
                self.event(pilot['jira_key'],'paperclip_replay_decision',receipt)
            local=read_json(pilot['details']['comments_path'])
            local_id='paperclip-'+receipt['source_comment_id']
            if not any(x.get('id')==local_id for x in local.get('comments',[])):
                local.setdefault('comments',[]).append({'id':local_id,'created':receipt['source_created_at'],
                    'body':'#'+cid+' '+('同意' if receipt['verdict']=='approved' else '拒绝'),
                    'author':{'name':pilot['details']['assignee'],'displayName':pilot['details']['assignee_name']},
                    'simulated':True,'source':receipt})
                atomic_json(pilot['details']['comments_path'],local)
            # Publish through the description, which does not enqueue a comment
            # wake, and retain an exact marker for crash/retry deduplication.
            marker='<!-- DSP7-PAGE-CONFIRM:'+cid+' -->'
            existing=str(task.get('description') or '')
            connected_auto=False
            if active and self.cfg.get('same_session_resume'):
                runtime=Path(self.cfg['database']).parent/'interactive'/'runs'
                for run in self.runs_for(pilot):
                    if run['status']!='running':continue
                    info_path=runtime/run['id']/'session.json';wait_path=runtime/run['id']/'wait.json'
                    if not info_path.is_file():continue
                    info=read_json(info_path);waiting=read_json(wait_path) if wait_path.is_file() else {}
                    if info.get('same_session_resume') and waiting.get('status') not in ('wait_timeout','interrupted','disabled','task_unavailable'):
                        connected_auto=True
            if marker not in existing:
                if receipt['verdict']=='approved':
                    result=('模拟确认已收到：同意。支持 Stop hook 的已连接会话将自动续传，无需 /exit；离线则等待重连。' if connected_auto else '模拟确认已收到：同意。等待本地续传。在 Mac 执行 harness start '+pilot['jira_key']+' --confirm-no-other-executor。')
                else:result='模拟确认已收到：拒绝。保持阻塞，不启动开发；修订方案后需新确认编号。'
                section='\n\n'+marker+'\n### 页面模拟确认结果\n'+result+'\n确认编号：'+cid+'\n审批用户 ID：'+receipt['source_author_user_id']+'\n来源评论：'+receipt['source_comment_id']+'\n本记录仅用于模拟，未写真实 Jira。'
                self.pc.request('PATCH','/issues/'+task['id'],{'description':existing+section})
            self.update(pilot['jira_key'],status='awaiting_local_resume' if receipt['verdict']=='approved' else 'decision_rejected')

    def publish_confirmation_status(self,pilot,state):
        """Publish display-only receipt projection; never change domain approval."""
        if pilot['details'].get('mode')!='replay' or not pilot.get('task_id'):return
        task=self.pc.request('GET','/issues/'+pilot['task_id'])
        comments=rows(self.pc.request('GET','/issues/'+task['id']+'/comments'))
        folder=Path(pilot['details']['comments_path']).parent
        file=folder/'paperclip-confirmation-receipts.json'
        receipts=read_json(file).get('decisions',{}) if file.exists() else {}
        current=self.jc.current_confirmation(state) or {}
        runtime=Path(self.cfg['database']).parent/'interactive'/'runs'
        dispatched={}
        for entry in self.db.execute("SELECT run_id,data FROM events WHERE jira_key=? AND kind='same_session_resume_dispatch' ORDER BY id",(pilot['jira_key'],)):
            value=json.loads(entry['data']);source=value.get('decision_comment_id','')
            if source.startswith('paperclip-'):dispatched[source[len('paperclip-'):]]=entry['run_id']
        projection={}
        for comment in comments:
            if not comment.get('authorUserId') or comment.get('authorAgentId') or comment.get('deletedAt'):continue
            body=str(comment.get('body') or '').strip()
            if body.startswith('\\#'):body=body[1:]
            match=re.match(r'#?(JCONF-[A-Z0-9-]+)(?:\s|$)',body)
            if not match:continue
            cid=match.group(1);status='submitted';message='已提交，等待核验';rid=dispatched.get(comment['id'])
            receipt=receipts.get(cid)
            if receipt and receipt['source_comment_id']==comment['id']:
                status=receipt['verdict'];message='同意已接受，等待续传' if status=='approved' else '拒绝已接受，保持阻塞'
                if status=='approved' and rid:
                    status='resuming';message='Claude 已继续'
                    if state.get('状态')=='completed':status='completed';message='审批已处理，模拟任务已完成'
                elif status=='approved':
                    for entry in self.db.execute('SELECT run_id FROM leases WHERE jira_key=?',(pilot['jira_key'],)):
                        wait_file=runtime/entry['run_id']/'wait.json'
                        waiting=read_json(wait_file) if wait_file.exists() else {}
                        if waiting.get('confirmation')==cid and waiting.get('status')=='waiting_terminal':
                            status='waiting_terminal';message='同意已接受，等待本地终端重连'
            else:
                requested=self.jc.parse_time(current.get('请求时间'));created=self.jc.parse_time(comment.get('createdAt'))
                if not re.fullmatch(r'#?'+re.escape(cid)+r'\s+(同意|拒绝)(?:[：: \n]+[^\n]+)?',body):
                    status='invalid';message='回复无效：请使用“同意”或“拒绝”'
                elif comment['authorUserId'] not in self.cfg.get('paperclip_replay_approver_user_ids',[]):
                    status='invalid';message='回复无效：当前账号未获审批授权'
                elif cid!=current.get('确认编号') or not created or not requested or created<requested:
                    status='invalid';message='回复无效：编号或评论时间不适用于当前确认'
                elif receipt:
                    status='invalid';message='已有固定审批决定，此评论不会覆盖原决定'
            projection[comment['id']]={'status':status,'message':message,'confirmation':cid,'runId':rid}
        data={'version':1,'source':'dsp7_bridge','comments':projection}
        marker='<!-- DSP7-CONFIRMATION-STATUS '+json.dumps(data,ensure_ascii=True,separators=(',',':'))+' -->'
        description=str(task.get('description') or '')
        cleaned=re.sub(r'\n?<!-- DSP7-CONFIRMATION-STATUS .*? -->','',description)
        updated=cleaned+'\n'+marker
        if updated!=description:self.pc.request('PATCH','/issues/'+task['id'],{'description':updated})

    def tick_pilot(self,pilot):
        self.validate_jira(pilot);self.worktree_check(pilot['details'])
        task=self.ensure_task(pilot);pilot=self.pilot(pilot['jira_key'])
        runs=self.runs_for(pilot);self.save_runs(pilot,runs)
        active=[r for r in runs if r['status'] in ACTIVE]
        page_state=self.state(pilot,required=False)
        self.sync_page_confirmation(pilot,page_state,task,active=bool(active))
        self.publish_confirmation_status(pilot,self.state(pilot,required=False))
        if active:
            if pilot['details'].get('execution_mode')=='interactive' and task['status']=='blocked':
                state=self.state(pilot,required=False)
                if self.jc.current_confirmation(state):self.notify_block(pilot,state)
            return
        self.lease_clear(pilot,runs)
        state=self.state(pilot,required=False)
        phase=str(state.get('当前Phase') or '')
        if phase and pilot['last_phase']!=phase:
            self.event(pilot['jira_key'],'phase_observed',{'phase':phase});self.update(pilot['jira_key'],last_phase=phase)
        if task['status']=='done':
            completion=Path(pilot['details']['state_path']).parent/'paperclip-completion.json'
            if state.get('状态')!='completed' or not completion.is_file():raise BridgeError('Paperclip 已 done 但缺少领域完成证据，需人工核对')
            self.update(pilot['jira_key'],status='done',enabled=0);return
        if task['status']=='cancelled':self.update(pilot['jira_key'],status='cancelled',enabled=0);return
        cur=self.jc.current_confirmation(state)
        if task['status']=='blocked' and cur:
            if cur.get('状态')=='pending':self.notify_block(pilot,state)
            if pilot['details'].get('execution_mode')=='interactive' or not self.cfg.get('auto_resume',False):return
            base,token=self.jira_config();comments=read_json(pilot['details']['comments_path']).get('comments',[]) if pilot['details'].get('mode')=='replay' else self.jc.fetch_comments(pilot['jira_key'],base,token)
            # Resolve on a copy, never mutate authoritative state outside the Agent.
            import copy
            copy_state=copy.deepcopy(state)
            from tempfile import TemporaryDirectory
            with TemporaryDirectory() as tmp:
                verdict,record=self.jc.resolve_confirmation(Path(tmp)/'state.json',copy_state,comments)
            if verdict=='approved' and record and record.get('确认编号')!=pilot['consumed_confirmation']:
                self.validate_jira(pilot)
                self.wake(pilot,('用户授权的 replay 模拟续传：只依次调用 agent inspect、agent claim、agent replay，脚本会校验本地模拟确认；禁止直接运行 jira_confirmation.py 或业务技能。' if pilot['details'].get('mode')=='replay' else 'Jira 有效确认后续传；先运行 jira_confirmation.py 再按 jira-resume 恢复'),record['确认编号'])
            return
        if pilot['details'].get('execution_mode')=='interactive':return
        if not pilot['last_wakeup']:
            # Assignment in backlog is persisted before the explicit wakeup.
            if task.get('assigneeAgentId') not in (None,self.cfg['agent_id']):raise BridgeError('任务已分派给其他 Agent')
            self.pc.request('PATCH','/issues/'+task['id'],{'assigneeAgentId':self.cfg['agent_id']})
            self.wake(pilot,'开始已登记的单人工单；先 claim 并检查 Harness 门禁')
    def tick(self):
        latest=read_json(self.config_path)
        if any(latest.get(k)!=self.cfg.get(k) for k in ('agent_id','company_id','database','harness_root','paperclip_url','credential_file')):
            return [{'configuration_error':'接入身份或运行路径已变化，请重启本机接入桥'}]
        self.cfg=latest
        errors=[]
        from seat_control import tick as seat_tick
        try:seat_tick(self)
        except (BridgeError,ValueError,OSError,subprocess.SubprocessError):errors.append({"seat_control_error":"席位心跳或请求处理失败，请核对本机登记与服务器连接"})
        from jira_dispatch import tick as dispatch_tick
        try:dispatch_tick(self)
        except (BridgeError,ValueError,OSError) as e:errors.append({'jira_dispatch_error':str(e)})
        from jira_intake import process_requests
        try:process_requests(self)
        except (BridgeError,ValueError,OSError) as e:errors.append({"web_intake_error":str(e)})
        for row in self.db.execute('SELECT jira_key FROM pilots WHERE enabled=1').fetchall():
            pilot=self.pilot(row['jira_key'])
            try:
                from jira_dispatch import monitor
                finishing=monitor(self,pilot)
                if not finishing and self.pilot(pilot['jira_key'])['enabled']:self.tick_pilot(self.pilot(pilot['jira_key']))
            except BridgeError as e:
                message=str(e);self.update(pilot['jira_key'],last_error=message)
                errors.append({'jira_key':pilot['jira_key'],'error':message})
        return errors
    def current_pilot(self):
        task_id=self.env['PAPERCLIP_TASK_ID'];row=self.db.execute('SELECT jira_key FROM pilots WHERE task_id=?',(task_id,)).fetchone()
        if not row:raise BridgeError('当前任务不属于已登记的试点')
        pilot=self.pilot(row['jira_key'])
        if not pilot['enabled']:raise BridgeError('当前试点已停用')
        task=self.pc.request('GET','/issues/'+task_id)
        if task.get('assigneeAgentId')!=self.env['PAPERCLIP_AGENT_ID'] or task.get('companyId')!=self.cfg['company_id']:raise BridgeError('任务归属不匹配')
        return pilot,task
    def require_lease(self,pilot):
        from seats import check
        check(self,pilot)
        row=self.db.execute('SELECT run_id FROM leases WHERE jira_key=?',(pilot['jira_key'],)).fetchone()
        if not row or row['run_id']!=self.env['PAPERCLIP_RUN_ID']:raise BridgeError('必须先 claim 当前真实运行的工单执行权')
    def agent(self,action,data):
        pilot,task=self.current_pilot();key=pilot['jira_key'];rid=self.env['PAPERCLIP_RUN_ID'];d=pilot['details'];path=Path(d['state_path'])
        if action=='inspect':return {'jira_key':key,'run_id':rid,'task_id':task['id'],'details':d,'state':self.state(pilot,required=False)}
        if action=='claim':
            self.validate_jira(pilot);self.worktree_check(d)
            pids=processes_for_run(rid)
            if len(pids)!=1:raise BridgeError('未找到唯一的当前 Claude 进程，禁止取得执行权')
            with self.db:
                old=self.db.execute('SELECT run_id FROM leases WHERE jira_key=?',(key,)).fetchone()
                if old and old['run_id']!=rid:raise BridgeError('工单已有其他执行者')
                self.db.execute('INSERT OR IGNORE INTO leases VALUES(?,?,?)',(key,rid,now()))
            if task.get('checkoutRunId')!=rid:self.pc.request('POST','/issues/'+task['id']+'/checkout',{'agentId':self.cfg['agent_id'],'expectedStatuses':['backlog','todo','in_progress','blocked']})
            self.event(key,'claimed',{'pids':pids},rid);return {'status':'claimed','jira_key':key,'run_id':rid}
        self.require_lease(pilot)
        if task.get('checkoutRunId')!=rid:raise BridgeError('Paperclip checkout run 不匹配')
        state=self.state(pilot)
        summary=str(data.get('summary') or ('执行模拟闭环' if action=='replay' else '')).strip()
        if not summary or len(summary)>10000:raise BridgeError('需要 1–10000 字符 summary')
        if action=='replay':
            if d.get('mode')!='replay':raise BridgeError('此动作仅允许显式模拟工单')
            current=self.jc.current_confirmation(state)
            if current and current.get('状态')=='pending':
                verdict,resolved=self.jc.resolve_confirmation(path,state,read_json(d['comments_path'])['comments'])
                current=resolved or self.jc.current_confirmation(state)
                if verdict=='pending':
                    self.pc.request('PATCH','/issues/'+task['id'],{'status':'blocked','unblockDescriptor':{'owner':{'agentId':self.cfg['agent_id']},'action':'等待有效模拟 Jira 确认 #'+current['确认编号']},'comment':'模拟任务等待确认 #'+current['确认编号']+'；保存原阶段并结束本次运行。'})
                    return {'status':'blocked','confirmation':current['确认编号'],'instruction':('保持终端，只结束本轮输出；Stop hook 等待审批后自动续传，不要 /exit。' if os.environ.get('DSP7_SAME_SESSION_RESUME')=='1' else '结束当前运行，勿等待窗口输入。')}
                if verdict!='approved':raise BridgeError('模拟确认尚未有效同意')
                state=read_json(path)
            if not current:
                self.agent('stage',{'summary':'模拟 P1：读取真实设计单快照，工单已完成；演示待决策流程。'})
                return self.agent('block',{'summary':'模拟需求澄清：本次是否只生成接入验收报告，不修改已完成工单、银行接口或源码？','options':['同意仅生成模拟验收报告','拒绝本次模拟方案']})
            if current.get('状态')!='approved':raise BridgeError('模拟回复不是同意，保持阻塞')
            state['当前Phase']='P2';self.jc.atomic_write_json(path,state)
            self.agent('stage',{'summary':'模拟 P2：JCONF 身份、编号和时间校验通过，从原状态继续。'})
            receipt={'simulated':True,'ticket_no':key,'confirmation':current['确认编号'],'external_write':False,'created_at':now()}
            atomic_json(path.parent/'tracker-replay-receipt.json',receipt)
            (path.parent/'verification.md').write_text('# 模拟验收报告\n\n真实 Jira 工单只读；本次通过 Paperclip 正式运行完成阻塞和续传。\n确认校验：approved。tracker 回执为模拟，本次没有业务交付或外部 Jira/tracker 写入。\n',encoding='utf-8')
            state['当前Phase']='P3';state['状态']='completed';self.jc.atomic_write_json(path,state)
            return self.agent('complete',{'summary':'模拟闭环完成：正式运行启动、阻塞、Mac 提醒、模拟 Jira 确认、正式运行续传和模拟 tracker 回执。未改变原工单或业务数据。','evidence':['verification.md','tracker-replay-receipt.json'],'tracker':{'status':'simulated','record_file':'tracker-replay-receipt.json'},'jira_evidence_comment_id':'replay-only'})
        if action=='stage':
            event={'phase':state.get('当前Phase'),'summary':summary,'evidence':data.get('evidence',[])}
            self.event(key,'stage',event,rid)
            self.pc.request('POST','/issues/'+task['id']+'/comments',{'body':f"阶段 {event['phase']}：{summary}"})
            return {'status':'reported','phase':event['phase']}
        if action=='block':
            self.validate_jira(pilot)
            if state.get('状态')=='completed':raise BridgeError('已完成工单不能创建待确认事项')
            state['标题']=d['title'];state['经办人']={'账号':d['assignee'],'显示名':d['assignee_name']}
            details=summary
            if data.get('options'):details+='\n可选方案：'+json.dumps(data['options'],ensure_ascii=False)
            context=self.notify.NotificationContext('confirmation',key,d['title'],d['assignee_name'],d['assignee'],details,self.jira_config()[0]+'/browse/'+key,())
            cid=self.notify.prepare_jira_confirmation(path,state,context)
            # Never interpolate issue text into shell commands.
            comments=read_json(d['comments_path'])['comments'] if d.get('mode')=='replay' else self.jc.fetch_comments(key,*self.jira_config())
            marker='['+cid+']'
            if d.get('mode')!='replay' and not any(marker in self.jc.comment_text(c.get('body')) for c in comments):
                self.jira().request('POST','/rest/api/2/issue/'+key+'/comment',{'body':marker+' Harness 待确认\n'+details+'\n请经办人回复 #'+cid+' 同意/拒绝/评审意见。'})
            report={'phase':state.get('当前Phase'),'summary':summary,'confirmation':cid,'options':data.get('options',[]),'status':'blocked'}
            atomic_json(path.parent/'paperclip-block.json',report);self.event(key,'blocked',report,rid)
            self.pc.request('PATCH','/issues/'+task['id'],{'status':'blocked','unblockDescriptor':{'owner':{'agentId':self.cfg['agent_id']},'action':'校验 Jira 确认 #'+cid+' 后从 Harness 状态续传'},'comment':(f"等待页面模拟确认 #{cid}\n{summary}\n请授权审批人在本页回复：#{cid} 同意 或 #{cid} 拒绝。仅写本地模拟记录。新版已连接会话收到有效同意后自动续传；不要使用“确认”代替“同意”。" if d.get('mode')=='replay' else f"等待 Jira 确认 #{cid}\n{summary}\n{context.issue_url}")})
            return {'status':'blocked','confirmation':cid,'instruction':('保持终端，只结束本轮输出；Stop hook 等待审批后自动续传，不要 /exit。' if os.environ.get('DSP7_SAME_SESSION_RESUME')=='1' else '结束当前运行，勿等待窗口输入。')}
        if action=='complete':
            if state.get('状态')!='completed':raise BridgeError('领域 state 尚未 completed')
            current=self.jc.current_confirmation(state)
            if current and current.get('状态')!='approved':raise BridgeError('尚有未完成的 Jira 工程确认')
            evidence=data.get('evidence')
            if not isinstance(evidence,list) or not evidence:raise BridgeError('需提供交付证据文件列表')
            for name in evidence:
                file=(path.parent/str(name)).resolve()
                if not file.is_relative_to(path.parent.resolve()) or not file.is_file() or file.stat().st_size==0:raise BridgeError('交付证据必须是本工单目录内非空文件')
            tracker=data.get('tracker') or {}
            if d.get('mode')=='replay' and tracker.get('status')=='simulated':
                receipt=read_json(path.parent/'tracker-replay-receipt.json')
                if receipt.get('ticket_no')!=key or receipt.get('simulated') is not True:raise BridgeError('模拟回执不匹配')
                self.event(key,'simulation_completed',data,rid)
                atomic_json(path.parent/'paperclip-completion.json',{'run_id':rid,'completed_at':now(),**data})
                self.pc.request('PATCH','/issues/'+task['id'],{'status':'done','unblockDescriptor':None,'comment':summary+'\n本任务仅为模拟验收；不代表原工单重新开发或真实 tracker 上报。'})
                return {'status':'done','mode':'replay','jira_key':key,'run_id':rid}
            if tracker.get('status') not in ('reported','allowed_degradation'):raise BridgeError('需 tracker 回执或 Harness 允许的降级记录')
            if tracker['status']=='reported':
                ticket_id=tracker.get('ticket_id')
                if not ticket_id:raise BridgeError('tracker reported 需真实 ticket_id')
                # Receipt verification is separate from shell/MCP exit code.
                tracker_env=self.jc._server_env(self.jc.read_json(self.root/'.mcp.json'),'harness-tracker-mcp')
                merged={**tracker_env,**self.jc.local_settings_env(),**os.environ}
                token=merged.get('TRACKER_API_KEY') or merged.get('TRACKER_KEY')
                url=merged.get('TRACKER_API_URL') or merged.get('TRACKER_API')
                project=merged.get('TRACKER_PROJECT_ID')
                if not url or not project:raise BridgeError('需显式 tracker API 和 project 配置核验回执')
                headers={'x-api-key':token} if token else {}
                query=urllib.parse.urlencode({'projectId':project,'ticketNo':key})
                req=urllib.request.Request(url.rstrip('/')+'/tickets?'+query,headers=headers)
                try:
                    with urllib.request.urlopen(req,timeout=20) as response:receipt=json.load(response)
                except Exception:raise BridgeError('tracker 回执核验失败') from None
                candidates=rows(receipt)
                matched=[x for x in candidates if str(x.get('id'))==str(ticket_id) and x.get('ticket_no')==key and str(x.get('project_id'))==str(project)]
                if len(matched)!=1:raise BridgeError('tracker 回执工单、ID 或项目不匹配')
            elif not tracker.get('reason') or not tracker.get('record_file'):raise BridgeError('降级需理由和工单内持久化记录')
            else:
                file=(path.parent/str(tracker['record_file'])).resolve()
                if not file.is_relative_to(path.parent.resolve()) or not file.is_file():raise BridgeError('降级记录不存在')
            if not data.get('jira_evidence_comment_id'):raise BridgeError('需 Jira 交付评论 ID')
            comment=self.jira().request('GET','/rest/api/2/issue/'+key+'/comment/'+urllib.parse.quote(str(data['jira_evidence_comment_id']),safe=''))
            if not comment.get('id') or not self.jc.comment_text(comment.get('body')):raise BridgeError('Jira 交付评论不存在')
            self.worktree_check(d)
            if d['workflow']!='design':
                source=state.get('源码工作树') or {}
                if Path(str(source.get('repo') or '')).resolve()!=Path(d['worktree']).resolve() or source.get('linked_worktree') is not True:raise BridgeError('完成 state 的源码工作树证据不匹配')
                head=subprocess.run(['git','-C',d['worktree'],'rev-parse','HEAD'],capture_output=True,text=True,check=True).stdout.strip()
                if source.get('head')!=head:raise BridgeError('源码 HEAD 与完成 state 不匹配')
            self.event(key,'completed',data,rid)
            atomic_json(path.parent/'paperclip-completion.json',{'run_id':rid,'completed_at':now(),**data})
            self.pc.request('PATCH','/issues/'+task['id'],{'status':'done','unblockDescriptor':None,'comment':summary+'\ntracker: '+tracker['status']+'\nJira comment: '+str(comment['id'])})
            return {'status':'done','jira_key':key,'run_id':rid}
        raise BridgeError('不支持的 agent 操作')
    def report(self):
        return {'generated_at':now(),'pilots':[dict(x)|{'config':'<local configuration>'} for x in self.db.execute('SELECT * FROM pilots')],
                'runs':[dict(x)|{'data':json.loads(x['data'])} for x in self.db.execute('SELECT * FROM runs')],
                'events':[dict(x)|{'data':json.loads(x['data'])} for x in self.db.execute('SELECT * FROM events ORDER BY id')],
                'notifications':[dict(x) for x in self.db.execute('SELECT * FROM notices')]}

def main():
    parser=argparse.ArgumentParser(description=__doc__);parser.add_argument('--config',type=Path,default=DEFAULT_CONFIG)
    commands=parser.add_subparsers(dest='command',required=True)
    p=commands.add_parser('register-replay');p.add_argument('--jira',required=True);p.add_argument('--new-attempt',action='store_true')
    p=commands.add_parser('replay-confirm');p.add_argument('jira_key');p.add_argument('--verdict',choices=('approve','reject'),required=True)
    commands.add_parser('doctor');commands.add_parser('status');commands.add_parser('once');commands.add_parser('watch')
    p=commands.add_parser('register');p.add_argument('--jira',required=True);p.add_argument('--workflow',choices=WORKFLOWS,required=True);p.add_argument('--worktree',required=True);p.add_argument('--ready-status',action='append',required=True);p.add_argument('--allow-notifications',action='store_true')
    p=commands.add_parser('enable');p.add_argument('jira_key');p.add_argument('--confirm-no-other-executor',action='store_true',required=True)
    p=commands.add_parser('disable');p.add_argument('jira_key')
    p=commands.add_parser('cancel');p.add_argument('jira_key')
    p=commands.add_parser('retry');p.add_argument('jira_key');p.add_argument('--reason',required=True)
    p=commands.add_parser('report');p.add_argument('--output',type=Path)
    p=commands.add_parser('agent');p.add_argument('action',choices=('inspect','claim','stage','block','complete','replay'))
    args=parser.parse_args();b=Bridge(args.config,agent=args.command=='agent')
    if args.command=='agent':
        raw=sys.stdin.read(65537) if args.action in ('stage','block','complete') else '{}'
        if len(raw)>65536:raise BridgeError('输入过大')
        data=json.loads(raw)
        if not isinstance(data,dict):raise BridgeError('输入必须是 JSON 对象')
        result=b.agent(args.action,data)
    elif args.command=='register-replay':result=b.register_replay(args.jira,args.new_attempt)
    elif args.command=='replay-confirm':result=b.replay_confirm(args.jira_key,args.verdict)
    elif args.command=='register':result=b.register(args.jira,args.workflow,args.worktree,args.ready_status,args.allow_notifications)
    elif args.command=='enable':
        pilot=b.pilot(args.jira_key);b.validate_jira(pilot);b.worktree_check(pilot['details'])
        if b.db.execute('SELECT COUNT(*) FROM pilots WHERE enabled=1 AND jira_key<>?',(args.jira_key,)).fetchone()[0]:raise BridgeError('首期仅允许一张启用工单')
        b.update(args.jira_key,enabled=1,last_error=None);result={'jira_key':args.jira_key,'enabled':True}
    elif args.command=='cancel':
        pilot=b.pilot(args.jira_key);b.update(args.jira_key,enabled=0)
        affected=[]
        for r in b.runs_for(pilot):
            if r['status'] in ACTIVE:b.pc.request('POST','/heartbeat-runs/'+r['id']+'/cancel',{})
            if r['status'] in ACTIVE or processes_for_run(r['id']):
                stop_run_locally(r['id']);affected.append(r['id'])
        b.lease_clear(pilot,b.runs_for(pilot));b.event(args.jira_key,'cancelled',{'runs':affected})
        result={'jira_key':args.jira_key,'stopped_runs':affected,'enabled':False}
    elif args.command=='retry':
        pilot=b.pilot(args.jira_key);runs=b.runs_for(pilot)
        if pilot['details'].get('execution_mode')=='interactive':raise BridgeError('交互工单请使用 harness start 主动续传')
        if any(r['status'] in ACTIVE for r in runs):raise BridgeError('已有活动运行，禁止重试')
        b.lease_clear(pilot,runs);b.validate_jira(pilot);b.worktree_check(pilot['details'])
        b.wake(pilot,'人工核验后重试：'+args.reason);result={'jira_key':args.jira_key,'retry':'requested'}
    elif args.command=='disable':b.pilot(args.jira_key);b.update(args.jira_key,enabled=0);result={'jira_key':args.jira_key,'enabled':False,'note':'停止新调度，不代表旧进程已停止；取消需在 Paperclip 中操作并确认。'}
    elif args.command=='doctor':
        me=b.pc.request('GET','/cli-auth/me');base,token=b.jc.resolve_jira_config()
        if me.get('isInstanceAdmin') or b.cfg['company_id'] not in me.get('companyIds',[]):raise BridgeError('服务身份权限异常')
        jira_me=b.jira().request('GET','/rest/api/2/myself')
        webhook=bool(b.notify.resolve_setting('DINGTALK_WEBHOOK_URL',os.environ,b.notify._local_environment()))
        result={'paperclip':'connected','identity':'non-admin','jira':'connected','jira_account':jira_me.get('name'),'notification_mode':b.cfg.get('notifications'),'dingtalk_configured':webhook,'pilots':b.db.execute('SELECT COUNT(*) FROM pilots').fetchone()[0]}
    elif args.command=='report':
        result=b.report()
        if args.output:atomic_json(args.output,result);result={'report':str(args.output)}
    elif args.command=='status':result=b.report()['pilots']
    else:
        lock_path=Path(b.cfg['database']).with_suffix('.watch.lock')
        with lock_path.open('a') as lock:
            try:fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
            except BlockingIOError:raise BridgeError('已有接入桥监督进程') from None
            if args.command=='once':result={'errors':b.tick()}
            else:
                print(json.dumps({'status':'watching','at':now()},ensure_ascii=False),flush=True)
                base_delay=max(10,int(b.cfg.get('poll_seconds',20)));delay=base_delay
                while True:
                    errors=b.tick()
                    if errors:print(json.dumps({'at':now(),'errors':errors},ensure_ascii=False),flush=True)
                    delay=min(300,max(base_delay,delay*2)) if errors else base_delay
                    time.sleep(delay)
    print(json.dumps(result,ensure_ascii=False,indent=2))
if __name__=='__main__':
    try:main()
    except (BridgeError,ValueError,KeyError,sqlite3.Error) as e:
        print(json.dumps({'error':str(e)},ensure_ascii=False),file=sys.stderr);sys.exit(2)
