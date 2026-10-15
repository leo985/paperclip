"""Jira assignee discovery using local credentials; website rules authorize execution."""
from platform_support import fcntl
import json
import time
import urllib.parse
from pathlib import Path
from pilot import BridgeError, TYPE_WORKFLOW, atomic_json, read_json, now, ACTIVE, stop_run_locally
from seats import identity,seat_api


def rule_for(b):
    rule=seat_api(b).request('POST','/agents/'+b.cfg['agent_id']+'/dsp7-jira-dispatch',identity(b)).get('rule')
    revision=(rule or {}).get('revision')
    if getattr(b,'_jira_rule_revision',None)!=revision:
        b.__dict__.pop('_jira_credentials',None)
        b._jira_rule_revision=revision
    configured=bool(rule and rule.get('jiraPatConfigured'))
    if bool(b.cfg.get('jira_dispatch_credentials'))!=configured:
        with (Path(b.cfg['database']).parent/'config.lock').open('a') as lock:
            fcntl.flock(lock,fcntl.LOCK_EX)
            latest=read_json(b.config_path);latest['jira_dispatch_credentials']=configured;atomic_json(b.config_path,latest)
            b.cfg['jira_dispatch_credentials']=configured
    return rule


def authorized(b,p,rule):
    return bool(rule and rule.get('enabled') and p['details'].get('jira_dispatch') and p['details'].get('assignee')==rule['jiraAssignee'] and p['details'].get('project_id')==rule['projectId'] and p['details'].get('source_workspace_id')==rule['workspaceId'])


def verify(b,task_id,start=False):
    return seat_api(b).request('POST','/agents/'+b.cfg['agent_id']+'/dsp7-jira-dispatch/verify',{**identity(b),'taskId':task_id,'start':start})['rule']


def tick(b):
    folder=Path(b.cfg['database']).parent/'jira-dispatch';folder.mkdir(mode=0o700,exist_ok=True)
    path=folder/'scan.json';state=read_json(path) if path.is_file() else {}
    if time.time()-state.get('lastScan',0)<60:return
    rule=rule_for(b)
    if not rule or not rule.get('enabled') or rule.get('intakePaused'):return
    if state.get('revision')!=rule['revision']:state={}
    quote=lambda value:json.dumps(value,ensure_ascii=False)
    jql='project = '+quote(rule['jiraProjectKey'])+' AND assignee = '+quote(rule['jiraAssignee'])+' AND status in ('+','.join(map(quote,rule['readyStatuses']))+') AND issuetype in ('+','.join(map(quote,rule['issueTypes']))+') AND statusCategory != Done ORDER BY created ASC'
    result=b.jira().request('GET','/rest/api/2/search?'+urllib.parse.urlencode({'jql':jql,'startAt':state.get('cursor',0),'maxResults':50,'fields':'summary,status,assignee,issuetype,updated'}))
    api=seat_api(b)
    for issue in result.get('issues',[]):
        f=issue['fields'];account=(f.get('assignee') or {}).get('name') or (f.get('assignee') or {}).get('accountId')
        if account!=rule['jiraAssignee'] or (f['status'].get('statusCategory') or {}).get('key')=='done' or f['issuetype']['name'] not in TYPE_WORKFLOW:continue
        try:
            reply=api.request('POST','/agents/'+b.cfg['agent_id']+'/dsp7-jira-dispatch/discover',{**identity(b),'revision':rule['revision'],'jiraKey':issue['key'],'assignee':account,'status':f['status']['name'],'issueType':f['issuetype']['name'],'summary':f['summary']})
        except BridgeError as error:
            if 'HTTP 409' not in str(error):raise
            # One conflicting legacy/other-seat ticket must not starve the page.
            if not b.db.execute('SELECT 1 FROM events WHERE jira_key=? AND kind=?',(issue['key'],'jira_dispatch_conflict')).fetchone():
                b.event(issue['key'],'jira_dispatch_conflict',{'message':'已有工单登记或执行归属冲突，请在网页核对，保留旧执行权'})
            continue
        if not b.db.execute('SELECT 1 FROM events WHERE jira_key=? AND kind=?',(issue['key'],'jira_assignment_discovered')).fetchone():b.event(issue['key'],'jira_assignment_discovered',{'task_id':reply['taskId'],'rule_revision':rule['revision']})
    cursor=int(result.get('startAt',0))+len(result.get('issues',[]))
    atomic_json(path,{'revision':rule['revision'],'lastScan':time.time(),'cursor':cursor if cursor<int(result.get('total',0)) else 0})


