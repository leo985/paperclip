import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch, Mock
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from harness_capabilities import inspect, repository_identity, choose_directory, main
from pilot import BridgeError

class CapabilityInspectionTest(unittest.TestCase):
    def test_credentials_never_enter_repository_identity(self):
        self.assertEqual(repository_identity('https://user:private-key@git.example.com/team/harness.git?token=secret'), 'git.example.com/team/harness')
        self.assertEqual(repository_identity('git@git.example.com:team/harness.git'), 'git.example.com/team/harness')
        with self.assertRaises(BridgeError): repository_identity('/local/source')
        with self.assertRaises(BridgeError): repository_identity('C:/local/source')
        with self.assertRaises(BridgeError): repository_identity('https://git.example.com/./source')
        with self.assertRaises(BridgeError): repository_identity('https://git.example.com/../source')

    def test_only_detected_skills_are_registered_and_manifest_detects_changes(self):
        with tempfile.TemporaryDirectory() as temp:
            root=Path(temp); (root/'CLAUDE.md').write_text('guide')
            skill=root/'.claude/skills/jira-feature-dev/SKILL.md';skill.parent.mkdir(parents=True);skill.write_text('coding')
            def fake_git(_root,*args):
                return str(root) if '--show-toplevel' in args else 'a'*40 if args==('rev-parse','HEAD') else 'https://user:private@git.example.com/team/dev.git'
            with patch('harness_capabilities.git',side_effect=fake_git):
                result=inspect(root,'development');self.assertEqual(result['roles'],['coding']);self.assertEqual(result['repository'],'git.example.com/team/dev')
                skill.write_text('new coding instructions');self.assertNotEqual(inspect(root,'development')['manifestDigest'],result['manifestDigest'])
                with self.assertRaises(BridgeError):inspect(root,'qa')
                with self.assertRaises(BridgeError):inspect(root,'analysis','../../escape')

    def test_review_roles_require_native_protocol_declaration_and_affect_manifest(self):
        with tempfile.TemporaryDirectory() as temp:
            root=Path(temp);(root/'CLAUDE.md').write_text('guide')
            for skill in ('jira-feature-dev','jira-design-review'):
                path=root/'.claude/skills'/skill/'SKILL.md';path.parent.mkdir(parents=True);path.write_text(skill)
            def fake_git(_root,*args):
                return str(root) if '--show-toplevel' in args else 'a'*40 if args==('rev-parse','HEAD') else 'https://git.example.com/team/dev.git'
            with patch('harness_capabilities.git',side_effect=fake_git):
                before=inspect(root,'development');self.assertNotIn('design-review',before['roles'])
                contract=root/'harness/delivery-review-protocols.json';contract.parent.mkdir();contract.write_text(json.dumps({'design-review':{'workflow':'design-review','guardRole':'design-review','version':1}}))
                (root/'harness/issue-policy.json').write_text('{}')
                template=root/'.claude/skills/jira-design-review/templates/state.json';template.parent.mkdir();template.write_text('{}')
                for name in ('issue_guard.py','execution_time.py','zhiyan_bridge.py','zhiyan_auto.py'):
                    script=root/'harness/scripts'/name;script.parent.mkdir(exist_ok=True);script.write_text('# native protocol')
                after=inspect(root,'development');self.assertIn('design-review',after['roles']);self.assertNotEqual(before['manifestDigest'],after['manifestDigest'])
                contract.write_text(json.dumps({'design-review':{'workflow':'feature','guardRole':'coding','version':1}}));self.assertNotIn('design-review',inspect(root,'development')['roles'])

    def test_product_roles_come_from_verified_bundle_instead_of_workspace_skill_files(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp).resolve()
            (root/'CLAUDE.md').write_text('guide')
            project = root/'harness'
            project.mkdir()
            pin = 'a' * 64
            (project/'v2-claude-release.json').write_text(json.dumps({
                'project':'base', 'bundleDigest':pin, 'sharedSkillSource':'verified-bundle',
            }))
            resources = root/'installed/resources'
            resources.mkdir(parents=True)
            (resources/'method-index.json').write_text(json.dumps({
                'schema':'harness.method-index/1', 'methods':[{'nativeId':'jira-feature-dev'}],
            }))
            installation = {'enabled':True, 'bundleRoot':str(resources.parent),
                            'bundleDigest':pin, 'project':'base'}
            bridge = Mock(cfg={'harness_v2_execution':{'enabled':True, 'versions':{pin:installation}}})

            def fake_git(_root, *args):
                if '--show-toplevel' in args:
                    return str(root)
                if args == ('rev-parse', 'HEAD'):
                    return 'b' * 40
                return 'https://git.example.com/team/product.git'

            with patch('harness_capabilities.git', side_effect=fake_git), patch(
                    'harness_bundle.validate', return_value={'resourceRoot':str(resources)}) as verify:
                self.assertEqual(inspect(root, 'development', bridge=bridge)['roles'], ['coding'])
                verify.assert_called_once_with(installation, (root,))
                self.assertFalse((root/'.claude/skills/jira-feature-dev/SKILL.md').exists())
                with self.assertRaisesRegex(BridgeError, '先安装'):
                    inspect(root, 'development')
                verify.side_effect = ValueError('bad digest')
                with self.assertRaisesRegex(BridgeError, '校验失败'):
                    inspect(root, 'development', bridge=bridge)

    def test_analysis_requires_native_cli_and_profile(self):
        with tempfile.TemporaryDirectory() as temp:
            root=Path(temp);(root/'CLAUDE.md').write_text('guide')
            skill=root/'.claude/skills/requirements-analysis/SKILL.md';skill.parent.mkdir(parents=True);skill.write_text('analyze')
            with patch('harness_capabilities.git',return_value=str(root)):
                with self.assertRaises(BridgeError):inspect(root,'analysis','dsp')

