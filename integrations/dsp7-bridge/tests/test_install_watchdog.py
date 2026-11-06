"""Native timers are per-seat, idempotent and never restart a watcher."""
import contextlib
import json
import os
from pathlib import Path
import plistlib
import subprocess
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import install_watchdog as installer
import install_service
import quick_install
import seat_profiles
import service_status


class InstallWatchdogTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.home = Path(self.temp.name)
        self.config = self.home / 'config.json'
        self.config.write_text('{}')
        self.directory = self.home / 'seat-watchdog'
        self.directory.mkdir()
        self.root = Path(installer.__file__).parent
        self.stack = contextlib.ExitStack()
        self.addCleanup(self.stack.close)
        self.stack.enter_context(patch.object(Path, 'home', return_value=self.home))
        self.stack.enter_context(patch.object(installer, 'config_path', return_value=self.config))

    def test_service_install_includes_watchdog_after_watcher_verification(self):
        events = []
        with patch.object(sys, 'platform', 'win32'), patch.dict(os.environ, PAPERCLIP_SEAT_WATCHDOG_RECOVERY='0'), \
             patch.object(install_service, 'install_windows_service', side_effect=lambda root: events.append('watcher')), \
             patch.object(service_status, 'verify_installation', side_effect=lambda root: events.append('verified')), \
             patch.object(installer, 'install', side_effect=lambda root: events.append('watchdog')):
            install_service.main()
        self.assertEqual(events, ['watcher', 'verified', 'watchdog'])

    def test_watchdog_recovery_does_not_reinstall_itself(self):
        with patch.object(sys, 'platform', 'win32'), patch.dict(os.environ, PAPERCLIP_SEAT_WATCHDOG_RECOVERY='1'), \
             patch.object(install_service, 'install_windows_service'), patch.object(service_status, 'verify_installation'), \
             patch.object(installer, 'install') as install:
            install_service.main()
        install.assert_not_called()

    def test_watchdog_failure_is_reported_instead_of_claiming_install_success(self):
        with patch.object(sys, 'platform', 'win32'), patch.dict(os.environ, PAPERCLIP_SEAT_WATCHDOG_RECOVERY='0'), \
             patch.object(install_service, 'install_windows_service'), patch.object(service_status, 'verify_installation'), \
             patch.object(installer, 'install', side_effect=RuntimeError('timer unavailable')):
            with self.assertRaisesRegex(RuntimeError, 'timer unavailable'):
                install_service.main()

    def test_mac_repeated_install_reuses_timer_without_restart(self):
        label = 'test-seat.watchdog'
        file = self.home / 'Library/LaunchAgents' / (label + '.plist')
        with patch.object(installer, 'service_label', return_value='test-seat'), \
             patch.object(installer.subprocess, 'run', return_value=SimpleNamespace(returncode=1)) as run:
            installer.install_mac(self.directory)
        self.assertIn('bootstrap', run.call_args.args[0])
        value = plistlib.loads(file.read_bytes())
        self.assertEqual(value['StartInterval'], 60)
        self.assertEqual(value['ProgramArguments'][1], str(self.directory / 'watchdog.py'))
        with patch.object(installer, 'service_label', return_value='test-seat'), \
             patch.object(installer.subprocess, 'run', return_value=SimpleNamespace(returncode=0)) as run:
            installer.install_mac(self.directory)
        commands = [call.args[0] for call in run.call_args_list]
        self.assertFalse(any('kickstart' in cmd or 'bootout' in cmd or 'bootstrap' in cmd for cmd in commands))

    def test_mac_foreign_timer_is_not_overwritten(self):
        folder = self.home / 'Library/LaunchAgents'
        folder.mkdir(parents=True)
        file = folder / 'test-seat.watchdog.plist'
        file.write_bytes(plistlib.dumps({'ProgramArguments': ['foreign']}))
        original = file.read_bytes()
        with patch.object(installer, 'service_label', return_value='test-seat'), \
             patch.object(installer.subprocess, 'run', return_value=SimpleNamespace(returncode=0)) as run:
            with self.assertRaisesRegex(RuntimeError, '未覆盖'):
                installer.install_mac(self.directory)
        self.assertEqual(file.read_bytes(), original)
        self.assertEqual(run.call_count, 1)

    def test_mac_organization_timers_are_distinct(self):
        with patch.object(installer.subprocess, 'run', return_value=SimpleNamespace(returncode=1)), \
             patch.object(installer, 'service_label', side_effect=['seat-a', 'seat-b']):
            installer.install_mac(self.directory)
            installer.install_mac(self.directory)
        self.assertEqual(len(list((self.home / 'Library/LaunchAgents').glob('*.watchdog.plist'))), 2)

    def test_windows_task_contract_is_per_user_periodic_and_non_destructive(self):
        python = self.home / 'python.exe'
        python.with_name('pythonw.exe').touch()
        with patch.object(sys, 'executable', str(python)), patch.object(installer, 'service_suffix', return_value='-second'), \
             patch.object(installer, 'powershell', return_value=SimpleNamespace(stdout='{"registered":true,"enabled":true}')) as run:
            installer.install_windows(self.directory)
        script = run.call_args.args[0]
        self.assertIn("'Zhiyan-Seat-Watchdog-'+$sid", script)
        self.assertIn('-RepetitionInterval (New-TimeSpan -Minutes 1)', script)
        self.assertIn('-LogonType Interactive', script)
        self.assertIn('refusing to overwrite', script)
        self.assertNotIn('-Force', script)
        self.assertNotIn('Start-ScheduledTask', script)
        self.assertEqual(run.call_args.kwargs['env']['PAPERCLIP_TASK_SUFFIX'], '-second')

    def test_windows_task_query_failure_propagates(self):
        python = self.home / 'python.exe'
        python.with_name('pythonw.exe').touch()
        with patch.object(sys, 'executable', str(python)), \
             patch.object(installer, 'powershell', side_effect=subprocess.CalledProcessError(1, ['powershell'])):
            with self.assertRaises(subprocess.CalledProcessError):
                installer.install_windows(self.directory)

    def test_linux_timer_is_reusable_and_does_not_start_the_oneshot(self):
        with patch.object(installer, 'service_suffix', return_value='-second'), \
             patch.object(installer.subprocess, 'run') as run:
            installer.install_linux(self.directory)
            installer.install_linux(self.directory)
        folder = self.home / '.config/systemd/user'
        timer = folder / 'paperclip-dsp7-watchdog-second.timer'
        self.assertIn('OnUnitActiveSec=60', timer.read_text())
        self.assertTrue((folder / 'paperclip-dsp7-watchdog-second.service').exists())
        self.assertFalse(any(call.args[0][-1].endswith('.service') for call in run.call_args_list))

    def test_install_writes_stable_runner_and_config_without_credentials(self):
        with patch.object(sys, 'platform', 'linux'), patch.object(installer, 'install_linux') as native, contextlib.redirect_stdout(None):
            installer.install(self.root)
        settings = json.loads((self.directory / 'settings.json').read_text())
        self.assertEqual(settings['config'], str(self.config))
        self.assertEqual((self.directory / 'watchdog.py').read_bytes(), (self.root / 'seat_watchdog.py').read_bytes())
        self.assertEqual((self.directory / 'remote_upgrade.py').read_bytes(), (self.root / 'seat_remote_upgrade.py').read_bytes())
        native.assert_called_once_with(self.directory)

    def test_distribution_contains_both_watchdog_modules(self):
        self.assertTrue({'seat_watchdog.py', 'install_watchdog.py', 'seat_remote_upgrade.py'} <= quick_install.FILES)


if __name__ == '__main__':
    unittest.main()
