import copy
import json
from pathlib import Path
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from harness_auto_registration import refresh, refresh_when_idle
from pilot import BridgeError


class HarnessAutoRegistrationTest(unittest.TestCase):
    def setUp(self):
        folder = tempfile.TemporaryDirectory(); self.addCleanup(folder.cleanup)
        self.path = Path(folder.name) / 'config.json'
        self.cap = dict(id='cap', kind='analysis', root='/analysis', repository='git.example/team/analysis',
                        profile='dsp', protocolVersion=1, roles=['requirements-analysis'], commit='old', manifestDigest='old')
        self.registry = dict(version=1, revision=2, items=[self.cap])
        self.cfg = dict(database=str(Path(folder.name)/'db'), agent_id='seat', company_id='company',
                        seat={'machine_id':'machine'}, harness_capabilities=self.registry, unrelated='preserve')
        self.path.write_text(json.dumps(self.cfg))
        self.b = SimpleNamespace(cfg=copy.deepcopy(self.cfg), config_path=self.path)
        self.current = {k:v for k,v in self.cap.items() if k != 'id'}
        self.current.update(commit='new', manifestDigest='new')
        self.api = Mock()
        self.updated = dict(version=1, revision=3, items=[{**self.current, 'id':'cap'}])
        self.api.request.side_effect = [self.registry, self.updated]
        for name, value in [('harness_auto_registration.seat_api',self.api), ('harness_auto_registration.identity',{'machine_id':'machine'}), ('harness_auto_registration.inspect',self.current)]:
            p=patch(name,return_value=value);p.start();self.addCleanup(p.stop)
        p=patch('seat_upgrade.assert_idle');self.idle=p.start();self.addCleanup(p.stop)

    def test_content_update_is_authenticated_revision_bound_and_persisted(self):
        self.assertEqual(refresh(self.b),1)
        body=self.api.request.call_args.args[2]
        self.assertTrue(body['automatic']);self.assertEqual(body['expectedRevision'],2)
        saved=json.loads(self.path.read_text());self.assertEqual(saved['harness_capabilities'],self.updated)
        self.assertEqual(saved['unrelated'],'preserve');self.idle.assert_called_once_with(self.b)

    def test_unchanged_content_does_not_post_or_increment_revision(self):
        self.api.request.side_effect=[self.updated]
        self.assertEqual(refresh(self.b),0);self.api.request.assert_called_once();self.idle.assert_not_called()

    def test_identity_capability_and_protocol_changes_never_auto_register(self):
        for key in ('root','repository','profile','kind','protocolVersion','roles'):
            with self.subTest(key=key):
                self.api.request.side_effect=[self.registry]
                with patch('harness_auto_registration.inspect',return_value={**self.current,key:'other'}),self.assertRaises(BridgeError):refresh(self.b)
                self.assertEqual(json.loads(self.path.read_text())['harness_capabilities'],self.registry)

    def test_missing_remote_enrollment_or_remote_identity_change_rejects(self):
        for items in ([],[{**self.cap,'root':'/other'}]):
            self.api.request.side_effect=[{**self.registry,'items':items}]
            with self.assertRaises(BridgeError):refresh(self.b)

    def test_server_conflict_keeps_original_receipt(self):
        self.api.request.side_effect=[self.registry,BridgeError('HTTP 409')]
        with self.assertRaises(BridgeError):refresh(self.b)
        self.assertEqual(json.loads(self.path.read_text())['harness_capabilities'],self.registry)

    def test_live_local_process_defers_without_posting_or_stopping(self):
        self.api.request.side_effect=[self.registry];self.idle.side_effect=RuntimeError('busy')
        with self.assertRaises(RuntimeError):refresh(self.b)
        self.api.request.assert_called_once()

    def test_moving_checkout_is_not_registered(self):
        self.api.request.side_effect=[self.registry]
        with patch('harness_auto_registration.inspect',side_effect=[self.current,{**self.current,'manifestDigest':'moving'}]),self.assertRaises(BridgeError):refresh(self.b)
        self.api.request.assert_called_once()

    def test_busy_seat_skips_and_idle_retries_are_bounded(self):
        state={}
        with patch('harness_auto_registration.refresh',side_effect=BridgeError('private data')) as call:
            for presence in ({'state':'busy'},{'state':'waiting_decision'},{'state':'idle','activeRuns':[{}]}):
                refresh_when_idle(self.b,presence,state,100)
            call.assert_not_called()
            presence={'state':'idle','checks':[]}
            refresh_when_idle(self.b,presence,state,100)
            self.assertEqual(state['harnessRefresh']['status'],'deferred')
            self.assertNotIn('private data',str(presence))
            refresh_when_idle(self.b,presence,state,110);self.assertEqual(call.call_count,1)
            refresh_when_idle(self.b,presence,state,161);self.assertEqual(call.call_count,2)
            self.assertEqual(len(presence['checks']),1)

    def default_development(self):
        root = str(self.path.parent)
        self.b.cfg.pop('harness_capabilities')
        self.b.cfg.update(harness_root=root, seat_runtime={'harnessRoot': root})
        self.path.write_text(json.dumps(self.b.cfg))
        current = {**self.current, 'root': root, 'kind': 'development', 'profile': 'default', 'roles': ['coding']}
        updated = {'version': 1, 'revision': 1, 'items': [{**current, 'id': 'dev'}]}
        self.api.request.side_effect = [{'version': 1, 'revision': 0, 'items': []}, updated]
        return current, updated

    def test_empty_legacy_seat_enrolls_only_its_registered_development_root(self):
        current, updated = self.default_development()
        with patch('harness_auto_registration.inspect', return_value=current) as inspect:
            self.assertEqual(refresh(self.b), 1)
        self.assertEqual(inspect.call_args.args, (current['root'], 'development', 'default'))
        body = self.api.request.call_args.args[2]
        self.assertTrue(body['automatic']); self.assertEqual(body['expectedRevision'], 0)
        self.assertEqual(body['capability'], current)
        self.assertEqual(json.loads(self.path.read_text())['harness_capabilities'], updated)
        self.idle.assert_called_once()
        # Subsequent refreshes use the stored receipt and never enroll again.
        self.api.request.side_effect = [updated]
        with patch('harness_auto_registration.inspect', return_value=current):
            self.assertEqual(refresh(self.b), 0)

    def test_first_enrollment_does_not_rebind_a_changed_local_root(self):
        self.default_development()
        self.b.cfg['harness_root'] = str(self.path.parent / 'different')
        self.path.write_text(json.dumps(self.b.cfg))
        with self.assertRaises((BridgeError, OSError)): refresh(self.b)
        self.api.request.assert_called_once()

    def test_first_enrollment_busy_or_missing_skills_keeps_empty_registry(self):
        current, _ = self.default_development()
        with patch('harness_auto_registration.inspect', side_effect=BridgeError('missing native skill')):
            with self.assertRaises(BridgeError): refresh(self.b)
        self.assertNotIn('harness_capabilities', json.loads(self.path.read_text()))
        self.api.request.reset_mock()
        self.api.request.side_effect = [{'version': 1, 'revision': 0, 'items': []}]
        self.idle.side_effect = RuntimeError('busy')
        with patch('harness_auto_registration.inspect', return_value=current):
            with self.assertRaises(RuntimeError): refresh(self.b)
        self.api.request.assert_called_once()

    def test_empty_registry_is_retried_by_idle_heartbeat(self):
        self.default_development()
        state = {}
        with patch('harness_auto_registration.refresh', side_effect=[BridgeError('private'), 1]) as call:
            presence = {'state': 'idle', 'checks': []}
            refresh_when_idle(self.b, presence, state, 100)
            self.assertEqual(state['harnessRefresh']['status'], 'deferred')
            self.assertNotIn('private', str(presence))
            refresh_when_idle(self.b, {'state': 'idle'}, state, 110)
            self.assertEqual(call.call_count, 1)
            refresh_when_idle(self.b, {'state': 'idle'}, state, 161)
            self.assertEqual(state['harnessRefresh'], {'status': 'ok', 'updatedCount': 1})

    def test_first_development_enrollment_preserves_other_domain_routes(self):
        current, updated = self.default_development()
        local = {**self.registry, 'routing': {'analysis': 'cap'}}
        self.b.cfg['harness_capabilities'] = local
        self.path.write_text(json.dumps(self.b.cfg))
        updated = {**updated, 'revision': 3, 'routing': local['routing'], 'items': local['items'] + updated['items']}
        self.api.request.side_effect = [local, updated]
        with patch('harness_auto_registration.inspect', side_effect=lambda root, kind, profile: current if kind == 'development' else {k:v for k,v in self.cap.items() if k != 'id'}):
            self.assertEqual(refresh(self.b), 1)
        saved = json.loads(self.path.read_text())['harness_capabilities']
        self.assertEqual(saved['routing'], {'analysis': 'cap'})
        self.assertEqual(saved['items'][0], self.cap)

    def test_recovers_a_committed_first_registration_after_lost_network_receipt(self):
        current, updated = self.default_development()
        self.api.request.side_effect = [updated]
        with patch('harness_auto_registration.inspect', return_value=current):
            self.assertEqual(refresh(self.b), 0)
        self.api.request.assert_called_once()
        self.assertEqual(json.loads(self.path.read_text())['harness_capabilities'], updated)

    def test_does_not_recover_a_remote_development_receipt_for_different_files(self):
        current, updated = self.default_development()
        self.api.request.side_effect = [updated]
        with patch('harness_auto_registration.inspect', return_value={**current, 'manifestDigest': 'other'}):
            with self.assertRaises(BridgeError): refresh(self.b)
        self.assertNotIn('harness_capabilities', json.loads(self.path.read_text()))


class SetupDevelopmentEnrollmentTest(unittest.TestCase):
    def test_setup_attempts_capabilities_before_starting_service_and_explains_failure(self):
        import contextlib
        import io
        import quick_install
        b = SimpleNamespace(cfg={'seat_runtime': {'revision': 1}}, root=Path('/harness'))
        for failure in (None, BridgeError('sensitive diagnostics')):
            with self.subTest(failure=bool(failure)), patch('quick_install.install_cli'), patch('seats.command'), patch('harness_auto_registration.refresh', side_effect=failure) as enroll, patch('quick_install.subprocess.run') as service:
                output = io.StringIO()
                with contextlib.redirect_stdout(output):
                    quick_install.finish_setup(b, Path('/bridge'), False)
                enroll.assert_called_once_with(b)
                service.assert_called_once()
                self.assertNotIn('sensitive diagnostics', output.getvalue())
                if failure: self.assertIn('上线空闲后会自动重试', output.getvalue())


if __name__=='__main__':unittest.main()
