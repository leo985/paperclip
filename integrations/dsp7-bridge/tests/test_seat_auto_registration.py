"""Runtime drift recovers through registration, never by waiving readiness checks."""
import copy
import json
from pathlib import Path
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch
sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
from pilot import BridgeError
from seats import auto_refresh_runtime, RuntimeRefreshDeferred
from seat_control import refresh_registration, tick

PASS=[{'id':'registration','status':'pass','label':'登记一致性','message':'一致'}]
DRIFT=[{'id':'registration','status':'fail','label':'登记一致性','message':'变化'}]

class AutoRegistrationTest(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory();self.addCleanup(self.temp.cleanup)
        folder=Path(self.temp.name)
        self.profile={'environmentId':'env','claudeCommand':'/bin/claude','claudeVersion':'1','claudeSettingsFile':'/local/settings.json','configurationSource':'local-settings-file','harnessRoot':'/harness','settingsDigest':'old'}
        self.cfg={'agent_id':'seat','database':str(folder/'db'),'seat_runtime':{**self.profile,'revision':2}}
        config=folder/'config.json';config.write_text(json.dumps(self.cfg))
        self.b=SimpleNamespace(cfg=copy.deepcopy(self.cfg),config_path=config)
        self.agent={'defaultEnvironmentId':'env','adapterConfig':{'dsp7SeatRuntime':{**self.profile,'revision':2},'dsp7Seat':{'machineId':'machine','machineFingerprint':'fingerprint'}}}
        self.api=Mock();self.api.request.return_value=self.agent
        for name,value in [('seats.identity',{'machine_id':'machine','machine_fingerprint':'fingerprint'}),('seats.runtime_profile',{**self.profile,'settingsDigest':'new'}),('seats.seat_api',self.api)]:
            p=patch(name,return_value=value);p.start();self.addCleanup(p.stop)
        self.idle=patch('seat_upgrade.assert_idle');self.idle_mock=self.idle.start();self.addCleanup(self.idle.stop)
        self.register=patch('seats._command');self.register_mock=self.register.start();self.addCleanup(self.register.stop)

    def test_settings_drift_registers_at_the_same_enrolled_locations(self):
        auto_refresh_runtime(self.b)
        self.idle_mock.assert_called_once_with(self.b)
        self.register_mock.assert_called_once_with(self.b,['seat','register'])

    def test_claude_version_upgrade_is_refreshable(self):
        with patch('seats.runtime_profile',return_value={**self.profile,'claudeVersion':'2'}):auto_refresh_runtime(self.b)
        self.register_mock.assert_called_once()

    def test_paths_and_environment_are_not_automatically_rebound(self):
        for key in ('environmentId','harnessRoot','claudeCommand','claudeSettingsFile'):
            with self.subTest(key=key),patch('seats.runtime_profile',return_value={**self.profile,key:'different'}),self.assertRaises(RuntimeRefreshDeferred) as error:
                auto_refresh_runtime(self.b)
            self.assertEqual(error.exception.reason,'path')
        self.register_mock.assert_not_called()

    def test_server_revision_identity_or_profile_changes_are_not_overwritten(self):
        for change in ('revision','machine','profile','environment'):
            agent=copy.deepcopy(self.agent)
            if change=='revision':agent['adapterConfig']['dsp7SeatRuntime']['revision']=3
            if change=='machine':agent['adapterConfig']['dsp7Seat']['machineId']='other'
            if change=='profile':agent['adapterConfig']['dsp7SeatRuntime']['settingsDigest']='another'
            if change=='environment':agent['defaultEnvironmentId']='other'
            self.api.request.return_value=agent
            with self.subTest(change=change),self.assertRaises(RuntimeRefreshDeferred):auto_refresh_runtime(self.b)
        self.register_mock.assert_not_called()

    def test_active_and_queued_runs_or_local_processes_defer_without_stopping(self):
        self.idle_mock.side_effect=RuntimeError('active')
        with self.assertRaises(RuntimeRefreshDeferred) as error:auto_refresh_runtime(self.b)
        self.assertEqual(error.exception.reason,'busy');self.register_mock.assert_not_called()

    def test_server_transaction_conflict_is_not_swallowed_as_success(self):
        self.register_mock.side_effect=BridgeError('HTTP 409')
        with self.assertRaises(BridgeError):auto_refresh_runtime(self.b)

    def test_identity_validation_failure_never_registers(self):
        with patch('seats.identity',side_effect=BridgeError('wrong machine')),self.assertRaises(BridgeError):auto_refresh_runtime(self.b)
        self.register_mock.assert_not_called()

class RefreshCycleTest(unittest.TestCase):
    def test_success_immediately_rechecks_and_replaces_cached_failure(self):
        state={};b=Mock()
        with patch('seats.auto_refresh_runtime') as register,patch('seat_control.inspect_configuration',return_value=PASS) as check:
            result=refresh_registration(b,DRIFT,state,1000)
        register.assert_called_once_with(b);check.assert_called_once_with(b)
        self.assertEqual(result,PASS);self.assertEqual(state['checkedEpoch'],1000)
        self.assertEqual(state['registrationRefresh']['status'],'succeeded')

    def test_no_refresh_on_other_configuration_errors(self):
        for checks in [[],[{'id':'configuration','status':'fail'}],DRIFT+[{'id':'jira','status':'fail'}]]:
            with patch('seats.auto_refresh_runtime') as register:refresh_registration(Mock(),checks,{},1000)
            register.assert_not_called()

    def test_busy_retry_is_bounded_and_becomes_success_after_idle(self):
        state={};b=Mock()
        with patch('seats.auto_refresh_runtime',side_effect=RuntimeRefreshDeferred('busy')) as register:
            result=refresh_registration(b,DRIFT,state,1000)
            self.assertIn('空闲后',result[-1]['message']);self.assertEqual(state['registrationRefresh']['retryAfterEpoch'],1060)
            refresh_registration(b,result,state,1030);self.assertEqual(register.call_count,1)
        with patch('seats.auto_refresh_runtime') as register,patch('seat_control.inspect_configuration',return_value=PASS):
            self.assertEqual(refresh_registration(b,result,state,1060),PASS)
        register.assert_called_once();self.assertEqual(state['registrationRefresh']['status'],'succeeded')

    def test_post_registration_failure_cannot_report_ready(self):
        state={}
        with patch('seats.auto_refresh_runtime'),patch('seat_control.inspect_configuration',return_value=DRIFT):
            result=refresh_registration(Mock(),DRIFT,state,1000)
        self.assertTrue(any(c['status']=='fail' for c in result))
        self.assertNotIn('refreshedEpoch',state)

    def test_errors_do_not_expose_credentials_and_backoff_is_capped(self):
        state={}
        with patch('seats.auto_refresh_runtime',side_effect=BridgeError('secret-token settings-content')):
            for stamp in (1000,1060,1180,1420,1900,2800):result=refresh_registration(Mock(),DRIFT,state,stamp)
        self.assertNotIn('secret-token',json.dumps(result));self.assertEqual(state['registrationRefresh']['retryAfterEpoch'],3700)

    def test_healthy_runtime_renews_without_reregistering_every_tick(self):
        state={}
        with patch('seats.command') as check,patch('seats.auto_refresh_runtime') as register,patch('seat_control.inspect_configuration',return_value=PASS):
            refresh_registration(Mock(),PASS,state,4000);refresh_registration(Mock(),PASS,state,4001)
        check.assert_called_once();register.assert_not_called()

    def test_same_heartbeat_publishes_rechecked_state_without_waiting_for_cache_expiry(self):
        with tempfile.TemporaryDirectory() as temp:
            folder=Path(temp)
            (folder/'state.json').write_text(json.dumps({'checks':DRIFT,'checkedEpoch':1000,'repositoriesEpoch':1000}))
            b=SimpleNamespace(cfg={'agent_id':'seat'})
            api=Mock();api.request.side_effect=RuntimeError('end after heartbeat')
            def collect(_b,checks,_folder):
                return {'state':'idle','checks':checks},{}
            with patch('seat_control.time.time',return_value=1000),patch('seat_control.setup',return_value=folder),patch('seats.auto_refresh_runtime'),patch('seat_control.inspect_configuration',return_value=PASS),patch('seat_control.collect',side_effect=collect),patch('seat_control.seat_api',return_value=api),patch('seat_control.identity',return_value={}),self.assertRaisesRegex(RuntimeError,'end after heartbeat'):
                tick(b)
            body=api.request.call_args.args[2]
            self.assertEqual(body['state'],'idle');self.assertEqual(body['checks'],PASS)
            self.assertEqual(json.loads((folder/'state.json').read_text())['checks'],PASS)

if __name__=='__main__':unittest.main()
