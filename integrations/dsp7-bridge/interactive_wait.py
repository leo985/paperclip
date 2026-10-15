#!/usr/bin/env python3
"""Claude Stop hook: await a verified decision without ending the local session."""
from __future__ import annotations
import contextlib
import copy
from platform_support import fcntl
import json
import os
from pathlib import Path
import signal
import sys
import tempfile
import time

from pilot import Bridge, BridgeError, atomic_json, now, read_json


def main():
    raw=sys.stdin.read(65537)
    if len(raw)>65536:raise BridgeError('Stop hook 输入过大')
    data=json.loads(raw or '{}')
    if os.environ.get('DSP7_SAME_SESSION_RESUME')!='1' or data.get('hook_event_name')!='Stop':return {}
    b=Bridge(agent=True);pilot,task=b.current_pilot();rid=b.env['PAPERCLIP_RUN_ID']
    if data.get('session_id')!=rid:raise BridgeError('Stop hook 会话 ID 不匹配')
    if pilot['details'].get('execution_mode')!='interactive':return {}
    b.require_lease(pilot)
    folder=Path(b.cfg['database']).parent/'interactive'/'runs'/rid
    folder.mkdir(parents=True,exist_ok=True,mode=0o700)
    state=b.state(pilot,required=False);current=b.jc.current_confirmation(state)
    if state.get('状态')=='completed' or not current or current.get('状态')!='pending':
        wait_path=folder/'wait.json'
        if wait_path.exists():
            previous=read_json(wait_path)
            previous.update(status='completed' if state.get('状态')=='completed' else 'resolved_elsewhere',updated_at=now())
            atomic_json(wait_path,previous)
        return {}
    cid=current['确认编号'];receipt_path=folder/'resume-dispatches.json';wait_path=folder/'wait.json'
    # All decisions are delivered at most once within a session. An uncertain
    # hook response is not replayed automatically after a crash.
    with (folder/'wait.lock').open('a') as lock:
        try:fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
        except BlockingIOError:return {}
        dispatch=read_json(receipt_path) if receipt_path.exists() else {'confirmations':{}}
        if cid in dispatch['confirmations']:return {}
        started=time.time();limit=max(30,min(3600,int(b.cfg.get('confirmation_wait_seconds',3600))))
        value={'run_id':rid,'task_id':task['id'],'confirmation':cid,'status':'waiting_confirmation',
               'started_at':now(),'deadline_epoch':started+limit,'source':'Claude Stop hook'}
        def update(status,**extra):
            value.update(status=status,updated_at=now(),**extra);atomic_json(wait_path,value)
        update('waiting_confirmation');b.event(pilot['jira_key'],'same_session_waiting',value,rid)
        try:
            b.pc.request('POST','/issues/'+task['id']+'/comments',{'body':'等待审批 #'+cid+'。本地终端保持连接，Stop hook 等待有效决策；同意后同一 Claude 会话自动继续，无需 /exit 或重新 start。'})
        except BridgeError as e:update('waiting_confirmation',publication_error=str(e))
        next_remote_check=0
        try:
            while time.time()<started+limit:
                pilot=b.pilot(pilot['jira_key'])
                if not pilot['enabled']:update('disabled');return {}
                state=b.state(pilot);current=b.jc.current_confirmation(state)
                if state.get('状态')=='completed':update('completed');return {}
                if not current or current.get('确认编号')!=cid:update('superseded');return {}
                if current.get('状态')!='pending':update('resolved_elsewhere');return {}
                if pilot['details'].get('mode')=='replay':
                    comments=read_json(pilot['details']['comments_path']).get('comments',[])
                else:
                    if time.time()<next_remote_check:time.sleep(1);continue
                    comments=b.jc.fetch_comments(pilot['jira_key'],*b.jira_config());next_remote_check=time.time()+20
                with tempfile.TemporaryDirectory() as temp:
                    verdict,record=b.jc.resolve_confirmation(Path(temp)/'state.json',copy.deepcopy(state),comments)
                if verdict=='rejected':
                    update('rejected');b.event(pilot['jira_key'],'same_session_rejected',value,rid)
                    return {}  # Allow Claude to become idle; no development turn.
                if verdict=='approved':
                    connection=read_json(folder/'session.json')
                    if not connection.get('terminal_connected',False):
                        update('waiting_terminal');time.sleep(1);continue
                    b.validate_jira(pilot);b.worktree_check(pilot['details']);b.require_lease(pilot)
                    current_task=b.pc.request('GET','/issues/'+task['id'])
                    if current_task.get('status') in ('done','cancelled') or current_task.get('assigneeAgentId')!=b.cfg['agent_id']:
                        update('task_unavailable');return {}
                    dispatch['confirmations'][cid]={'run_id':rid,'at':now(),'status':'dispatch_intent',
                        'decision_comment_id':(record.get('回复') or {}).get('评论ID')}
                    atomic_json(receipt_path,dispatch);update('resuming')
                    b.event(pilot['jira_key'],'same_session_resume_dispatch',dispatch['confirmations'][cid],rid)
                    if pilot['details'].get('mode')=='replay':
                        reason='本会话待确认事项已收到有效模拟同意。只依次执行 agent inspect、agent claim、agent replay，在真实锁下核验并继续；禁止写真实 Jira、tracker 或业务源码。'
                    else:
                        reason='本会话待确认事项已收到有效 Jira 同意。先 agent inspect 和 agent claim 重新领取，再运行 jira_confirmation.py 在执行权下更新确认，按 jira-resume 从已保存 Phase 继续。不要重新开发已完成步骤。'
                    # Stop-hook block means continue the current conversation;
                    # it is not a new Paperclip run or terminal keystroke.
                    return {'decision':'block','reason':reason+' 确认编号：'+cid}
                time.sleep(1)
            update('wait_timeout');b.event(pilot['jira_key'],'same_session_wait_timeout',value,rid)
            return {}
        except BaseException:
            update('interrupted');raise


if __name__=='__main__':
    try:
        response=main();print(json.dumps(response or {},ensure_ascii=False),flush=True)
    except (Exception,KeyboardInterrupt) as e:
        # Fail closed: keep the business blocker; never grant a continuation.
        print('DSP7 wait hook stopped: '+str(e),file=sys.stderr)
        print('{}',flush=True)
