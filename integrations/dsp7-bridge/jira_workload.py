"""Bounded Jira backlog count for the seat's authorized assignee/project/type scope."""
import time
from managed_sessions import connect

def tick(b):
    from jira_dispatch import rule_for
    from seats import identity,seat_api
    rule=rule_for(b)
    if not rule or not rule.get('jiraPatConfigured'):return
    db=connect(b.cfg)
    try:
        db.execute('CREATE TABLE IF NOT EXISTS workload_checks(key TEXT PRIMARY KEY,checked REAL NOT NULL)')
        last=db.execute("SELECT checked FROM workload_checks WHERE key='jira'").fetchone()
        if last and time.time()-last[0]<300:return
        with db:db.execute("INSERT OR REPLACE INTO workload_checks VALUES('jira',?)",(time.time(),))
        def quote(value):return '"'+str(value).replace('\\','\\\\').replace('"','\\"')+'"'
        kinds=','.join(quote(x) for x in rule['issueTypes'])
        jql='project = '+quote(rule['jiraProjectKey'])+' AND assignee = '+quote(rule['jiraAssignee'])+' AND issuetype in ('+kinds+') AND statusCategory != Done'
        result=b.jira().request('POST','/rest/api/2/search',{'jql':jql,'maxResults':0,'fields':[]})
        total=result.get('total')
        if not isinstance(total,int) or total<0:raise ValueError('Jira 未返回可验证的总数')
        seat_api(b).request('POST','/agents/'+b.cfg['agent_id']+'/managed-jira-workload',{**identity(b),'revision':rule['revision'],'total':total})
    finally:db.close()
