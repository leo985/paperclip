#!/usr/bin/env python3
"""Content-free runtime boundaries for a managed Claude session. Never grants tools."""
import json
import os
import datetime as dt
import hashlib
from pathlib import Path
import sys

def boundary(value):
    """Allowlisted metadata only: never retain tool arguments, prompts or replies."""
    event=value.get('hook_event_name')
    tool=value.get('tool_name')
    state={'UserPromptSubmit':'executing','PreToolUse':'executing','PostToolUse':'executing','PostToolUseFailure':'executing','PermissionRequest':'waiting','Stop':'unknown','SessionEnd':'unknown'}.get(event)
    if event=='PreToolUse' and tool=='AskUserQuestion':state='waiting'
    if not state:return None
    result={'state':state,'hook':event}
    if event in ('PreToolUse','PostToolUse','PostToolUseFailure','PermissionRequest'):
        result['wait_kind']='question' if tool=='AskUserQuestion' else 'permission'
        tool_id=value.get('tool_use_id')
        if isinstance(tool_id,str) and 0<len(tool_id)<=200:result['tool_use_id']=tool_id
    return result

def native_wait(folder,run,task_id,clock=None):
    """Replay explicit boundaries of this live run; silence is never a wait signal."""
    folder=Path(folder);run_id=run['id']
    if folder.name!=run_id or run.get('status')!='running':return None
    try:
        info=json.loads((folder/'session.json').read_text())
        if info.get('run_id')!=run_id or info.get('task_id')!=task_id or info.get('status')!='running':return None
        def epoch(value):return dt.datetime.fromisoformat(value.replace('Z','+00:00')).timestamp()
        started=epoch(info['started_at']);stamp=(clock or dt.datetime.now(dt.timezone.utc)).timestamp()
        pending={}
        # Bounded read, complete JSONL records only. A partial append is ignored.
        with (folder/'collector-hooks.jsonl').open('rb') as stream:
            stream.seek(0,2);size=stream.tell();stream.seek(max(0,size-2*1024*1024))
            if size>2*1024*1024:stream.readline()
            for line in stream:
                if not line.endswith(b'\n') or len(line)>4096:continue
                try:
                    event=json.loads(line);at=epoch(event['at'])
                    if not started<=at<=stamp+5 or event.get('run_id',run_id)!=run_id:continue
                    hook=event.get('hook');key=event.get('tool_use_id') or 'legacy'
                    if hook in ('UserPromptSubmit','Stop','SessionEnd'):pending.clear()
                    elif event.get('state')=='waiting':
                        pending.setdefault(key,{'at':event['at'],'epoch':at,'kind':event.get('wait_kind','permission'),'key':key})
                    elif hook in ('PostToolUse','PostToolUseFailure'):
                        pending.pop(key,None);pending.pop('legacy',None)
                    elif hook=='PreToolUse':pending.pop('legacy',None)
                except (ValueError,TypeError,KeyError,AttributeError):continue
        if not pending:return None
        wait=min(pending.values(),key=lambda w:w['epoch'])
        token=hashlib.sha256((run_id+':'+wait['key']+':'+wait['at']).encode()).hexdigest()[:24]
        return {'id':run_id+':native:'+token,'kind':wait['kind'],'elapsedMinutes':round(max(0,(stamp-wait['epoch'])/60),1)}
    except (OSError,ValueError,TypeError,KeyError,AttributeError):return None

def main():
    value=json.loads(sys.stdin.read(2*1024*1024))
    run=os.environ.get('PAPERCLIP_RUN_ID');folder=os.environ.get('DSP7_MANAGED_FOLDER')
    if not run or not folder or Path(folder).name!=run:return
    result=boundary(value)
    if result:
        from managed_sessions import write_hook
        write_hook(folder,result.pop('state'),result.pop('hook'),**result)
if __name__=='__main__':
    try:main()
    except Exception:pass
    print('{}')
