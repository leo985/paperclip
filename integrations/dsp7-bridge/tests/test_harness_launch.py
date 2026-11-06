"""Native project discovery stays separate from governed source-worktree execution."""
import json
from pathlib import Path
import sys
import tempfile
import unittest
from types import SimpleNamespace

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from harness_launch import ROOT_MODE, LEGACY_MODE, inspect_harness, launch_context, native_args, task_prompt
from pilot import BridgeError
from interactive import interactive_args, with_wait_hook
from managed_sessions import register_local, Collector


class HarnessLaunchTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(); self.addCleanup(self.temp.cleanup)
        self.base = Path(self.temp.name)
        self.root = self.base / 'Harness 工程'; self.source = self.base / '源码 worktree'
        self.source.mkdir(); (self.root / 'harness/bin').mkdir(parents=True)
        (self.root / 'harness/bin/harness').write_text('launcher')
        (self.root / 'CLAUDE.md').write_text('Use the real Jira type and Harness gates')
        (self.root / '.claude/skills/jira-feature-dev').mkdir(parents=True)
        (self.root / '.claude/skills/jira-feature-dev/SKILL.md').write_text('feature')
        self.settings = self.root / '.claude/settings.local.json'
        self.settings.write_text(json.dumps({'env': {'ANTHROPIC_API_KEY': 'local-secret'}, 'hooks': {'Stop': []}}))
        (self.root / '.mcp.json').write_text(json.dumps({'mcpServers': {'jira': {'command': 'node', 'args': ['local']}}}))
        self.state = self.root / 'tickets/feature-TEST-1/state.json'
        self.state.parent.mkdir(parents=True); self.state.write_text('{}')
        self.b = SimpleNamespace(root=self.root, cfg={})
        self.details = {'mode': 'formal', 'worktree': str(self.source), 'state_path': str(self.state)}

    def test_formal_defaults_to_harness_without_changing_registered_source_or_config(self):
        original = dict(self.details); before = self.settings.read_bytes()
        result = launch_context(self.b, self.details)
        self.assertEqual(result['mode'], ROOT_MODE)
        self.assertEqual(result['cwd'], str(self.root.resolve()))
        self.assertEqual(result['source_cwd'], str(self.source.resolve()))
        self.assertEqual(self.details, original); self.assertEqual(self.b.cfg, {})
        self.assertEqual(self.settings.read_bytes(), before)
        self.assertNotIn('local-secret', json.dumps(result))

    def test_missing_guide_skills_or_invalid_json_never_falls_back(self):
        for file, replacement in [(self.root / 'CLAUDE.md', ''), (self.settings, '{"secret":"do-not-echo",')]:
            before = file.read_text(); file.write_text(replacement)
            with self.assertRaises(BridgeError) as error: launch_context(self.b, self.details)
            self.assertNotIn('do-not-echo', str(error.exception)); file.write_text(before)
        (self.root / '.claude/skills/jira-feature-dev/SKILL.md').unlink()
        with self.assertRaises(BridgeError): launch_context(self.b, self.details)

    def test_missing_source_is_not_replaced_by_harness(self):
        self.source.rmdir()
        with self.assertRaises(BridgeError): launch_context(self.b, self.details)

    def test_harness_managed_task_needs_no_source_path_or_additional_directory(self):
        details = {**self.details, 'worktree': None, 'repository_management': 'harness'}
        context = launch_context(self.b, details)
        self.assertEqual(context['cwd'], str(self.root.resolve()))
        self.assertEqual(context['source_cwd'], context['cwd'])
        self.assertNotIn('--add-dir', native_args([], context))
        prompt = task_prompt('TEST-1', 'platform task identity', context)
        self.assertIn('一个或多个仓库', prompt)
        self.assertNotIn('本次登记的业务源码目录', prompt)
        self.assertIn('platform task identity', prompt)

    def test_explicit_legacy_and_replay_keep_their_original_directories(self):
        self.b.cfg['claude_launch_mode'] = LEGACY_MODE
        self.assertEqual(launch_context(self.b, self.details)['cwd'], str(self.source.resolve()))
        self.b.cfg['claude_launch_mode'] = 'invalid'
        with self.assertRaises(BridgeError): launch_context(self.b, self.details)
        replay = {**self.details, 'mode': 'replay'}
        self.assertEqual(launch_context(self.b, replay)['cwd'], str(self.state.parent.resolve()))
        self.assertEqual(launch_context(self.b, replay, replay_cwd=self.base)['cwd'], str(self.base.resolve()))

    def test_project_settings_load_natively_once_external_settings_and_mcp_are_preserved(self):
        context = launch_context(self.b, self.details)
        external = self.base / 'external.json'; external.write_text('{}')
        args = native_args(['--settings', str(self.settings), '--mcp-config', '/platform/mcp.json', '--settings='+str(external)], context)
        self.assertNotIn(str(self.settings), args)
        self.assertIn('--settings='+str(external), args)
        self.assertIn('/platform/mcp.json', args)
        self.assertEqual(args[-4:], ['--setting-sources', 'user,project,local', '--add-dir', str(self.source.resolve())])
        with self.assertRaises(BridgeError): native_args(['--strict-mcp-config'], context)
        with self.assertRaises(BridgeError): native_args(['--setting-sources', 'user'], context)
        for flag in ('--settings', '--setting-sources'):
            with self.assertRaises(BridgeError): native_args([flag], context)

    def test_bridge_hooks_supplement_native_project_without_copying_credentials(self):
        folder = self.base / 'session'; folder.mkdir()
        args = interactive_args(['--print', '--settings', str(self.settings)], 'run', skip_permissions=True)
        args = native_args(args, launch_context(self.b, self.details))
        result = with_wait_hook(args, folder, 60, True)
        value = json.loads((folder / 'session-settings.json').read_text())
        self.assertNotIn('env', value)
        self.assertTrue(value['hooks']['Stop']); self.assertTrue(value['hooks']['PreToolUse'])
        self.assertIn('--dangerously-skip-permissions', result)
        self.assertEqual(json.loads(self.settings.read_text())['env']['ANTHROPIC_API_KEY'], 'local-secret')

    def test_prompt_uses_harness_routing_and_does_not_replace_domain_rules(self):
        result = task_prompt('TEST-1', 'platform metadata', launch_context(self.b, self.details))
        self.assertTrue(result.startswith('完成 TEST-1 工单。'))
        self.assertIn('查询 Jira 工单真实类型', result); self.assertIn('断点续传', result)
        self.assertIn(str(self.source), result); self.assertIn('不能覆盖', result)
        self.assertEqual(task_prompt('TEST-1', 'replay only', {'mode': 'replay-isolated'}), 'replay only')

    def test_collection_keeps_source_and_ticket_attachment_scope_after_cwd_changes(self):
        cfg = {'database': str(self.base / 'bridge.sqlite3')}
        register_local(cfg, '00000000-0000-4000-8000-000000000001', 'task', self.root, self.state, self.base, self.base / 'config.json', source_cwd=self.source)
        collector = Collector(cfg, '00000000-0000-4000-8000-000000000001'); self.addCleanup(collector.db.close)
        self.assertEqual(collector.info['cwd'], str(self.root))
        self.assertEqual(collector.info['source_cwd'], str(self.source))
        uploaded = []
        collector.content = lambda *args, **kw: uploaded.append(kw.get('unavailable'))
        outside = self.root / 'another-task.txt'; outside.write_text('another task')
        source = self.source / 'evidence.txt'; source.write_text('source evidence')
        evidence = self.state.parent / 'result.txt'; evidence.write_text('task evidence')
        collector.attachment('main', 'outside', str(outside))
        collector.attachment('main', 'source', str(source))
        collector.attachment('main', 'ticket', str(evidence.relative_to(self.root)))
        self.assertEqual(uploaded, ['附件不在受管任务允许目录', None, None])

if __name__ == '__main__': unittest.main()
