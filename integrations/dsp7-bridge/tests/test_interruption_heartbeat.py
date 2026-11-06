"""A rejected interruption receipt must not take an otherwise healthy seat offline."""
import contextlib
import copy
from pathlib import Path
import sqlite3
import sys
import tempfile
import time
import unittest
import uuid
from unittest.mock import Mock, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import seat_control
from pilot import BridgeError, atomic_json


class InterruptionHeartbeatTest(unittest.TestCase):
    def test_failed_receipt_preserves_heartbeat_other_tasks_and_retry(self):
        with tempfile.TemporaryDirectory() as temp, contextlib.ExitStack() as stack:
            b = Mock()
            b.root = Path(temp)
            b.cfg = {'database': str(Path(temp)/'bridge.sqlite3'), 'agent_id': str(uuid.uuid4()), 'seat_runtime': {'revision': 1}}
            b.db = sqlite3.connect(b.cfg['database']); b.db.row_factory = sqlite3.Row
            stack.callback(b.db.close)
            b.db.execute('CREATE TABLE pilots(jira_key TEXT)')
            pilots = {}
            tasks = {}
            runs = {}
            for key in ('TEST-1', 'TEST-2'):
                task_id, run_id = str(uuid.uuid4()), str(uuid.uuid4())
                b.db.execute('INSERT INTO pilots VALUES(?)', (key,))
                pilots[key] = {'jira_key': key, 'task_id': task_id, 'enabled': 1, 'status': 'running', 'updated_at': 'fixture', 'details': {}}
                tasks[task_id] = {'id': task_id, 'status': 'in_progress', 'description': 'DSP7-PILOT:'+key}
                runs[key] = [{'id': run_id, 'status': 'failed', 'createdAt': '2026-10-27T00:00:00Z', 'contextSnapshot': {'wakeReason': '本地研发人员主动启动交互会话；fixture'}}]
            b.db.commit()
            b.pilot.side_effect = lambda key: pilots[key]
            b.pc.request.side_effect = lambda method, path: copy.deepcopy(tasks[path.rsplit('/', 1)[-1]])
            b.runs_for.side_effect = lambda p: runs[p['jira_key']]
            b.state.return_value = {}
            b.jc.current_confirmation.return_value = None
            b.update.side_effect = lambda key, **changes: pilots[key].update(changes)
            folder = seat_control.setup(b)
            atomic_json(folder/'state.json', {'checks': [{'id': 'runtime', 'status': 'pass'}], 'checkedEpoch': time.time(), 'refreshedEpoch': time.time()})
            api = Mock(); attempts = []; heartbeats = []

            def request(method, path, payload):
                if path.endswith('/execution-interrupted'):
                    attempts.append(payload['taskId'])
                    if payload['taskId'] == pilots['TEST-1']['task_id'] and attempts.count(payload['taskId']) == 1:
                        raise BridgeError('Rejected fixture receipt')
                    tasks[payload['taskId']].update(status='blocked', unblockDescriptor={'action': payload['action']})
                    return {'received': True}
                if path.endswith('/dsp7-seat-heartbeat'):
                    heartbeats.append(payload)
                    return {'policy': seat_control.DEFAULT_POLICY}
                self.fail('Unexpected API path: '+path)

            api.request.side_effect = request
            stack.enter_context(patch('seat_control.seat_api', return_value=api))
            stack.enter_context(patch('seat_control.identity', return_value={}))
            stack.enter_context(patch('seat_control.verify_stopped_execution', return_value=True))
            stack.enter_context(patch('seat_control.once_notice'))
            stack.enter_context(patch('seat_control.dingtalk_notice'))
            stack.enter_context(patch('seat_control.process_commands'))
            poll = stack.enter_context(patch('outbound.poll'))

            seat_control.tick(b)
            self.assertEqual(len(heartbeats), 1)
            self.assertEqual(len(heartbeats[0]['tasks']), 2)
            self.assertTrue(any(a['id'] == 'TEST-1:interruption_receipt' for a in heartbeats[0]['alerts']))
            self.assertEqual(pilots['TEST-1']['enabled'], 1)  # Still eligible to report again.
            self.assertEqual(pilots['TEST-2']['status'], 'interrupted')
            poll.assert_called_once_with(b)

            seat_control.tick(b)
            self.assertEqual(len(heartbeats), 2)
            self.assertEqual(attempts.count(pilots['TEST-1']['task_id']), 2)
            self.assertEqual(pilots['TEST-1']['status'], 'interrupted')
            self.assertEqual(pilots['TEST-1']['enabled'], 0)
            self.assertFalse(any(a['id'] == 'TEST-1:interruption_receipt' for a in heartbeats[1]['alerts']))


if __name__ == '__main__':
    unittest.main()
