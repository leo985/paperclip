import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import seat_remote_upgrade as remote

DIGEST = 'b' * 64
REQUEST = {'requestId': 'd4c88894-3d80-4f96-8d94-b222f7ef6131', 'targetSha256': DIGEST, 'status': 'queued'}

class RemoteUpgradeTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(); self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name); self.runtime = self.root / 'runtime'; self.runtime.mkdir()
        self.config = self.root / 'config.json'
        self.config.write_text(json.dumps({'database': str(self.runtime / 'db.sqlite')}))
        (self.root / 'settings.json').write_text(json.dumps({'config': str(self.config), 'python': sys.executable}))
        (self.root / 'bridge-version.json').write_text(json.dumps({'sha256': 'a' * 64}))

    def check(self, request=REQUEST, outcome='installed'):
        with patch.object(remote, 'api', side_effect=lambda config, action, body=None: {'request': request} if action == 'poll' else {}) as api, patch.object(remote, 'run_upgrade', return_value=outcome) as run:
            result = remote.check(self.root, now=1000)
        return result, api, run

    def test_publication_without_request_does_nothing(self):
        result, api, run = self.check(None)
        self.assertEqual(result['condition'], 'no_request'); run.assert_not_called()
        self.assertEqual([call.args[1] for call in api.call_args_list], ['poll'])

    def test_explicit_request_claims_and_reports_exact_target(self):
        result, api, run = self.check()
        self.assertEqual(result['condition'], 'installed')
        self.assertEqual([call.args[1] for call in api.call_args_list], ['poll', 'claim', 'result'])
        self.assertEqual(run.call_args.args[-1], DIGEST)
        self.assertEqual(api.call_args.args[2]['status'], 'installed')

    def test_manual_offline_never_polls(self):
        (self.runtime / 'seat-offline.json').touch()
        result, api, run = self.check()
        self.assertEqual(result['condition'], 'manual_offline'); api.assert_not_called(); run.assert_not_called()

    def test_terminal_requests_never_run(self):
        for status in ('cancelled', 'expired', 'failed', 'succeeded'):
            result, api, run = self.check({**REQUEST, 'status': status})
            self.assertEqual(result['condition'], status); run.assert_not_called()

    def test_claimed_attempt_is_not_replayed(self):
        result, api, run = self.check({**REQUEST, 'status': 'claimed'})
        self.assertEqual(result['condition'], 'awaiting_previous_attempt'); run.assert_not_called()

    def test_crashed_known_attempt_fails_after_timeout(self):
        (self.root / 'remote-upgrade.json').write_text(json.dumps({'request_id': REQUEST['requestId'], 'attempt_epoch': 1}))
        result, api, run = self.check({**REQUEST, 'status': 'claimed'})
        self.assertEqual(result['condition'], 'failed'); run.assert_not_called()
        self.assertEqual(api.call_args.args[2]['status'], 'failed')

    def test_busy_result_defers_existing_request(self):
        result, api, run = self.check(outcome='deferred')
        self.assertEqual(result['condition'], 'deferred')
        self.assertEqual(api.call_args.args[2]['status'], 'deferred')

    def test_invalid_target_never_claims(self):
        result, api, run = self.check({**REQUEST, 'targetSha256': 'latest'})
        self.assertEqual(result['condition'], 'check_failed'); run.assert_not_called()
        self.assertEqual(len(api.call_args_list), 1)

    def test_install_receipt_recovers_without_rerunning(self):
        (self.root / 'bridge-version.json').write_text(json.dumps({'sha256': DIGEST}))
        result, api, run = self.check({**REQUEST, 'status': 'claimed'})
        self.assertEqual(result['condition'], 'installed'); run.assert_not_called()
        self.assertEqual(api.call_args.args[2]['status'], 'installed')
