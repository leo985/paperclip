"""Upgrade errors identify the exact operation without leaking PowerShell data."""
from pathlib import Path
import subprocess
import sys
import unittest
from unittest.mock import patch
sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
import seat_upgrade
import platform_support

class UpgradeDiagnosticsTests(unittest.TestCase):
    def diagnostic(self,script,detail):
        error=subprocess.CalledProcessError(1,['powershell.exe','secret-script'],stderr=detail)
        with patch.object(platform_support,'powershell',side_effect=error):
            with self.assertRaises(RuntimeError) as result:seat_upgrade.windows_service(script,Path('/old'))
        return str(result.exception)
    def test_snapshot_denial_is_distinguished_from_task_deletion(self):
        msg=self.diagnostic('Export-ScheduledTask -TaskName $name','Export-ScheduledTask : Access is denied. 0x80070005')
        self.assertIn('备份旧计划任务',msg);self.assertIn('0x80070005',msg)
        self.assertNotIn('secret-script',msg)
    def test_stop_denial_identifies_the_mutation_stage(self):
        msg=self.diagnostic('Stop-ScheduledTask -TaskName $name; Unregister-ScheduledTask -TaskName $name','PermissionDenied')
        self.assertIn('停止并移除计划任务',msg);self.assertIn('Windows 拒绝访问',msg)
    def test_foreign_directory_does_not_recommend_elevation(self):
        msg=self.diagnostic('Write-Output exists','Unknown seat task; refusing to replace it')
        self.assertIn('核验计划任务路径',msg);self.assertIn('未覆盖',msg);self.assertNotIn('提升权限',msg)
    def test_unknown_failure_reports_only_identifiers(self):
        msg=self.diagnostic('Write-Output exists','private-token and backup XML\nFullyQualifiedErrorId : TaskNotFound\nHRESULT 0x80070002')
        self.assertIn('TaskNotFound',msg);self.assertIn('0x80070002',msg)
        self.assertNotIn('private-token',msg);self.assertNotIn('backup XML',msg)
    def test_byte_stderr_and_chinese_permissions(self):
        self.assertIn('Windows 拒绝访问',self.diagnostic('Start-ScheduledTask -TaskName $name','访问被拒绝'.encode()))

if __name__=='__main__':unittest.main()