def monitor(b,p):
    """Stop a started dispatched job when Jira assignment/requirements no longer match."""
    if not p['details'].get('jira_dispatch'):return
    completion=Path(p['details']['state_path']).parent/'paperclip-completion.json'
    if completion.is_file() and b.state(p,required=False).get('状态')=='completed':
        task=b.pc.request('GET','/issues/'+p['task_id'])
        if task.get('status')=='done':
            runs=b.runs_for(p)
            if not any(r['status'] in ACTIVE for r in runs):
                b.lease_clear(p,runs);b.update(p['jira_key'],enabled=0,status='done')
            return True
    try:
        verify(b,p['task_id'])
        b.validate_jira(p)
        return
    except BridgeError as error:
        # Connectivity failures are not evidence of a business change.
        if '网络异常' in str(error) or 'HTTP 5' in str(error):raise
        message=str(error)
    runs=b.runs_for(p)
    for run in runs:
        if run['status'] in ACTIVE:
            b.pc.request('POST','/heartbeat-runs/'+run['id']+'/cancel',{})
            stop_run_locally(run['id'])
    b.update(p['jira_key'],enabled=0,last_error=message,status='blocked')
    task=b.pc.request('GET','/issues/'+p['task_id'])
    if task.get('status') not in ('done','cancelled'):
        b.pc.request('PATCH','/issues/'+p['task_id'],{'status':'blocked'})
        b.pc.request('POST','/issues/'+p['task_id']+'/comments',{'body':'自动执行已停止，等待负责人处理：'+message+'。请核对改派、需求或调度规则变化；不会转交未确认停止的执行权。'})
    b.event(p['jira_key'],'jira_dispatch_stopped',{'reason':message,'at':now()})
    from seat_control import once_notice,dingtalk_notice
    saved=Path(b.cfg['database']).parent/'seat-control/state.json'
    policy=(read_json(saved) if saved.is_file() else {}).get('policy') or {}
    notice='dispatch-stopped:'+p['task_id']+':'+str(p['updated_at'])
    once_notice(b,notice,'Paperclip：自动执行已停止',p['jira_key']+' '+message)
    dingtalk_notice(b,policy,p['jira_key'],notice,p['jira_key']+' 自动执行已停止：'+message,p['task_id'],dispatch_authorized=True)


def check_other_executor(b,key):
    """Read-only check for another local Claude already carrying this ticket."""
    import re,shlex,subprocess
    executable=(b.cfg.get('seat_runtime') or {}).get('claudeCommand')
    if __import__('sys').platform=='win32':
        from platform_support import process_table,matches_claude
        for pid,p in process_table().items():
            if executable and matches_claude(p['command'],executable) and re.search(r'(?<![A-Z0-9_-])'+re.escape(key)+r'(?![A-Z0-9_-])',p['command']):
                raise BridgeError('发现本机另一个 Claude 已涉及此工单（PID '+str(pid)+'），请核对；不会停止无关会话')
        return
    result=subprocess.run(['/bin/ps','-axo','pid=,command='],capture_output=True,text=True,check=True)
    for line in result.stdout.splitlines():
        parts=line.strip().split(None,1)
        if len(parts)!=2 or not re.search(r'(?<![A-Z0-9_-])'+re.escape(key)+r'(?![A-Z0-9_-])',parts[1]):continue
        prefix=parts[1].split(' --session-id ',1)[0]
        try:argv=shlex.split(prefix)
        except ValueError:argv=prefix.split(None,1)
        if argv and argv[0]==executable:raise BridgeError('发现本机另一个 Claude 已涉及此工单（PID '+parts[0]+'），暂停自动启动，请核对该进程；不会停止无关会话')
