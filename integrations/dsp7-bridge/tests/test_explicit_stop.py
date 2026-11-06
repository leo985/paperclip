"""Explicit task-stop intent survives network failure and precedes signals."""
import json
from pathlib import Path
import sys
import tempfile
import unittest
import uuid
from unittest.mock import Mock, patch
sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
import interactive
from pilot import BridgeError

class ExplicitStopTest(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory();self.addCleanup(self.temp.cleanup)
        self.b=Mock();self.b.cfg={'database':str(Path(self.temp.name)/'bridge.sqlite3'),'agent_id':str(uuid.uuid4())}
        self.task=str(uuid.uuid4());self.run=str(uuid.uuid4())
        self.b.pilot.return_value={'task_id':self.task}
        self.b.runs_for.return_value=[{'id':self.run,'status':'running'}]
        self.path=Path(self.temp.name)/'interactive/runs'/self.run/'stop-intent.json'
    def check_intent(self,*args):
        data=json.loads(self.path.read_text());self.assertEqual(data['run_id'],self.run);self.assertEqual(data['task_id'],self.task)
    def execute(self,offline=False):
        api=Mock()
        def request(*args):
            self.check_intent()
            if offline:raise BridgeError('网络异常')
        api.request.side_effect=request
        with patch('seats.identity',return_value={}),patch('seats.seat_api',return_value=api),patch('pilot.stop_run_locally',side_effect=self.check_intent) as stop:
            interactive.stop(self.b,'TEST-1');stop.assert_called_once_with(self.run)
        self.check_intent()
    def test_persist_before_network_cancel_and_local_signal(self):self.execute()
    def test_offline_intent_is_durable_and_local_stop_still_runs(self):self.execute(True)
    def test_stop_between_failure_and_retry_start_still_records_intent(self):
        self.b.runs_for.return_value=[{'id':self.run,'status':'failed','contextSnapshot':{'wakeReason':'本地研发人员主动启动交互会话；测试'}}]
        self.execute()
    def test_offline_discovery_only_matches_task_and_live_process(self):
        self.b.runs_for.side_effect=BridgeError('网络异常')
        folder=self.path.parent;folder.mkdir(parents=True)
        (folder/'session.json').write_text(json.dumps({'run_id':self.run,'task_id':self.task,'status':'running'}))
        other=folder.parent/str(uuid.uuid4());other.mkdir()
        (other/'session.json').write_text(json.dumps({'run_id':other.name,'task_id':'other-task','status':'running'}))
        with patch('pilot.processes_for_run',return_value=[123]):self.execute(True)
    def test_ambiguous_or_absent_active_run_never_sends_signals(self):
        for runs in ([],[{'id':self.run,'status':'running'},{'id':str(uuid.uuid4()),'status':'queued'}]):
            self.b.runs_for.return_value=runs
            with patch('pilot.stop_run_locally') as stop:
                with self.assertRaises(BridgeError):interactive.stop(self.b,'TEST-1')
                stop.assert_not_called();self.assertFalse(self.path.exists())

if __name__=='__main__':unittest.main()
