"""Starting a valid task must not require permission to register it again."""
import json
from pathlib import Path
import subprocess
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import Mock
sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
import install_service
import quick_install

class WindowsServiceReuseTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory();self.addCleanup(self.temp.cleanup)
        self.root=Path(self.temp.name);(self.root/'pythonw.exe').touch()
    def run_install(self,state,failure=None):
        calls=[]
        def execute(script,**kw):
            calls.append(script)
            if len(calls)==1:return SimpleNamespace(stdout=json.dumps(state))
            if failure:raise failure
            return SimpleNamespace(stdout='')
        install_service.install_windows_service(self.root,self.root/'python.exe',execute)
        return calls
    def test_existing_valid_task_only_starts_without_registration(self):
        calls=self.run_install(dict(exists=True,matches=True,enabled=True,running=False))
        self.assertEqual(len(calls),2)
        self.assertIn('Start-ScheduledTask',calls[1])
        self.assertNotIn('Register-ScheduledTask',calls[1])
        self.assertNotIn('New-ScheduledTaskAction',calls[1])
    def test_running_task_is_not_restarted_or_rewritten(self):
        self.assertEqual(len(self.run_install(dict(exists=True,matches=True,enabled=True,running=True))),1)
    def test_absent_task_is_registered_without_overwriting_concurrent_creation(self):
        calls=self.run_install(dict(exists=False,matches=False,enabled=False,running=False))
        self.assertIn('Register-ScheduledTask',calls[1]);self.assertNotIn('Register-ScheduledTask -Force',calls[1])
    def test_wrong_user_paths_or_trigger_are_not_overwritten(self):
        with self.assertRaisesRegex(RuntimeError,'不一致'):
            self.run_install(dict(exists=True,matches=False,enabled=True,running=False))
    def test_disabled_task_is_not_silently_modified(self):
        with self.assertRaisesRegex(RuntimeError,'禁用'):
            self.run_install(dict(exists=True,matches=True,enabled=False,running=False))
    def test_start_denial_is_propagated_without_register_retry(self):
        error=subprocess.CalledProcessError(1,['powershell.exe'],stderr='Register-ScheduledTask : Access is denied. 0x80070005')
        with self.assertRaises(subprocess.CalledProcessError):
            self.run_install(dict(exists=True,matches=True,enabled=True,running=False),failure=error)
        self.assertIn('0x80070005',install_service.service_error_message(error))
    def test_parent_displays_safe_service_diagnostic(self):
        error=subprocess.CalledProcessError(1,['python','install_service.py'],stderr='PAPERCLIP_SERVICE_ERROR: '+json.dumps({'message':'Windows 计划任务访问被拒绝（0x80070005）'}))
        self.assertIn('0x80070005',quick_install.installation_error(error))
        self.assertNotIn('--no-service',quick_install.installation_error(error))
    def test_parent_does_not_print_unknown_service_stderr(self):
        error=subprocess.CalledProcessError(1,['python','install_service.py'],stderr='private credential contents')
        self.assertNotIn('private credential',quick_install.installation_error(error))

if __name__=='__main__':unittest.main()
