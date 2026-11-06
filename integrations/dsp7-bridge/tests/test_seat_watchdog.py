"""Recovery keeps seat identity, explicit offline intent and upgrades intact."""
import contextlib
import datetime as dt
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import seat_watchdog as watchdog
import seat_lifecycle


class SeatWatchdogTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.directory = self.root / 'seat-watchdog'
        self.directory.mkdir()
        self.config = self.root / 'config.json'
        self.bridge = self.root / 'bridge'
        self.bridge.mkdir()
        (self.bridge / 'harness_entry.py').touch()
        self.cfg = {'database': str(self.root / 'bridge.sqlite3'), 'execution_transport': 'outbound',
                    'seat_runtime': {'revision': 1}, 'quick_setup': {'bridge': str(self.bridge)}}
        self.config.write_text(json.dumps(self.cfg))
        self.now = 10000
        self.settings = {'config': str(self.config), 'bridge': '/old-bridge', 'python': sys.executable, 'installed_at': 0}
        watchdog.write_json(self.directory / 'settings.json', self.settings)
        (self.root / 'seat-control').mkdir()

    def heartbeat(self, age=0):
        stamp = dt.datetime.fromtimestamp(self.now - age, dt.timezone.utc).isoformat()
        watchdog.write_json(self.root / 'seat-control/state.json', {'lastHeartbeat': stamp})

    def run_check(self, **kwargs):
        with patch.object(watchdog, 'recover', return_value={'action': 'online_requested', 'exit_code': 0}) as recover:
            result = watchdog.check(self.directory, self.now, **kwargs)
        return result, recover

    def test_fresh_heartbeat_and_live_watcher_are_healthy(self):
        self.heartbeat()
        with watchdog.try_lock(self.root / 'bridge.watch.lock') as held:
            self.assertTrue(held)
            result, recover = self.run_check()
        self.assertEqual(result['condition'], 'healthy')
        recover.assert_not_called()

    def test_stopped_watcher_recovers_even_with_recent_heartbeat(self):
        self.heartbeat()
        result, recover = self.run_check()
        self.assertEqual(result['condition'], 'service_stopped')
        recover.assert_called_once()

    def test_stale_missing_and_future_heartbeats_request_online_without_killing(self):
        for age in (90, 120, -10, None):
            with self.subTest(age=age):
                (self.directory / 'attempt.json').unlink(missing_ok=True)
                if age is None:
                    (self.root / 'seat-control/state.json').write_text('broken json')
                else:
                    self.heartbeat(age)
                with watchdog.try_lock(self.root / 'bridge.watch.lock'):
                    result, recover = self.run_check()
                self.assertEqual(result['condition'], 'heartbeat_stale')
                recover.assert_called_once()

    def test_recovery_failures_are_rate_limited(self):
        with patch.object(watchdog, 'recover', return_value={'action': 'online_timeout'}) as recover:
            self.assertEqual(watchdog.check(self.directory, self.now)['action'], 'online_timeout')
            self.assertEqual(watchdog.check(self.directory, self.now + 299)['action'], 'cooldown')
            self.assertEqual(recover.call_count, 1)
            watchdog.check(self.directory, self.now + 300)
            self.assertEqual(recover.call_count, 2)

    def test_initial_service_has_time_to_send_first_heartbeat(self):
        watchdog.write_json(self.directory / 'settings.json', {**self.settings, 'installed_at': self.now})
        result, recover = self.run_check()
        self.assertEqual(result['condition'], 'starting')
        recover.assert_not_called()

    def test_manual_offline_and_upgrade_marker_never_recover(self):
        for name, condition in (('seat-offline.json', 'manual_offline'), ('upgrade-in-progress.json', 'upgrading')):
            with self.subTest(name=name):
                marker = self.root / name
                marker.write_text('{}')
                result, recover = self.run_check()
                self.assertEqual(result['condition'], condition)
                recover.assert_not_called()
                self.assertTrue(marker.exists())
                marker.unlink()

    def test_live_upgrade_and_concurrent_probe_are_skipped(self):
        for lock, condition in ((self.root / 'upgrade.lock', 'upgrading'), (self.directory / 'check.lock', 'check_running')):
            with self.subTest(lock=lock), watchdog.try_lock(lock):
                result, recover = self.run_check()
                self.assertEqual(result['condition'], condition)
                recover.assert_not_called()

    def test_online_uses_current_bridge_and_exact_config_without_leaking_output(self):
        before = self.config.read_bytes()
        with patch.object(watchdog.subprocess, 'run', return_value=subprocess.CompletedProcess([], 1, 'secret', 'secret')) as run:
            result = watchdog.recover(self.config, self.cfg, self.settings)
        self.assertEqual(run.call_args.args[0], [sys.executable, str(self.bridge / 'harness_entry.py'), 'online'])
        self.assertEqual(run.call_args.kwargs['env']['DSP7_BRIDGE_CONFIG'], str(self.config))
        self.assertEqual(run.call_args.kwargs['env']['PAPERCLIP_SEAT_WATCHDOG_RECOVERY'], '1')
        self.assertEqual(result, {'action': 'online_requested', 'exit_code': 1})
        self.assertEqual(self.config.read_bytes(), before)

    def test_late_manual_offline_is_not_cleared_by_online(self):
        marker = self.root / 'seat-offline.json'
        marker.write_text('{}')
        with patch.dict(os.environ, PAPERCLIP_SEAT_WATCHDOG_RECOVERY='1'), \
             patch.object(seat_lifecycle, 'SERVICE_CONFIG', self.config), \
             patch.object(seat_lifecycle, 'Bridge', return_value=type('Bridge', (), {'cfg': self.cfg})()), \
             patch.object(seat_lifecycle.subprocess, 'run') as run, contextlib.redirect_stdout(None):
            seat_lifecycle.command(['online', '--config', str(self.config)])
        run.assert_not_called()
        self.assertTrue(marker.exists())

    def test_recovery_never_clears_offline_written_during_service_start(self):
        marker = self.root / 'seat-offline.json'
        def start(*args, **kwargs):
            marker.write_text('{}')
        with patch.dict(os.environ, PAPERCLIP_SEAT_WATCHDOG_RECOVERY='1'), \
             patch.object(sys, 'platform', 'linux'), patch.object(seat_lifecycle, 'SERVICE_CONFIG', self.config), \
             patch.object(seat_lifecycle, 'Bridge', return_value=type('Bridge', (), {'cfg': self.cfg})()), \
             patch.object(seat_lifecycle.subprocess, 'run', side_effect=start), contextlib.redirect_stdout(None):
            seat_lifecycle.command(['online', '--config', str(self.config)])
        self.assertTrue(marker.exists())

    def test_real_child_receives_only_selected_seat_config(self):
        entry = self.bridge / 'harness_entry.py'
        receipt = self.root / 'receipt.json'
        entry.write_text('import os,sys,json\nfrom pathlib import Path\nPath(' + repr(str(receipt)) + ').write_text(json.dumps({"config":os.environ["DSP7_BRIDGE_CONFIG"],"args":sys.argv[1:]}))\n')
        result = watchdog.check(self.directory, self.now)
        self.assertEqual(result['exit_code'], 0)
        self.assertEqual(json.loads(receipt.read_text()), {'config': str(self.config), 'args': ['online']})


if __name__ == '__main__':
    unittest.main()
