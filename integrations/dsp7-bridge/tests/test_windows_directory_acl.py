"""Directory ACLs must not require Windows audit-security privileges."""
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import platform_support as platform
import quick_install


class DirectoryAclTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.folder = Path(self.temp.name) / 'seat bridge'
        self.cache = patch.object(platform, '_PRIVATE_DIRECTORIES', set())
        self.cache.start()
        self.addCleanup(self.cache.stop)

    def test_access_only_descriptor_preserves_owner_and_excludes_audit(self):
        with patch.object(platform, 'WINDOWS', True), patch.object(platform, 'powershell') as shell:
            platform.private_directory(self.folder)
            script = shell.call_args.args[0]
            self.assertIn('GetAccessControl([System.Security.AccessControl.AccessControlSections]::Access)', script)
            self.assertIn('GetAccessControl([System.Security.AccessControl.AccessControlSections]::Owner)', script)
            self.assertIn('$directory.SetAccessControl($acl)', script)
            self.assertIn('RemoveAccessRuleSpecific', script)
            self.assertIn('SetAccessRuleProtection($true,$false)', script)
            self.assertIn("'S-1-5-18'", script)
            self.assertIn("$trustedOwners=@($sid.Value,'S-1-5-18','S-1-5-32-544')", script)
            self.assertIn('if($owner -notin $trustedOwners)', script)
            self.assertNotIn('SetOwner(', script)
            self.assertNotIn('::Audit', script)
            self.assertNotIn('Set-Acl -', script)
            platform.private_directory(self.folder)
            self.assertEqual(shell.call_count, 1)

    def test_acl_failure_is_not_cached_or_reported_as_service_failure(self):
        error = subprocess.CalledProcessError(1, ['powershell.exe'], stderr='SeSecurityPrivilege secret-value')
        with patch.object(platform, 'WINDOWS', True), patch.object(platform, 'powershell', side_effect=error):
            with self.assertRaises(RuntimeError) as raised:
                platform.private_directory(self.folder)
            self.assertNotIn(str(self.folder.resolve()), platform._PRIVATE_DIRECTORIES)
            message = quick_install.installation_error(raised.exception)
            self.assertIn('Windows', message)
            self.assertNotIn('secret-value', message)
            self.assertNotIn('--no-service', message)

    def test_foreign_owner_is_rejected(self):
        error = subprocess.CalledProcessError(1, ['powershell.exe'], stderr='Seat directory has another owner: S-1-5-21-100-200-300-400')
        with patch.object(platform, 'WINDOWS', True), patch.object(platform, 'powershell', side_effect=error):
            with self.assertRaisesRegex(RuntimeError, 'S-1-5-21-100-200-300-400') as raised:
                platform.private_directory(self.folder)
            self.assertIn(str(self.folder.resolve()), str(raised.exception))

    def test_credential_owner_policy_matches_directory_without_opening_shared_files(self):
        credential = Path(self.temp.name) / 'credential.json'
        credential.write_text('{}')
        with patch.object(platform, 'WINDOWS', True), patch.object(platform, 'powershell') as shell:
            shell.return_value.stdout = 'private\n'
            self.assertTrue(platform.credential_private(credential))
            script = shell.call_args.args[0]
            self.assertIn("$allowed=@($me,'S-1-5-18','S-1-5-32-544')", script)
            self.assertIn('.Value -in $allowed -and $bad.Count -eq 0', script)
            self.assertIn('.Value -notin $allowed', script)
            self.assertIn('GetAccessRules($true,$true,[System.Security.Principal.SecurityIdentifier])', script)
            self.assertNotIn('.Translate(', script)
            self.assertNotIn('Get-Acl ', script)
            shell.return_value.stdout = 'shared\n'
            self.assertFalse(platform.credential_private(credential))

    def test_credential_timeout_names_the_check_without_printing_secrets(self):
        credential = Path(self.temp.name) / 'credential.json'
        credential.write_text('{}')
        error = subprocess.TimeoutExpired(['powershell.exe', 'secret-value'], 30)
        with patch.object(platform, 'WINDOWS', True), patch.object(platform, 'powershell', side_effect=error):
            with self.assertRaisesRegex(RuntimeError, '凭据权限校验超时') as raised:
                platform.credential_private(credential)
            self.assertNotIn('secret-value', str(raised.exception))

    def test_generic_subprocess_error_does_not_claim_service_failure(self):
        message = quick_install.installation_error(subprocess.CalledProcessError(1, ['powershell.exe']))
        self.assertNotIn('--no-service', message)
        self.assertNotIn('后台服务安装失败（', message)
        message = quick_install.installation_error(subprocess.CalledProcessError(1, [sys.executable, '/bridge/install_service.py']))
        self.assertNotIn('--no-service', message)
        self.assertIn('启动失败', message)

    def test_powershell_decodes_chinese_diagnostics_as_utf8(self):
        with patch.object(platform.subprocess, 'run') as run:
            platform.powershell('Write-Output test')
            self.assertTrue(run.call_args.args[0][-1].startswith('[Console]::OutputEncoding='))
            self.assertEqual(run.call_args.kwargs['encoding'], 'utf-8')

    @unittest.skipUnless(sys.platform == 'win32', 'Requires a real standard Windows user')
    def test_real_windows_standard_user_directory_and_inherited_file(self):
        platform.private_directory(self.folder)
        credential = self.folder / 'test-credential.json'
        credential.write_text('{}', encoding='utf-8')
        self.assertTrue(platform.credential_private(credential))


if __name__ == '__main__':
    unittest.main()
