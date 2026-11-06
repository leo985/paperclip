"""Resume an interrupted first setup without consuming another invitation."""
import contextlib
import io
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import Mock, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import quick_install
import pilot
import seat_upgrade


class PendingEnrollmentTests(unittest.TestCase):
    def setUp(self):
        env=patch.dict(os.environ);env.start();self.addCleanup(env.stop)
        os.environ.pop('DSP7_BRIDGE_CONFIG',None)
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name).resolve()
        self.config = self.root / '.config/paperclip-dsp7-bridge/config.json'
        self.config.parent.mkdir(parents=True)
        self.old, self.new = self.root/'old', self.root/'new'
        self.old.mkdir()
        self.new.mkdir()
        self.cfg = {'paperclip_url': 'http://seat.test', 'harness_root': str(self.root),
                    'agent_id': 'original-seat', 'execution_transport': 'outbound',
                    'quick_setup': {'bridge': str(self.old), 'claude': 'claude.CMD'}}

    def run_setup(self, extra=(), upgrade_error=None):
        self.config.write_text(json.dumps(self.cfg))
        b = Mock(cfg=self.cfg, root=self.root)
        with contextlib.ExitStack() as stack:
            stack.enter_context(patch.object(sys, 'argv', ['installer', '--server', 'http://seat.test', *extra]))
            stack.enter_context(patch.object(sys, 'platform', 'darwin'))
            stack.enter_context(patch.object(Path, 'home', return_value=self.root))
            stack.enter_context(patch.object(pilot, 'Bridge', return_value=b))
            api = stack.enter_context(patch.object(pilot, 'Api', side_effect=AssertionError('Do not create another seat')))
            stack.enter_context(patch.object(quick_install, 'existing_bridge', return_value=self.old))
            download = stack.enter_context(patch.object(quick_install, 'install_bundle', return_value=self.new))
            upgrade = stack.enter_context(patch.object(seat_upgrade, 'upgrade', side_effect=upgrade_error))
            finish = stack.enter_context(patch.object(quick_install, 'finish_setup'))
            stack.enter_context(patch.object(quick_install, 'scan', return_value=[]))
            stack.enter_context(contextlib.redirect_stdout(io.StringIO()))
            stack.enter_context(patch.object(sys, 'path', list(sys.path)))
            if upgrade_error:
                with self.assertRaisesRegex(RuntimeError, 'busy'):
                    quick_install.main()
            else:
                quick_install.main()
            api.assert_not_called()
            return b, download, upgrade, finish

    def test_incomplete_setup_switches_bridge_then_finishes_same_seat(self):
        b, download, upgrade, finish = self.run_setup()
        download.assert_called_once()
        self.assertTrue(upgrade.call_args.kwargs['no_service'])
        finish.assert_called_once_with(b, self.new, False)
        self.assertEqual(json.loads(self.config.read_text())['agent_id'], 'original-seat')

    def test_completed_seat_does_not_implicitly_upgrade(self):
        self.cfg['seat_runtime'] = {'revision': 1}
        b, download, upgrade, finish = self.run_setup()
        download.assert_called_once()
        upgrade.assert_not_called()
        finish.assert_called_once_with(b, self.old, False)

    def test_requested_upgrade_of_completed_seat_does_not_reregister(self):
        self.cfg['seat_runtime'] = {'revision': 1}
        with patch('device_upgrade.upgrade_all') as batch:
            _, download, upgrade, finish = self.run_setup(['--upgrade'])
        download.assert_called_once()
        upgrade.assert_not_called()
        batch.assert_called_once_with('http://seat.test', self.new, no_service=False)
        finish.assert_not_called()

    def test_explicit_seat_upgrade_preserves_scope(self):
        self.cfg['seat_runtime'] = {'revision': 1}
        with patch('device_upgrade.upgrade_all') as batch:
            _, _, upgrade, finish = self.run_setup(['--upgrade', '--this-seat'])
        batch.assert_not_called()
        self.assertFalse(upgrade.call_args.kwargs['no_service'])
        finish.assert_not_called()

    def test_early_remote_updater_keeps_single_seat_scope(self):
        self.cfg['seat_runtime'] = {'revision': 1}
        with patch.dict('os.environ', {'PAPERCLIP_UPGRADE_TARGET_SHA256': 'a' * 64}), patch('device_upgrade.upgrade_all') as batch:
            _, _, upgrade, finish = self.run_setup(['--upgrade'])
        batch.assert_not_called()
        upgrade.assert_called_once()
        finish.assert_not_called()

    def test_busy_seat_stops_recovery_before_finishing(self):
        _, _, _, finish = self.run_setup(upgrade_error=RuntimeError('busy'))
        finish.assert_not_called()
        self.assertEqual(json.loads(self.config.read_text())['agent_id'], 'original-seat')

    def test_manual_service_choice_survives_recovery(self):
        b, _, _, finish = self.run_setup(['--no-service'])
        finish.assert_called_once_with(b, self.new, True)

    def test_step_timeout_does_not_expose_command_or_credentials(self):
        with contextlib.redirect_stdout(io.StringIO()), self.assertRaisesRegex(RuntimeError, '步骤超时') as raised:
            with quick_install.setup_step('步骤'):
                raise subprocess.TimeoutExpired(['secret-token'], 30)
        self.assertNotIn('secret-token', str(raised.exception))


if __name__ == '__main__':
    unittest.main()
