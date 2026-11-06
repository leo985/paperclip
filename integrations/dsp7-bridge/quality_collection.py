"""Daily explicit Jira defect linkage, never infer defects from an execution error."""
from __future__ import annotations
import datetime as dt
import time
from managed_sessions import connect

def tick(b):
    from seats import identity,seat_api
    db=connect(b.cfg)
    try:
        db.execute('CREATE TABLE IF NOT EXISTS quality_checks(task_id TEXT PRIMARY KEY,checked REAL NOT NULL,success REAL NOT NULL DEFAULT 0)')
        candidates=b.db.execute("SELECT jira_key FROM pilots WHERE task_id IS NOT NULL ORDER BY rowid DESC LIMIT 100").fetchall()
        processed=0
        for row in candidates:
            pilot=b.pilot(row['jira_key'])
            if pilot['details'].get('mode')=='replay':continue
            task_id=pilot['task_id']
            checked=db.execute('SELECT checked,success FROM quality_checks WHERE task_id=?',(task_id,)).fetchone()
            if checked and time.time()-checked[0]<86400:continue
            with db:db.execute('INSERT INTO quality_checks(task_id,checked) VALUES(?,?) ON CONFLICT(task_id) DO UPDATE SET checked=excluded.checked',(task_id,time.time()))
            task=b.pc.request('GET','/issues/'+task_id)
            if task.get('status')!='done' or not task.get('completedAt'):continue
            delivery=dt.datetime.fromisoformat(task['completedAt'].replace('Z','+00:00'))
            # Mature samples need one observation covering the full fourteen-day window.
            if checked and checked[1]>=delivery.timestamp()+14*86400:continue
            processed+=1
            source=b.jira().request('GET','/rest/api/2/issue/'+pilot['jira_key']+'?fields=issuelinks,subtasks')
            fields=source.get('fields') or {};links=[]
            for link in fields.get('issuelinks',[]):
                candidate=link.get('inwardIssue') or link.get('outwardIssue')
                if candidate:links.append(candidate)
            links+=fields.get('subtasks',[])
            defects=[]
            for issue in links[:100]:
                kind=str(((issue.get('fields') or {}).get('issuetype') or {}).get('name') or '').lower()
                if kind not in ('bug','缺陷','内部缺陷','线上问题'):continue
                detail=b.jira().request('GET','/rest/api/2/issue/'+issue['key']+'?fields=created,priority')
                f=detail.get('fields') or {};created=dt.datetime.fromisoformat(f['created'].replace('Z','+00:00'))
                defects.append({'key':issue['key'],'createdAt':created.isoformat(),'severity':str((f.get('priority') or {}).get('name') or '未提供')[:100]})
            if len(links)>100:continue  # No partial snapshot may be presented as full linkage coverage.
            seat_api(b).request('POST','/agents/'+b.cfg['agent_id']+'/managed-task-quality',{**identity(b),'taskId':task_id,'jiraKey':pilot['jira_key'],'windowDays':14,'source':'jira-explicit-links','defects':defects})
            with db:db.execute('UPDATE quality_checks SET success=? WHERE task_id=?',(time.time(),task_id))
            if processed>=1:break
    finally:db.close()
