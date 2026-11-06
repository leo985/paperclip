import sys
from pathlib import Path
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from pilot import BridgeError
from seat_launch_options import resolve, validate
from interactive import interactive_args

class SeatLaunchOptionsTest(unittest.TestCase):
    def run_resolve(self, response, args=(), local=True):
        b = SimpleNamespace(cfg={'agent_id': 'seat', 'claude_skip_permissions': local})
        api = Mock(); api.request.return_value = response
        with patch('seat_launch_options.identity', return_value={'seat_id': 'seat'}), patch('seat_launch_options.seat_api', return_value=api):
            result = resolve(b, list(args))
        api.request.assert_called_once_with('POST', '/agents/seat/dsp7-seat-launch-options', {'seat_id': 'seat'})
        return result

    def test_unconfigured_preserves_local_opt_in(self):
        args, skip, meta = self.run_resolve({'configured': False}, ['--model', 'local'])
        self.assertEqual(args, ['--model', 'local']); self.assertTrue(skip)
        self.assertEqual(meta['source'], 'local')

    def test_explicit_empty_removes_local_flags_and_disables_legacy_skip(self):
        args, skip, meta = self.run_resolve({'configured': True, 'revision': 2, 'extraArgs': []}, ['--model=local', '--effort', 'low', '--dangerously-skip-permissions', '--settings', '/local.json'])
        self.assertFalse(skip); self.assertEqual(args, ['--settings', '/local.json'])
        self.assertEqual(meta['revision'], 2)

    def test_web_opt_in_without_local_flag_preserves_session_injection(self):
        args, skip, meta = self.run_resolve({'configured': True, 'revision': 3, 'extraArgs': ['--dangerously-skip-permissions', '--model', 'sonnet']}, ['--permission-mode', 'plan', '--session-id', 'old'], local=False)
        effective = interactive_args(args, 'new-run', skip_permissions=skip)
        self.assertTrue(skip); self.assertEqual(effective.count('--dangerously-skip-permissions'), 1)
        self.assertNotIn('old', effective); self.assertNotIn('--permission-mode', effective)
        self.assertIn('new-run', effective); self.assertIn('sonnet', effective)

    def test_network_failure_never_falls_back_to_local_skip(self):
        with patch('seat_launch_options.identity', return_value={}), patch('seat_launch_options.seat_api') as api:
            api.return_value.request.side_effect = BridgeError('offline')
            with self.assertRaises(BridgeError): resolve(SimpleNamespace(cfg={'agent_id': 'seat', 'claude_skip_permissions': True}), [])

    def test_invalid_options_cannot_override_platform_protocol(self):
        for args in [['--settings', '/tmp/x'], ['--session-id', 'x'], ['--model'], ['--effort', 'ultra'], ['--model', 'a', '--model', 'b'], ['--dangerously-skip-permissions', '--permission-mode', 'plan'], ['--model', '$(secret)']]:
            with self.subTest(args=args), self.assertRaises(BridgeError): validate(args)
        self.assertEqual(validate(['--permission-mode', 'acceptEdits', '--effort', 'high']), ['--permission-mode', 'acceptEdits', '--effort', 'high'])

if __name__ == '__main__': unittest.main()