class DirectorySelectionTest(unittest.TestCase):
    def test_mac_uses_system_picker_without_interpolated_paths(self):
        with patch('harness_capabilities.sys.platform','darwin'),patch('harness_capabilities.subprocess.run',return_value=Mock(returncode=0,stdout='/tmp/中文 Harness/\n')) as run:
            self.assertEqual(choose_directory(),'/tmp/中文 Harness/')
            self.assertEqual(run.call_args.args[0][0],'osascript')
            self.assertNotIn('shell',run.call_args.kwargs)

    def test_windows_picker_uses_sta_and_encoded_static_script(self):
        with patch('harness_capabilities.sys.platform','win32'),patch('harness_capabilities.subprocess.run',return_value=Mock(returncode=0,stdout='C:\\用户\\QA Harness')) as run:
            self.assertEqual(choose_directory(),'C:\\用户\\QA Harness')
            command=run.call_args.args[0];self.assertIn('-STA',command);self.assertIn('-EncodedCommand',command)

    def test_linux_cancel_and_dialog_failure(self):
        with patch('harness_capabilities.sys.platform','linux'),patch('harness_capabilities.shutil.which',return_value='/usr/bin/zenity'),patch('harness_capabilities.subprocess.run',return_value=Mock(returncode=1,stdout='',stderr='')):
            self.assertIsNone(choose_directory())
        with patch('harness_capabilities.sys.platform','darwin'),patch('harness_capabilities.subprocess.run',side_effect=FileNotFoundError()):
            with self.assertRaises(BridgeError):choose_directory()

    def test_cancellation_and_wrong_seat_never_register(self):
        bridge=Mock(cfg={'agent_id':'seat-A'})
        with patch('harness_capabilities.Bridge',return_value=bridge),patch('harness_capabilities.choose_directory',return_value=None),patch('harness_capabilities.register') as register,patch('harness_capabilities.inspect') as inspect:
            main(['register','--kind','analysis','--profile','dsp','--choose','--seat-id','seat-A']);register.assert_not_called();inspect.assert_not_called()
            with self.assertRaises(BridgeError):main(['register','--kind','analysis','--choose','--seat-id','seat-B'])
            register.assert_not_called()

    def test_selection_is_validated_before_registration(self):
        bridge=Mock(cfg={'agent_id':'seat-A'})
        with patch('harness_capabilities.Bridge',return_value=bridge),patch('harness_capabilities.choose_directory',return_value='/tmp/QA Harness'),patch('harness_capabilities.inspect',return_value={'kind':'qa'}) as inspect,patch('harness_capabilities.register',return_value={'items':[]}) as register:
            main(['register','--kind','qa','--choose','--seat-id','seat-A']);inspect.assert_called_once_with('/tmp/QA Harness','qa','default');register.assert_called_once_with(bridge,{'kind':'qa'})
        with patch('harness_capabilities.Bridge',return_value=bridge),patch('harness_capabilities.choose_directory',return_value='/wrong'),patch('harness_capabilities.inspect',side_effect=BridgeError('wrong kind')),patch('harness_capabilities.register') as register:
            with self.assertRaises(BridgeError):main(['register','--kind','analysis','--choose'])
            register.assert_not_called()

if __name__=='__main__':unittest.main()
