"""Elevated Windows extraction must remain readable by an unelevated seat task."""
import hashlib
import io
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch
import zipfile

sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
import quick_install


class BundleDirectoryAclTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory();self.addCleanup(self.temp.cleanup)
        self.root=Path(self.temp.name)/'bridge'
        self.files={'platform_support.py':b'# verified platform\n','watch_windows.py':b'# verified watcher\n'}
        buffer=io.BytesIO()
        with zipfile.ZipFile(buffer,'w') as z:
            for name,value in self.files.items():z.writestr(name,value)
        self.archive=buffer.getvalue();self.digest=hashlib.sha256(self.archive).hexdigest()

    def download(self,url,limit):
        return json.dumps({'sha256':self.digest}).encode() if url.endswith('.json') else self.archive

    def install(self):
        with patch.object(quick_install,'FILES',set(self.files)),patch.object(quick_install,'download',side_effect=self.download):
            return quick_install.install_bundle('http://seat.test',self.root)

    def test_new_root_and_empty_staging_are_secured_before_writing_package(self):
        seen=[]
        def secure(path):
            self.assertTrue(path.is_dir());seen.append((path,list(path.iterdir())))
        with patch.object(quick_install,'secure_bundle_directory',side_effect=secure):dest=self.install()
        self.assertEqual(seen[0],(self.root,[]))
        self.assertTrue(seen[1][0].name.startswith('.download-'));self.assertEqual(seen[1][1],[])
        self.assertEqual((dest/'watch_windows.py').read_bytes(),self.files['watch_windows.py'])

    def test_reusing_a_version_repairs_acl_and_preserves_content(self):
        with patch.object(quick_install,'secure_bundle_directory'):dest=self.install()
        before={n:(dest/n).read_bytes() for n in self.files}
        with patch.object(quick_install,'secure_bundle_directory') as secure:
            self.assertEqual(self.install(),dest)
        self.assertEqual([c.args[0] for c in secure.call_args_list],[self.root,dest])
        self.assertEqual(before,{n:(dest/n).read_bytes() for n in self.files})

    def test_changed_content_is_still_rejected_after_acl_repair(self):
        with patch.object(quick_install,'secure_bundle_directory'):dest=self.install()
        (dest/'watch_windows.py').write_bytes(b'changed')
        with patch.object(quick_install,'secure_bundle_directory'),self.assertRaisesRegex(RuntimeError,'内容不完整或已修改'):self.install()
        self.assertEqual((dest/'watch_windows.py').read_bytes(),b'changed')

    def test_bootstrap_acl_is_access_only_current_sid_and_system(self):
        self.root.mkdir()
        with patch.object(sys,'platform','win32'),patch.object(quick_install.subprocess,'run') as run:
            quick_install.secure_bundle_directory(self.root)
        script=run.call_args.args[0][-1]
        self.assertIn("@($sid.Value,'S-1-5-18','S-1-5-32-544')",script)
        self.assertIn('SetAccessRuleProtection($true,$false)',script)
        self.assertIn("@($sid,[Security.Principal.SecurityIdentifier]::new('S-1-5-18'))",script)
        self.assertNotIn('SetOwner(',script);self.assertNotIn('Set-Acl',script)
        self.assertEqual(run.call_args.kwargs['stdin'],subprocess.DEVNULL)
        self.assertEqual(run.call_args.kwargs['env']['PAPERCLIP_ACL_PATH'],str(self.root.resolve()))

    def test_failed_bootstrap_does_not_print_arbitrary_powershell_output(self):
        self.root.mkdir()
        with patch.object(sys,'platform','win32'),patch.object(quick_install.subprocess,'run',side_effect=subprocess.CalledProcessError(1,['powershell.exe'],stderr='secret')):
            with self.assertRaisesRegex(RuntimeError,'权限核验失败') as raised:quick_install.secure_bundle_directory(self.root)
        self.assertNotIn('secret',str(raised.exception))

    def test_existing_bridge_is_repaired_before_package_readability_checks(self):
        self.root.mkdir();(self.root/'pilot.py').write_text('');(self.root/'seats.py').write_text('')
        harness=Path(self.temp.name)/'harness';harness.mkdir()
        with patch.object(sys,'platform','win32'),patch.object(quick_install,'secure_bundle_directory') as secure:
            result=quick_install.existing_bridge(harness,{'quick_setup':{'bridge':str(self.root)}})
        secure.assert_called_once_with(self.root);self.assertEqual(result,self.root.resolve())

    @unittest.skipUnless(sys.platform=='win32','Requires Windows directory ACLs')
    def test_real_windows_package_files_have_current_user_acl_after_extract_and_reuse(self):
        import platform_support
        dest=self.install()
        for name in self.files:self.assertTrue(platform_support.credential_private(dest/name))
        self.assertEqual(self.install(),dest)
        for name in self.files:self.assertTrue(platform_support.credential_private(dest/name))


if __name__=='__main__':unittest.main()
