"""Native waits are explicit, run-scoped and cleared by matching completion."""
import datetime as dt
import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import Mock,patch
import sqlite3

sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
from session_hook import boundary,native_wait
import seat_control

class NativeWaitTest(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory();self.addCleanup(self.temp.cleanup)
        self.folder=Path(self.temp.name)/'current-run';self.folder.mkdir()
        self.run={'id':'current-run','status':'running'}
        self.info={'run_id':'current-run','task_id':'task','status':'running','started_at':'2026-10-22T15:00:00Z'}
        self.save_info();self.events=[]
        self.clock=dt.datetime.fromisoformat('2026-10-22T16:00:00+00:00')
    def save_info(self):
        (self.folder/'session.json').write_text(json.dumps(self.info))
    def add(self,event,tool='Bash',tool_id='a',at='2026-10-22T15:30:00Z'):
        self.events.append({'at':at,**boundary({'hook_event_name':event,'tool_name':tool,'tool_use_id':tool_id})})
        (self.folder/'collector-hooks.jsonl').write_text(''.join(json.dumps(e)+'\n' for e in self.events))
    def wait(self):return native_wait(self.folder,self.run,'task',self.clock)
    def test_question_then_permission_keeps_original_identity_and_time(self):
        self.add('PreToolUse','AskUserQuestion');first=self.wait()
        self.add('PermissionRequest','AskUserQuestion',at='2026-10-22T15:31:00Z')
        self.assertEqual(first,self.wait());self.assertEqual(first['kind'],'question')
        self.assertEqual(first['elapsedMinutes'],30)
    def test_unrelated_tool_does_not_clear_pending_question(self):
        self.add('PreToolUse','AskUserQuestion');first=self.wait()
        self.add('PreToolUse',tool_id='other');self.add('PostToolUse',tool_id='other')
        self.assertEqual(first,self.wait())
        self.add('PostToolUse','AskUserQuestion');self.assertIsNone(self.wait())
    def test_permission_resolves_or_fails_and_new_wait_has_new_identity(self):
        self.add('PermissionRequest');first=self.wait()
        self.assertEqual(first['kind'],'permission')
        self.add('PostToolUseFailure');self.assertIsNone(self.wait())
        self.add('PermissionRequest',at='2026-10-22T15:40:00Z')
        self.assertNotEqual(first['id'],self.wait()['id'])
    def test_user_prompt_stop_and_session_end_clear_wait(self):
        for event in ('UserPromptSubmit','Stop','SessionEnd'):
            self.add('PermissionRequest');self.assertIsNotNone(self.wait())
            self.add(event);self.assertIsNone(self.wait())
    def test_no_silence_heuristic_or_terminal_run_wait(self):
        self.add('PreToolUse');self.assertIsNone(self.wait())
        self.add('PermissionRequest');self.run['status']='cancelled';self.assertIsNone(self.wait())
    def test_foreign_run_task_and_old_or_future_signals_ignored(self):
        self.add('PermissionRequest',at='2026-10-22T14:00:00Z');self.assertIsNone(self.wait())
        self.add('PermissionRequest',at='2026-10-22T17:00:00Z');self.assertIsNone(self.wait())
        self.add('PermissionRequest');self.events[-1]['run_id']='foreign'
        self.add('PreToolUse',tool_id='other');self.assertIsNone(self.wait())
        self.add('PermissionRequest');self.info['task_id']='foreign';self.save_info();self.assertIsNone(self.wait())
    def test_legacy_observer_wait_recovered_and_cleared_after_resume(self):
        self.events=[{'at':'2026-10-22T15:30:00Z','hook':'PermissionRequest','state':'waiting'}]
        self.add('PreToolUse',tool_id='other',at='2026-10-22T14:30:00Z')
        self.assertIsNotNone(self.wait())
        self.add('PreToolUse',tool_id='other');self.assertIsNone(self.wait())
    def test_partial_append_does_not_erase_wait_or_expose_arguments(self):
        self.add('PreToolUse','AskUserQuestion');first=self.wait()
        with (self.folder/'collector-hooks.jsonl').open('a') as stream:stream.write('{"at":')
        self.assertEqual(first,self.wait())
        result=boundary({'hook_event_name':'PreToolUse','tool_name':'AskUserQuestion','tool_use_id':'safe-id','tool_input':{'secret':'never-store'},'prompt':'private'})
        self.assertNotIn('private',json.dumps(result));self.assertNotIn('never-store',json.dumps(result))

    def test_seat_reports_native_wait_and_resumes_busy_without_changing_task(self):
        run_folder=Path(self.temp.name)/'interactive/runs'/self.run['id']
        run_folder.parent.mkdir(parents=True);self.folder.rename(run_folder);self.folder=run_folder
        self.info['started_at']='2020-01-01T00:00:00Z';self.save_info()
        self.add('PermissionRequest')
        db=sqlite3.connect(':memory:');db.row_factory=sqlite3.Row;self.addCleanup(db.close)
        db.executescript("CREATE TABLE pilots(jira_key TEXT); INSERT INTO pilots VALUES('TEST-1'); CREATE TABLE seat_commands(status TEXT);")
        pilot={'task_id':'task','jira_key':'TEST-1','enabled':0,'details':{},'last_error':None}
        bridge=Mock(cfg={'database':str(Path(self.temp.name)/'bridge.sqlite3')},db=db)
        bridge.pilot.return_value=pilot;bridge.runs_for.return_value=[self.run]
        bridge.pc.request.return_value={'status':'in_progress'};bridge.jc.current_confirmation.return_value=None
        control=Path(self.temp.name)/'seat-control';control.mkdir()
        with patch.object(seat_control,'once_notice') as notice,patch.object(seat_control,'dingtalk_notice'),patch.object(seat_control,'offline_requested',return_value=False):
            presence,_=seat_control.collect(bridge,[],control)
            self.assertEqual(presence['state'],'waiting_decision');self.assertEqual(presence['runId'],'current-run')
            alert=presence['alerts'][0];self.assertIn('Claude 终端',alert['message'])
            again,_=seat_control.collect(bridge,[],control)
            self.assertEqual(alert['id'],again['alerts'][0]['id'])
            self.assertEqual(notice.call_args_list[0].args[1],notice.call_args_list[1].args[1])
            self.add('PostToolUse')
            resumed,_=seat_control.collect(bridge,[],control)
            self.assertEqual(resumed['state'],'busy');self.assertEqual(resumed['alerts'],[])
            self.assertTrue(all(call.args[0]=='GET' for call in bridge.pc.request.call_args_list))
            self.run['status']='queued'
            queued,_=seat_control.collect(bridge,[],control)
            self.assertEqual(queued['activeRuns'],[])
            self.assertEqual(queued['state'],'idle')

    def test_reports_all_concurrent_domain_runs_and_keeps_each_wait_state(self):
        root=Path(self.temp.name)
        db=sqlite3.connect(':memory:');db.row_factory=sqlite3.Row;self.addCleanup(db.close)
        db.executescript("CREATE TABLE pilots(jira_key TEXT); CREATE TABLE seat_commands(status TEXT);")
        bridge=Mock(cfg={'database':str(root/'bridge.sqlite3')},db=db)
        for index in (1,2):
            folder=root/'interactive/runs'/('parallel-'+str(index));folder.mkdir(parents=True)
            (folder/'session.json').write_text(json.dumps({'execution_kind':'analysis','status':'running','wrapper_pid':123,'task_id':'task-'+str(index),'run_id':'run-'+str(index)}))
            if index==1:(folder/'wait.json').write_text(json.dumps({'status':'waiting_confirmation','waitingSince':0,'decisionDigest':'test'}))
        control=root/'seat-control';control.mkdir()
        with patch('platform_support.process_alive',return_value=True),patch.object(seat_control,'once_notice'),patch.object(seat_control,'offline_requested',return_value=False):
            presence,_=seat_control.collect(bridge,[],control)
        runs={run['taskId']:run for run in presence['activeRuns']}
        self.assertEqual(len(runs),2)
        self.assertEqual(runs['task-1']['state'],'waiting_decision')
        self.assertEqual(runs['task-2']['state'],'busy')
        self.assertEqual(presence['state'],'waiting_decision')
        self.assertIn('seat-concurrency-v1',presence['capabilities'])

if __name__=='__main__':unittest.main()
