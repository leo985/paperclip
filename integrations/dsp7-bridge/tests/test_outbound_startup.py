import json
from pathlib import Path
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch
import uuid

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from outbound import flush_exit_receipts, record_startup_failure, run
from pilot import BridgeError


class OutboundStartupTest(unittest.TestCase):
    def packet(self):
        return {'runId': str(uuid.uuid4()), 'lease': str(uuid.uuid4())}

    def test_changed_harness_fails_before_model_start_and_reports_without_permit(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            packet = self.packet()
            folder = root/'outbound'/packet['runId']
            folder.mkdir(parents=True)
            bridge = SimpleNamespace(cfg={'database': str(root/'bridge.db'), 'agent_id': 'seat'})
            api = Mock()
            api.request.return_value = {'alive': True, 'sequence': 1}
            error = BridgeError('Harness 仓库、profile、文件或版本已变化，请空闲时重新登记')
            stdin = SimpleNamespace(buffer=SimpleNamespace(read=lambda _: json.dumps(packet).encode()))
            with patch('outbound.own_process_job'), patch('outbound.sys.stdin', stdin), \
                 patch('outbound.Bridge', return_value=bridge), \
                 patch('outbound._run', side_effect=error), \
                 patch('outbound.identity', return_value={'machine_id': 'machine'}), \
                 patch('outbound.seat_api', return_value=api), \
                 patch('outbound.subprocess.Popen') as spawn:
                with self.assertRaises(BridgeError):
                    run(root/'config.json')
                spawn.assert_not_called()
            body = api.request.call_args.args[2]
            self.assertFalse(body['result']['timedOut'])
            self.assertIn('重新登记', body['result']['errorMessage'])
            self.assertEqual(body['sequence'], 1)
            self.assertFalse((folder/'startup-failure.json').exists())

    def test_receipt_is_durable_and_does_not_upload_untrusted_error_text(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            packet = self.packet()
            packet['permit'] = {'protocolVersion': 1}
            folder = root/'outbound'/packet['runId']
            folder.mkdir(parents=True)
            record_startup_failure(packet, folder, BridgeError('API response with private input'))
            receipt = folder/'startup-failure.json'
            self.assertNotIn('private input', receipt.read_text())
            self.assertEqual(json.loads(receipt.read_text())['permitProtocol'], 1)
            bridge = SimpleNamespace(cfg={'database': str(root/'bridge.db'), 'agent_id': 'seat'})
            api = Mock()
            api.request.side_effect = [BridgeError('offline'), {'alive': False}, {'alive': True, 'sequence': 1}]
            with patch('outbound.identity', return_value={'machine_id': 'machine'}), \
                 patch('outbound.seat_api', return_value=api):
                flush_exit_receipts(bridge)
                self.assertTrue(receipt.exists())
                flush_exit_receipts(bridge)
                self.assertTrue(receipt.exists())
                flush_exit_receipts(bridge)
                self.assertFalse(receipt.exists())

    def test_no_start_claim_is_never_fabricated_after_spawn_or_uncertain_heartbeat(self):
        with tempfile.TemporaryDirectory() as tmp:
            folder = Path(tmp)
            packet = self.packet()
            packet['_receipt_attempted'] = True
            record_startup_failure(packet, folder, BridgeError('failed'))
            self.assertFalse((folder/'startup-failure.json').exists())
            del packet['_receipt_attempted']
            (folder/'launch-attempt.json').write_text('{}')
            record_startup_failure(packet, folder, BridgeError('failed'))
            self.assertFalse((folder/'startup-failure.json').exists())


if __name__ == '__main__':
    unittest.main()
