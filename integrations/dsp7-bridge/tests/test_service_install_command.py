"""Recovery command preserves identity and uses the guarded native installer."""
import contextlib
import io
import json
import plistlib
from pathlib import Path
import runpy
import subprocess
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import seat_lifecycle
from pilot import BridgeError


class ServiceInstallCommandTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.config = self.root / 'config.json'
        self.cfg = {'execution_transport': 'outbound', 'seat_runtime': {'revision': 1},
                    'database': str(self.root / 'bridge.sqlite3'), 'agent_id': 'original-seat'}
        self.config.write_text(json.dumps(self.cfg))
        self.original = self.config.read_bytes()
        self.bridge = patch.object(seat_lifecycle, 'Bridge', return_value=SimpleNamespace(cfg=self.cfg))
        self.bridge.start()
        self.addCleanup(self.bridge.stop)
        self.service = patch.object(seat_lifecycle, 'SERVICE_CONFIG', self.config)
        self.service.start()
        self.addCleanup(self.service.stop)

    def command(self):
        with contextlib.redirect_stdout(io.StringIO()) as output:
            seat_lifecycle.command(['service', 'install', '--config', str(self.config)])
        return output.getvalue()

    def test_mac_and_windows_use_native_installer_and_preserve_identity(self):
        for platform in ('darwin', 'win32'):
            with self.subTest(platform=platform), patch.object(sys, 'platform', platform), \
                 patch.object(seat_lifecycle.subprocess, 'run') as run:
                message = self.command()
                self.assertEqual(Path(run.call_args_list[0].args[0][1]).name, 'install_service.py')
                self.assertTrue(run.call_args_list[0].kwargs['check'])
                if platform == 'darwin':
                    self.assertEqual(run.call_args_list[1].args[0][:2], ['launchctl', 'kickstart'])
                    self.assertNotIn('-k', run.call_args_list[1].args[0])
                else:
                    self.assertEqual(run.call_count, 1)
                self.assertIn('已补装并核验', message)
                self.assertEqual(self.config.read_bytes(), self.original)

    def test_failure_restores_offline_intent_without_claiming_success(self):
        marker = self.root / 'seat-offline.json'
        marker.write_bytes(b'{"requested":true}')
        with patch.object(seat_lifecycle.subprocess, 'run',
                          side_effect=subprocess.CalledProcessError(1, ['installer'])):
            with self.assertRaises(subprocess.CalledProcessError):
                self.command()
        self.assertEqual(marker.read_bytes(), b'{"requested":true}')
        self.assertEqual(self.config.read_bytes(), self.original)

    def test_success_resumes_local_offline_state(self):
        marker = self.root / 'seat-offline.json'
        marker.write_text('{}')
        with patch.object(sys, 'platform', 'win32'), patch.object(seat_lifecycle.subprocess, 'run'):
            self.command()
        self.assertFalse(marker.exists())

    def test_missing_or_incomplete_registration_never_installs_service(self):
        for mode in ('missing', 'incomplete'):
            with self.subTest(mode=mode), patch.object(seat_lifecycle.subprocess, 'run') as run:
                if mode == 'missing':
                    self.config.unlink()
                else:
                    self.config.write_text(json.dumps({**self.cfg, 'seat_runtime': None}))
                with self.assertRaises(BridgeError):
                    self.command()
                run.assert_not_called()

    def test_in_progress_upgrade_never_starts_old_service(self):
        (self.root / 'upgrade-in-progress.json').write_text('{}')
        with patch.object(seat_lifecycle.subprocess, 'run') as run:
            with self.assertRaisesRegex(BridgeError, '未结束的升级'):
                self.command()
            run.assert_not_called()

    def test_cli_routes_service_install_to_seat_command(self):
        import seat_profiles
        handler = Mock()
        with patch.object(sys, 'argv', ['harness', 'service', 'install']), \
             patch.object(seat_profiles, 'route_cli', side_effect=lambda argv: argv), \
             patch.object(seat_lifecycle, 'main', handler):
            runpy.run_path(str(Path(seat_lifecycle.__file__).with_name('harness_entry.py')))
        handler.assert_called_once_with(['service', 'install'])

    def test_repeated_mac_install_reuses_loaded_service_without_stopping_it(self):
        import seat_profiles
        bridge_root = Path(seat_lifecycle.__file__).parent
        label = 'test-seat-service'
        folder = self.root / 'Library/LaunchAgents'
        folder.mkdir(parents=True)
        service_file = folder / (label + '.plist')
        service_file.write_bytes(plistlib.dumps({
            'ProgramArguments': [sys.executable, str(bridge_root / 'pilot.py'), 'watch']}))
        with patch.object(Path, 'home', return_value=self.root), \
             patch.object(seat_profiles, 'config_path', return_value=self.config), \
             patch.object(seat_profiles, 'service_label', return_value=label), \
             patch.object(subprocess, 'run', return_value=SimpleNamespace(returncode=0)) as run:
            for _ in range(2):
                with contextlib.redirect_stdout(io.StringIO()):
                    runpy.run_path(str(bridge_root / 'install_launchagent.py'))
        commands = [call.args[0] for call in run.call_args_list]
        self.assertEqual(sum(cmd[:2] == ['launchctl', 'kickstart'] for cmd in commands), 2)
        for cmd in commands:
            self.assertNotIn('bootstrap', cmd)
            self.assertNotIn('bootout', cmd)
            self.assertNotIn('-k', cmd)


if __name__ == '__main__':
    unittest.main()
