import json
from pathlib import Path
import subprocess
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from harness_repositories import discover, public_inventory, resolve_existing, safe_url
from pilot import BridgeError
from seats import source_repo

class HarnessRepositoriesTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(); self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name).resolve()
        self.framework = self.root/'harness'; self.framework.mkdir()
        self.b = SimpleNamespace(root=self.framework, cfg={'intake_repository_roots':[str(self.root)]})
    def repo(self, name, remote='https://git.example/team/app.git'):
        path=self.root/name;path.mkdir(parents=True)
        for args in (['init','-b','dev'], ['-c','user.name=Fixture','-c','user.email=fixture@example.test','commit','--allow-empty','-m','fixture'], ['remote','add','origin',remote]):
            subprocess.run(['git','-C',str(path),*args],check=True,capture_output=True)
        return path
    def test_discovers_existing_checkout_and_omits_paths_and_credentials(self):
        path=self.repo('workspace/app','https://user:secret@git.example/team/app.git?token=secret')
        self.assertEqual(discover(self.b),[{'url':'https://git.example/team/app','ref':'dev','path':str(path)}])
        self.assertEqual(public_inventory(self.b),[{'url':'https://git.example/team/app','ref':'dev'}])
        self.assertNotIn('secret',json.dumps(public_inventory(self.b)))
    def test_source_repo_reuses_unique_checkout_without_manual_mapping(self):
        path=self.repo('app')
        with patch('seats.identity',return_value={}):
            self.assertEqual(source_repo(self.b,'project',{'id':'workspace','repoUrl':'https://git.example/team/app.git','repoRef':'dev'}),path)
        self.assertFalse(self.b.cfg.get('project_repositories'))
    def test_ambiguous_or_missing_baseline_never_guesses(self):
        self.repo('app');self.repo('other')
        for ref in ('dev','missing'):
            with self.assertRaises(BridgeError):resolve_existing(self.b,{'repoUrl':'https://git.example/team/app','repoRef':ref})
        with self.assertRaises(BridgeError):resolve_existing(self.b,{})
    def test_does_not_discover_frameworks_or_symlink_escapes(self):
        path=self.repo('outside/app')
        allowed=self.root/'allowed';allowed.mkdir();(allowed/'linked').symlink_to(path,target_is_directory=True)
        self.b.cfg['intake_repository_roots']=[str(allowed)]
        self.b.cfg['project_repositories']={'p:w':str(path)}
        self.assertEqual(discover(self.b),[])
        self.b.cfg['intake_repository_roots']=[str(self.root)]
        self.b.cfg['harness_capabilities']={'items':[{'root':str(path)}]}
        self.assertEqual(discover(self.b),[])
    def test_finds_business_checkout_in_registered_suite_workspace(self):
        suite=self.repo('suite', 'https://git.example/tools/suite.git')
        app=self.repo('suite/workspaces/app')
        self.b.cfg['harness_capabilities']={'items':[{'root':str(suite)}]}
        self.assertEqual([item['path'] for item in discover(self.b)],[str(app)])

    def settings(self, directories):
        path=self.framework/'.claude/settings.local.json';path.parent.mkdir(exist_ok=True)
        path.write_text(json.dumps({'permissions':{'additionalDirectories':directories}, 'env':{'TOKEN':'never-upload'}, 'hooks':{'ignored':'never-execute'}}))
    def test_native_settings_are_authoritative_and_non_git_directories_are_ignored(self):
        selected=self.repo('deep/path/to/app');self.repo('unrelated')
        self.settings(['../deep/path/to/app',str(self.framework)])
        self.assertEqual([item['path'] for item in discover(self.b)],[str(selected)])
        self.assertNotIn('never-upload',json.dumps(public_inventory(self.b)))
    def test_stale_foreign_and_outside_settings_never_choose_unrelated_repo(self):
        self.repo('unrelated')
        for paths in ([str(self.root/'missing')], [r'D:\\source\\app'], ['/outside/allowlist']):
            self.settings(paths)
            self.assertEqual(discover(self.b),[])
    def test_malformed_native_settings_do_not_trigger_unrelated_discovery(self):
        self.repo('unrelated');self.settings([])
        (self.framework/'.claude/settings.local.json').write_text('{broken')
        self.assertEqual(discover(self.b),[])

    def test_empty_native_directory_list_is_compatible_with_qa(self):
        self.settings([])
        self.assertEqual(public_inventory(self.b),[])

    def test_no_extra_repository_is_valid_for_test_harness(self):
        self.assertEqual(public_inventory(self.b),[])
    def test_ssh_origin_and_unsafe_origins(self):
        self.assertEqual(safe_url('git@git.example:team/app.git'),'ssh://git.example/team/app')
        for remote in ('/local/repo','file:///tmp/repo','https://git.example/team/../app'):
            with self.assertRaises(BridgeError):safe_url(remote)

if __name__=='__main__':unittest.main()
