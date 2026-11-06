"""Registration, readiness and query failure must be distinguishable to an operator."""
import json
from pathlib import Path
import subprocess
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
import platform_support
import seat_profiles
import service_status


class WindowsTaskDiagnosticsTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory();self.addCleanup(self.temp.cleanup)
        self.root=Path(self.temp.name).resolve()
        self.data=dict(taskName='Zhiyan-Seat-Bridge-test-profile',registered=True,matches=True,
                       taskEnabled=True,enabled=True,running=True,lastResult=267009)

    def inspect(self, **changes):
        data={**self.data,**changes}
        with patch.object(sys,'platform','win32'),patch.object(seat_profiles,'config_path',return_value=self.root/'config.json'),patch.object(platform_support,'powershell',return_value=SimpleNamespace(stdout=json.dumps(data))) as query:
            value=service_status.status(self.root)
        script=query.call_args.args[0]
        self.assertNotIn('Start-ScheduledTask',script)
        self.assertNotIn('Register-ScheduledTask',script)
        self.assertNotIn('Set-ScheduledTask',script)
        self.assertEqual(query.call_args.kwargs['env']['PAPERCLIP_STATUS_ROOT'],str(self.root))
        return value

    def test_registered_running_task_names_exact_task(self):
        value=self.inspect()
        self.assertTrue(value['registered']);self.assertTrue(value['running'])
        self.assertIn(self.data['taskName'],value['message'])
        self.assertIn('已注册、已启用、正在运行',value['message'])
        self.assertIn('当前用户登录后',value['message'])

    def test_missing_task_is_explicitly_unregistered(self):
        value=self.inspect(registered=False,matches=False,taskEnabled=False,enabled=False,running=False,lastResult=None)
        self.assertFalse(value['registered']);self.assertIn('未注册',value['message'])
        self.assertIn('harness online',value['message'])

    def test_disabled_task_is_still_registered(self):
        value=self.inspect(taskEnabled=False,enabled=False,running=False)
        self.assertTrue(value['registered']);self.assertIn('已禁用',value['message'])
        self.assertIn('任务计划程序中启用',value['message'])

    def test_other_identity_or_path_does_not_claim_enabled(self):
        value=self.inspect(matches=False,enabled=False,running=False)
        self.assertIn('不一致',value['message']);self.assertIn('不会自动覆盖',value['message'])
        self.assertFalse(value['enabled'])

    def test_stopped_task_shows_safe_hex_result_and_recovery(self):
        value=self.inspect(running=False,lastResult=2147942405)
        self.assertIn('当前未运行',value['message']);self.assertIn('0x80070005',value['message'])
        self.assertIn('watcher.log',value['message'])

    def test_paused_seat_does_not_claim_registration_failed(self):
        (self.root/'seat-offline.json').write_text('{}')
        value=self.inspect(running=False)
        self.assertTrue(value['enabled']);self.assertIn('已手动下线',value['message'])

    def test_access_denied_means_unknown_not_missing(self):
        with patch.object(sys,'platform','win32'),patch.object(seat_profiles,'config_path',return_value=self.root/'config.json'),patch.object(platform_support,'powershell',side_effect=subprocess.CalledProcessError(1,['powershell'],stderr='private credentials')):
            value=service_status.status(self.root)
        self.assertIsNone(value['registered']);self.assertIsNone(value['enabled'])
        self.assertIn('注册状态未知',value['message']);self.assertNotIn('private credentials',value['message'])

    def test_existing_check_contract_carries_registration_diagnostic(self):
        with patch.object(service_status,'status',return_value={**self.data,'message':'Windows 登录启动任务：已注册'}):
            value=service_status.check(self.root)
        self.assertEqual(value,dict(id='autostart',label='登录后自动上线',status='pass',message='Windows 登录启动任务：已注册'))

    def test_install_verification_still_rejects_missing_task(self):
        with patch.object(service_status,'status',return_value=dict(enabled=False,running=False,message='未注册')):
            with self.assertRaisesRegex(RuntimeError,'未注册'):service_status.verify_installation(self.root)


if __name__=='__main__':unittest.main()
