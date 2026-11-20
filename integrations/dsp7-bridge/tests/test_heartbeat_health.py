"""Recovery requires positive idle evidence and never kills task processes."""
import datetime as dt
import json
from pathlib import Path
import sqlite3
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch
import urllib.error

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import heartbeat_health as health
import seat_watchdog
import seat_upgrade
import seats
from pilot import BridgeError


class HeartbeatHealthTests(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        self.root = Path(temp.name)
        self.control = self.root / 'seat-control'
        self.control.mkdir()
        db = sqlite3.connect(':memory:')
        self.addCleanup(db.close)
        db.execute('CREATE TABLE seat_commands(status TEXT)')
        self.b = SimpleNamespace(cfg={'database': str(self.root / 'bridge.sqlite3'), 'agent_id': 'seat'}, db=db)
        self.stamp = 10000
        self.request()
        self.api = object()
        self.api_patch = patch.object(seats, 'seat_api', return_value=self.api)
        self.api_patch.start()
        self.addCleanup(self.api_patch.stop)
        self.idle_patch = patch.object(seat_upgrade, 'assert_idle')
        self.idle = self.idle_patch.start()
        self.addCleanup(self.idle_patch.stop)

    def request(self, **extra):
        health.atomic_json(self.control / 'heartbeat-recovery-request.json',
                           {'agentId': 'seat', 'requestedEpoch': self.stamp, **extra})

    def condition(self):
        return health.read_json(self.control / 'heartbeat-recovery.json')['condition']

    def recover(self):
        return health.recover_if_requested(self.b, self.stamp)

    def test_idle_exit_requires_bound_seat_api_and_consumes_request(self):
        self.assertTrue(self.recover())
        self.idle.assert_called_once_with(self.b, api=self.api)
        self.assertEqual(self.condition(), 'idle_restart_ready')
        self.assertFalse(self.recover())

    def test_unknown_server_idle_cannot_restart(self):
        self.idle.side_effect = BridgeError('secret HTTP response')
        self.assertFalse(self.recover())
        self.assertEqual(self.condition(), 'idle_unverified')
        self.assertNotIn('secret', (self.control / 'heartbeat-recovery.json').read_text())

    def test_pending_commands_and_live_wrapper_defer(self):
        self.b.db.execute("INSERT INTO seat_commands VALUES('awaiting_local')")
        self.assertFalse(self.recover())
        self.assertEqual(self.condition(), 'pending_commands')
        self.b.db.execute('DELETE FROM seat_commands')
        session = self.root / 'interactive/runs/run/session.json'
        session.parent.mkdir(parents=True)
        session.write_text(json.dumps({'wrapper_pid': 1234}))
        with patch('platform_support.process_alive', return_value=True):
            self.assertFalse(self.recover())
        self.assertEqual(self.condition(), 'local_wrapper_running')

    def test_offline_upgrade_and_activity_locks_block_restart(self):
        for name in ['seat-offline.json', 'upgrade-in-progress.json']:
            marker = self.root / name
            marker.touch()
            self.assertFalse(self.recover())
            self.assertEqual(self.condition(), 'offline_or_upgrading')
            marker.unlink()
        for name in ['upgrade.lock', 'interactive/operator.lock', 'seat-control/delivery.lock']:
            path = self.root / name
            path.parent.mkdir(parents=True, exist_ok=True)
            with seat_watchdog.try_lock(path):
                self.assertFalse(self.recover())
            self.assertEqual(self.condition(), 'activity_lock_busy')

    def test_offline_arriving_during_idle_check_is_preserved(self):
        self.idle.side_effect = lambda *a, **kw: (self.root / 'seat-offline.json').touch()
        self.assertFalse(self.recover())
        self.assertEqual(self.condition(), 'offline_or_upgrading')

    def test_fresh_heartbeat_cancels_recovery(self):
        health.atomic_json(self.control / 'state.json',
                           {'lastHeartbeat': dt.datetime.fromtimestamp(self.stamp - 10, dt.timezone.utc).isoformat()})
        self.assertFalse(self.recover())
        self.assertEqual(self.condition(), 'heartbeat_recovered')
        self.idle.assert_not_called()

    def test_wrong_identity_expired_and_future_requests_rejected(self):
        for extra in [{'agentId': 'other'}, {'requestedEpoch': self.stamp - 301}, {'requestedEpoch': self.stamp + 1}]:
            self.request(**extra)
            self.assertFalse(self.recover())
            self.assertEqual(self.condition(), 'request_invalid_or_expired')
        self.idle.assert_not_called()

    def test_restart_backoff_and_hourly_limit(self):
        for attempts in [[self.stamp - 20], [self.stamp - 1500, self.stamp - 1000, self.stamp - 500]]:
            health.atomic_json(self.control / 'heartbeat-restart-attempts.json', {'epochs': attempts})
            self.assertFalse(self.recover())
            self.assertEqual(self.condition(), 'restart_limit_reached')

    def test_diagnostic_records_stage_status_without_http_body_or_url(self):
        self.b._seat_heartbeat_stage = 'collection'
        try:
            try:
                raise urllib.error.HTTPError('http://secret', 403, 'secret token', {}, None)
            except urllib.error.HTTPError as error:
                raise BridgeError('secret response') from error
        except BridgeError as error:
            health.failure(self.b, error)
            health.failure(self.b, error)
        data = health.read_json(self.control / 'heartbeat-health.json')
        self.assertEqual((data['stage'], data['httpStatus'], data['consecutiveFailures']), ('collection', 403, 2))
        self.assertNotIn('secret', json.dumps(data))
        health.success(self.b)
        self.assertEqual(health.diagnose(self.b)['consecutiveFailures'], 0)

    def test_watch_loop_exits_for_supervisor_and_stops_receiver(self):
        import threading
        import pilot
        stopped = threading.Event()
        b = SimpleNamespace(cfg={'database': str(self.root / 'bridge.sqlite3')},
                            config_path=self.root / 'config.json')
        with patch.object(pilot, 'Bridge', return_value=b), patch.object(sys, 'argv', ['pilot.py', 'watch']), \
             patch('command_receiver.start_receiver', return_value=stopped), \
             patch('seat_lifecycle.finish_offline', return_value=False), \
             patch.object(health, 'recover_if_requested', return_value=True):
            with self.assertRaises(SystemExit) as error:
                pilot.main()
        self.assertEqual(error.exception.code, 75)
        self.assertTrue(stopped.is_set())
        with seat_watchdog.try_lock(self.root / 'bridge.watch.lock') as available:
            self.assertTrue(available)

    def test_real_idle_gate_rejects_active_server_run_and_local_process(self):
        self.idle_patch.stop()
        self.b.cfg['company_id'] = 'company'
        self.b.db.execute('CREATE TABLE runs(run_id TEXT)')
        self.b.pc = SimpleNamespace(request=lambda *a: self.fail('legacy credential used'))
        api = SimpleNamespace(request=lambda method, path:
                              [{'agentId': 'seat', 'status': 'running'}] if 'heartbeat-runs' in path else {'status': 'idle'})
        with patch.object(seats, 'seat_api', return_value=api):
            self.assertFalse(self.recover())
        self.assertEqual(self.condition(), 'idle_unverified')
        api.request = lambda method, path: [] if 'heartbeat-runs' in path else {'status': 'idle'}
        self.b.db.execute("INSERT INTO runs VALUES('old-run')")
        with patch.object(seats, 'seat_api', return_value=api), patch('pilot.processes_for_run', return_value=[456]):
            self.assertFalse(self.recover())
        self.assertEqual(self.condition(), 'idle_unverified')
        with patch.object(seats, 'seat_api', return_value=api), patch('pilot.processes_for_run', return_value=[]):
            self.assertTrue(self.recover())

    def test_watchdog_requests_cooperative_recovery_without_process_signals(self):
        bridge = self.root / 'bridge'
        bridge.mkdir()
        (bridge / 'harness_entry.py').touch()
        (bridge / 'heartbeat_health.py').touch()
        cfg = {**self.b.cfg, 'quick_setup': {'bridge': str(bridge)}}
        with patch.object(seat_watchdog.subprocess, 'run') as run:
            result = seat_watchdog.recover(self.root / 'config.json', cfg, {}, stale=True)
        run.assert_not_called()
        self.assertEqual(result['action'], 'cooperative_restart_requested')
        self.assertEqual(health.read_json(self.control / 'heartbeat-recovery-request.json')['agentId'], 'seat')


if __name__ == '__main__':
    unittest.main()
