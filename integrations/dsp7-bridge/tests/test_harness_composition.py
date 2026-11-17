import hashlib
import json
import os
from pathlib import Path
import runpy
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch
import uuid

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from harness_bundle_install import plan, install
from harness_composition import prepare_launch
from pilot import BridgeError


@unittest.skipUnless(os.environ.get('HARNESS_V2_ROOT'), 'Set HARNESS_V2_ROOT for composition integration')
class CompositionTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(); self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name).resolve()
        home = patch('harness_bundle_install.Path.home', return_value=self.root/'home')
        home.start(); self.addCleanup(home.stop)
        harness = Path(os.environ['HARNESS_V2_ROOT']).resolve()
        api = runpy.run_path(str(harness/'packaging/packages.py'))
        self.bundle = self.root/'source'
        self.catalog = api['build'](harness.parents[1], self.bundle, pilot_alias=True,
            assessment_methods=True, review_methods=True, design_method=True, development_methods=True,
            handoff_methods=True, knowledge_methods=True, delivery_methods=True)
        self.digest = self.catalog['bundleDigest']
        self.project = self.root/'native'; self.project.mkdir()
        config = self.root/'organization'/'config.json'; config.parent.mkdir()
        self.cfg = dict(company_id=str(uuid.uuid4()), agent_id=str(uuid.uuid4()),
            seat=dict(machine_id=str(uuid.uuid4())), harness_root=str(self.project), database=str(config.parent/'bridge.sqlite3'),
            unrelated=dict(preserve=True))
        config.write_text(json.dumps(self.cfg), encoding='utf8')
        self.b = SimpleNamespace(cfg=self.cfg, root=self.project, config_path=config)
        self.run, self.task = str(uuid.uuid4()), str(uuid.uuid4())
        lock = json.loads((self.bundle/'bundle-lock.json').read_bytes())
        bundle = dict(protocolVersion=1, bundleDigest=self.digest, project='base-harness-infrastructure', mode='candidate',
            packages=[dict(id=p['id'], version=p['version'], layer=p['layer'], skills=p['skills'],
                manifestDigest=next(e['manifestDigest'] for e in lock['packages'] if e['id']==p['id'])) for p in self.catalog['packages']])
        self.local = dict(enabled=True, bundleRoot=str(self.bundle), bundleDigest=self.digest, project=bundle['project'])
        self.cfg['harness_v2_execution'] = dict(enabled=True, versions={self.digest: self.local})
        cap = dict(kind='development', root=str(self.project), profile='default', commit='a'*40, roles=['coding'])
        self.route = dict(protocolVersion=2, runId=self.run, taskId=self.task, companyId=self.cfg['company_id'],
            agentId=self.cfg['agent_id'], machineId=self.cfg['seat']['machine_id'], registryRevision=2,
            capabilityId='native', capability=cap, composition=dict(schema='harness.execution-composition/1',
                selectionRevision=1, bundleRegistryRevision=3, bundle=bundle, nativeSkill='jira-feature-dev', entryId='harness-v2-feature-dev-pilot'))
        self.cfg['harness_capabilities'] = dict(items=[dict(cap, id='native')])
        self.remote = Mock()
        self.remote.request.side_effect = lambda _method, url: (dict(version=1, revision=3, items=[bundle])
            if url.endswith('harness-bundles') else dict(version=1, revision=2, items=[dict(cap, id='native')]))
        for target, value in [('harness_routing.identity', dict(machine_id=self.cfg['seat']['machine_id'])),
            ('harness_routing.seat_api', self.remote), ('harness_routing.inspect', cap), ('harness_composition.seat_api', self.remote)]:
            p = patch(target, return_value=value); p.start(); self.addCleanup(p.stop)
        self.state = self.project/'工单/feature-TEST-123/state.json'; self.state.parent.mkdir(parents=True)
        self.state.write_bytes('{"技能":"jira-feature-dev","当前Phase":"P3","状态":"in_progress"}\n'.encode())
        self.timer = self.state.with_name('execution-time.json'); self.timer.write_bytes(b'{"source":"legacy","generation":7}\n')
        self.folder = self.root/'run'; self.folder.mkdir()

    def pin(self):return hashlib.sha256(self.b.config_path.read_bytes()).hexdigest()
    def launch(self, **overrides):
        values = dict(project_root=self.project, source_root=self.project, state_path=self.state,
            folder=self.folder, cli_args=['--session-id', self.run], workflow='feature')
        values.update(overrides)
        return prepare_launch(self.b, self.route, self.run, self.task, **values)

    def test_install_preserves_original_config_and_is_idempotent_without_overwriting_version(self):
        with patch('harness_bundle_install.assert_idle') as idle:
            result = install(self.b, self.bundle, self.digest, self.local['project'], self.cfg['agent_id'], self.pin())
            self.assertTrue(result['installed']); self.assertFalse(result['executionReady'])
            self.assertEqual(self.b.cfg['unrelated'], dict(preserve=True))
            target = Path(self.b.cfg['harness_v2_execution']['versions'][self.digest]['bundleRoot'])
            before = (target/'bundle-lock.json').read_bytes()
            install(self.b, self.bundle, self.digest, self.local['project'], self.cfg['agent_id'], self.pin())
            self.assertEqual((target/'bundle-lock.json').read_bytes(), before); self.assertEqual(idle.call_count, 2)

    def test_stale_config_wrong_seat_and_busy_install_do_not_change_config(self):
        before = self.b.config_path.read_bytes()
        for seat, pin in [(str(uuid.uuid4()), self.pin()), (self.cfg['agent_id'], '0'*64)]:
            with self.assertRaises(BridgeError):install(self.b, self.bundle, self.digest, self.local['project'], seat, pin)
        with patch('harness_bundle_install.assert_idle', side_effect=RuntimeError('busy')):
            with self.assertRaises(RuntimeError):install(self.b, self.bundle, self.digest, self.local['project'], self.cfg['agent_id'], self.pin())
        self.assertEqual(self.b.config_path.read_bytes(), before)

    @unittest.skipUnless(os.name == 'nt', 'Native Windows MAX_PATH regression')
    def test_long_organization_root_installs_to_short_private_store_and_revalidates(self):
        from harness_bundle import validate
        runtime = self.root/('organization-'+'x'*120)
        runtime.mkdir()
        self.b.cfg['database'] = str(runtime/'bridge.sqlite3')
        self.b.config_path.write_bytes(json.dumps(self.b.cfg).encode('utf8'))
        with patch('harness_bundle_install.assert_idle'):
            install(self.b, self.bundle, self.digest, self.local['project'], self.cfg['agent_id'], self.pin())
        installed = self.b.cfg['harness_v2_execution']['versions'][self.digest]
        target = Path(installed['bundleRoot'])
        self.assertIn('.hvb', target.parts)
        self.assertEqual(target.name, self.digest[:16])
        self.assertLess(max(len(str(p)) for p in target.rglob('*')), 260)
        self.assertEqual(validate(installed)['catalog']['bundleDigest'], self.digest)

    def test_selected_method_launch_keeps_old_ledger_timer_and_package_bytes(self):
        before = self.state.read_bytes(), self.timer.read_bytes(), (self.bundle/'bundle-lock.json').read_bytes()
        args, env, instruction = self.launch()
        self.assertEqual(args.count('--plugin-dir'), 2); self.assertEqual(env['HARNESS_CORE_CONTEXT'], '1')
        self.assertIn('/fingard-history-methods:harness-v2-feature-dev-pilot', instruction)
        self.assertEqual(before, (self.state.read_bytes(), self.timer.read_bytes(), (self.bundle/'bundle-lock.json').read_bytes()))
        self.assertEqual(json.loads(Path(env['HARNESS_CONTEXT_FILE']).read_bytes())['state_path'], str(self.state))

    def test_wrong_workflow_legacy_skill_and_extra_plugins_fail_without_context(self):
        for changes in [dict(workflow='bugfix'), dict(cli_args=['--plugin-dir', 'untrusted'])]:
            with self.assertRaises(BridgeError):self.launch(**changes)
        self.state.write_bytes('{"技能":"jira-bug-fix"}'.encode())
        with self.assertRaises(BridgeError):self.launch()
        self.assertFalse((self.folder/'harness-execution-context.json').exists())

    def test_tampering_uninstalled_and_wrong_run_have_no_fallback(self):
        self.route['runId'] = str(uuid.uuid4())
        with self.assertRaises(BridgeError):self.launch()
        self.route['runId'] = self.run
        self.cfg['harness_v2_execution']['enabled'] = False
        with self.assertRaises(BridgeError):self.launch()
        self.cfg['harness_v2_execution']['enabled'] = True
        with (self.bundle/'runtime/src/core-entry.py').open('ab') as f:f.write(b'\n# tamper\n')
        with self.assertRaises(ValueError):self.launch()
        self.assertFalse((self.folder/'harness-execution-context.json').exists())

    def test_old_route_has_no_implicit_activation(self):
        args, env, prompt = prepare_launch(self.b, None, self.run, self.task,
            project_root=self.project, source_root=self.project, state_path=self.state, folder=self.folder, cli_args=['legacy'])
        self.assertEqual((args, env, prompt), (['legacy'], {}, ''))

    def test_same_observer_composition_reuses_plugins_and_context_without_double_loading(self):
        args, env, _ = self.launch()
        path = Path(env['HARNESS_CONTEXT_FILE']); before = path.read_bytes()
        args2, env2, _ = self.launch(cli_args=args, observer_env=env)
        self.assertEqual(args2, args); self.assertEqual(args2.count('--plugin-dir'), 2)
        self.assertEqual(env2['HARNESS_CONTEXT_FILE'], str(path)); self.assertEqual(path.read_bytes(), before)
        with self.assertRaises(BridgeError):self.launch(cli_args=args, observer_env=dict(env, HARNESS_BUNDLE_DIGEST='0'*64))

    def test_actual_observer_prepare_then_formal_launch_uses_one_context_and_plugin_pair(self):
        from managed_sessions import Collector, register_local
        from harness_observation_runtime import prepare
        from harness_bundle_registry import descriptor
        self.cfg['harness_v2_observation'] = self.local
        self.cfg['harness_v2_pilot'] = dict(companyId=self.cfg['company_id'], seatId=self.cfg['agent_id'], taskIds=[self.task])
        register_local(self.cfg, self.run, self.task, self.project, self.state, self.folder, self.b.config_path)
        attachment = dict(schema='harness.observer-binding/1', companyId=self.cfg['company_id'],
            seatId=self.cfg['agent_id'], machineId=self.cfg['seat']['machine_id'], taskId=self.task,
            runId=self.run, projectId=str(uuid.uuid4()), registryRevision=3, bundle=descriptor(self.local),
            purpose='observation-only', executionReady=False, loadState='unconfirmed')
        collector = Collector(self.cfg, self.run)
        try:
            args, env = prepare(collector, ['--session-id', self.run], platform_attachment=attachment)
            before = Path(env['HARNESS_CONTEXT_FILE']).read_bytes()
            final_args, final_env, _ = self.launch(cli_args=args, observer_env=env)
            self.assertEqual(final_args, args)
            self.assertEqual(final_args.count('--plugin-dir'), 2)
            self.assertEqual(final_env['HARNESS_CONTEXT_FILE'], env['HARNESS_CONTEXT_FILE'])
            self.assertEqual(Path(final_env['HARNESS_CONTEXT_FILE']).read_bytes(), before)
            self.assertEqual(json.loads(before)['identity']['projectId'], attachment['projectId'])
            self.assertFalse((self.folder/'harness-execution-context.json').exists())
        finally:
            collector.db.close()
