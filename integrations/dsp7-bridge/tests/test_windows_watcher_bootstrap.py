"""Bootstrap diagnostics survive failures before the Windows watcher starts."""
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import Mock, patch

sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
import platform_support
import watch_windows


class WatcherBootstrapTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root=Path(self.temp.name)/'runtime'

    def records(self):
        return [json.loads(line) for line in (self.root/'watcher.log').read_text().splitlines()]

    def test_permission_failure_leaves_stage_log_before_any_model_or_watcher(self):
        with patch.object(platform_support,'private_directory',side_effect=RuntimeError('secret credential')), patch.object(platform_support,'own_process_job') as job, patch.object(subprocess,'run') as run:
            self.assertEqual(watch_windows.main(self.root),2)
            job.assert_not_called();run.assert_not_called()
        last=self.records()[-1]
        self.assertEqual(last['failedStage'],'directory-permissions')
        self.assertNotIn('secret credential',(self.root/'watcher.log').read_text())

    def test_job_failure_is_diagnosed_and_does_not_start_supervisor(self):
        with patch.object(platform_support,'private_directory'),patch.object(platform_support,'own_process_job',side_effect=OSError(5,'secret')),patch.object(subprocess,'run') as run:
            self.assertEqual(watch_windows.main(self.root),2)
            run.assert_not_called()
        self.assertEqual(self.records()[-1]['failedStage'],'process-job')
        self.assertEqual(self.records()[-1]['errno'],5)

    def test_check_mode_runs_bootstrap_without_starting_work(self):
        with patch.object(platform_support,'private_directory'),patch.object(platform_support,'own_process_job'),patch.object(subprocess,'run') as run:
            self.assertEqual(watch_windows.main(self.root,check_startup=True),0)
            run.assert_not_called()
        self.assertEqual(self.records()[-1]['watcherStage'],'startup-check-passed')

    def test_child_uses_explicit_handles_and_preserves_exit_status(self):
        with patch.object(platform_support,'private_directory'),patch.object(platform_support,'own_process_job'),patch.object(subprocess,'run',return_value=Mock(returncode=7)) as run:
            self.assertEqual(watch_windows.main(self.root),7)
            self.assertEqual(run.call_args.kwargs['stdin'],subprocess.DEVNULL)
            self.assertIsNotNone(run.call_args.kwargs['stdout'])
            self.assertIsNotNone(run.call_args.kwargs['stderr'])
        self.assertEqual(self.records()[-1]['exitCode'],7)

    def test_powershell_does_not_inherit_a_missing_pythonw_input_handle(self):
        with patch.object(platform_support.subprocess,'run') as run:
            platform_support.powershell('Write-Output test')
            self.assertEqual(run.call_args.kwargs['stdin'],subprocess.DEVNULL)

    def test_named_profile_logs_and_child_use_its_own_configuration(self):
        config=self.root/'organizations/company/config.json'
        with patch.object(platform_support,'private_directory'),patch.object(platform_support,'own_process_job'),patch.object(subprocess,'run',return_value=Mock(returncode=0)) as run:
            self.assertEqual(watch_windows.main(config=config),0)
        self.assertTrue((config.parent/'watcher.log').is_file())
        self.assertFalse((self.root/'watcher.log').exists())
        self.assertEqual(run.call_args.kwargs['env']['DSP7_BRIDGE_CONFIG'],str(config))


if __name__=='__main__':
    unittest.main()
