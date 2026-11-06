"""Public layout negotiation uses only temporary files; no Jira or seats."""
import json
import sqlite3
from types import SimpleNamespace
from unittest.mock import Mock, patch
from pathlib import Path
import sys
import tempfile
import unittest
sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
from pilot import artifact_state_path, effective_state_details, agent_entry_instructions, BridgeError, Bridge


class ArtifactLayoutTest(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory();self.addCleanup(self.tmp.cleanup)
        self.root=Path(self.tmp.name);(self.root/'harness').mkdir()
        self.contract=self.root/'harness/artifact-layout.json'
        self.layout={'schema_version':1,'directory':'工单','workflow_prefixes':{'feature':'feature','bugfix':'bugfix','design-doc':'design','code-review':'review'}}
        self.legacy=self.root/'tickets/design-TEST-1/state.json'
        self.canonical=self.root/'工单/design-TEST-1/state.json'
        self.details={'workflow':'design','jira_key':'TEST-1','state_path':str(self.legacy)}
    def declare(self,**changes):
        self.contract.write_text(json.dumps(self.layout|changes))
    def test_missing_contract_compatible_and_design_mapping(self):
        self.assertEqual(artifact_state_path(self.root,'design','TEST-1'),self.legacy)
        self.declare();self.assertEqual(artifact_state_path(self.root,'design','TEST-1'),self.canonical)
        self.assertEqual(artifact_state_path(self.root,'integration','TEST-1'),self.root/'tickets/integration-TEST-1/state.json')
    def test_malformed_and_unsafe_contracts_fail(self):
        for changes in [{'schema_version':2},{'schema_version':True},{'directory':'../escape'},{'directory':'/tmp'},{'directory':'C:\\escape'},{'directory':'   '},{'workflow_prefixes':{'design-doc':'design'}},{'workflow_prefixes':{'design-doc':'../design'}}]:
            self.declare(**changes)
            with self.assertRaises(BridgeError):artifact_state_path(self.root,'design','TEST-1')
        self.contract.write_text('{')
        with self.assertRaises(BridgeError):artifact_state_path(self.root,'design','TEST-1')
    def test_default_mapping_is_read_only_custom_and_replay_preserved(self):
        self.declare();mapped=effective_state_details(self.root,self.details)
        self.assertEqual(mapped['state_path'],str(self.canonical));self.assertIn('state_path_notice',mapped)
        self.assertEqual(self.details['state_path'],str(self.legacy));self.assertFalse(self.canonical.exists())
        custom=self.details|{'state_path':str(self.root/'custom/state.json')}
        self.assertEqual(effective_state_details(self.root,custom),custom)
        replay=self.details|{'mode':'replay'};self.assertEqual(effective_state_details(self.root,replay),replay)
    def test_additional_workflows_preserve_existing_mappings(self):
        self.declare(workflow_prefixes=self.layout['workflow_prefixes']|{'design-review':'design-review','future-domain':'future'})
        self.assertEqual(artifact_state_path(self.root,'design','TEST-1'),self.canonical)
        self.assertEqual(artifact_state_path(self.root,'design-review','TEST-1'),self.root/'工单/design-review-TEST-1/state.json')
        self.assertEqual(artifact_state_path(self.root,'future-domain','TEST-1'),self.root/'工单/future-TEST-1/state.json')
    def test_extensions_cannot_escape_alias_or_change_core_mappings(self):
        for extra in [{'design-review':'../escape'},{'../domain':'review-extra'},{'design-review':'design'},{'design-doc':'changed'},{'design-review':{}},{'design-review':'C:\\escape'}]:
            with self.subTest(extra=extra):
                self.declare(workflow_prefixes=self.layout['workflow_prefixes']|extra)
                with self.assertRaises(BridgeError):artifact_state_path(self.root,'design','TEST-1')
    def test_bad_historical_registration_does_not_suppress_presence(self):
        from seat_control import collect
        folder=self.root/'seat-control';folder.mkdir()
        db=sqlite3.connect(':memory:');self.addCleanup(db.close);db.row_factory=sqlite3.Row
        db.executescript("CREATE TABLE pilots(jira_key TEXT); INSERT INTO pilots VALUES('TEST-1'),('TEST-2'); CREATE TABLE seat_commands(status TEXT);")
        bridge=SimpleNamespace(db=db,cfg={'database':str(self.root/'bridge.sqlite3')},pc=Mock())
        bridge.pilot=Mock(side_effect=[BridgeError('private path must not appear'),{'task_id':'done-task'}])
        bridge.pc.request.return_value={'status':'done'}
        checks=[{'id':'task_state:OLD-1','status':'fail'}]
        with patch('seat_control.offline_requested',return_value=False):
            presence,registered=collect(bridge,checks,folder)
        self.assertEqual(bridge.pilot.call_count,2)
        self.assertEqual(presence['state'],'config_error')
        self.assertEqual([c['id'] for c in presence['checks']],['task_state:TEST-1'])
        self.assertNotIn('private path',json.dumps(presence));self.assertEqual(registered,{})
        bridge.pilot.side_effect=None;bridge.pilot.return_value={'task_id':'done-task'}
        with patch('seat_control.offline_requested',return_value=False):
            repaired,_=collect(bridge,checks,folder)
        self.assertEqual(repaired['state'],'idle');self.assertEqual(repaired['checks'],[])
    def test_existing_legacy_preserved_and_dual_state_rejected(self):
        self.declare();self.legacy.parent.mkdir(parents=True);self.legacy.write_text('{}')
        self.assertEqual(effective_state_details(self.root,self.details),self.details)
        self.canonical.parent.mkdir(parents=True);self.canonical.write_text('{}')
        with self.assertRaisesRegex(BridgeError,'并存'):effective_state_details(self.root,self.details)
    def test_historical_completed_state_only_read_not_reset(self):
        self.declare();self.canonical.parent.mkdir(parents=True)
        raw=json.dumps({'工单号':'TEST-1','状态':'completed','tracker':{'historical':True}})
        self.canonical.write_text(raw)
        bridge=Bridge.__new__(Bridge);bridge.root=self.root
        state=bridge.state({'details':self.details,'jira_key':'TEST-1'})
        self.assertEqual(state['状态'],'completed');self.assertEqual(self.canonical.read_text(),raw)
        self.assertFalse(self.legacy.exists())
    def test_pilot_mapping_does_not_update_sqlite_registration(self):
        self.declare();db=sqlite3.connect(':memory:');self.addCleanup(db.close)
        db.row_factory=sqlite3.Row;db.execute('CREATE TABLE pilots(jira_key TEXT, config TEXT)')
        original=json.dumps(self.details);db.execute('INSERT INTO pilots VALUES(?,?)',('TEST-1',original))
        bridge=Bridge.__new__(Bridge);bridge.root=self.root;bridge.db=db
        self.assertEqual(bridge.pilot('TEST-1')['details']['state_path'],str(self.canonical))
        self.assertEqual(db.execute('SELECT config FROM pilots').fetchone()[0],original)
    def test_agent_inspect_exposes_history_and_complete_still_requires_lease(self):
        self.declare();self.canonical.parent.mkdir(parents=True)
        self.canonical.write_text(json.dumps({'工单号':'TEST-1','状态':'completed'}))
        bridge=Bridge.__new__(Bridge);bridge.root=self.root
        bridge.env={'PAPERCLIP_RUN_ID':'run'}
        bridge.current_pilot=Mock(return_value=({'jira_key':'TEST-1','details':self.details},{'id':'task','checkoutRunId':'run'}))
        result=bridge.agent('inspect',{})
        self.assertEqual(result['state']['状态'],'completed');self.assertIn('state_notice',result)
        bridge.require_lease=Mock(side_effect=BridgeError('lease required'))
        with self.assertRaisesRegex(BridgeError,'lease required'):bridge.agent('complete',{'summary':'done'})
        self.assertFalse(self.legacy.exists())
    def test_stage_block_and_complete_share_canonical_state_without_bypassing_delivery(self):
        self.declare();self.canonical.parent.mkdir(parents=True)
        self.canonical.write_text(json.dumps({'工单号':'TEST-1','状态':'completed','当前Phase':'P3'}))
        bridge=Bridge.__new__(Bridge);bridge.root=self.root
        bridge.env={'PAPERCLIP_RUN_ID':'run'}
        bridge.current_pilot=Mock(return_value=({'jira_key':'TEST-1','details':self.details},{'id':'task','checkoutRunId':'run'}))
        bridge.require_lease=Mock();bridge.event=Mock();bridge.pc=Mock();bridge.validate_jira=Mock()
        bridge.jc=SimpleNamespace(current_confirmation=lambda state:None)
        self.assertEqual(bridge.agent('stage',{'summary':'read canonical'})['phase'],'P3')
        with self.assertRaisesRegex(BridgeError,'已完成'):bridge.agent('block',{'summary':'block'})
        with self.assertRaisesRegex(BridgeError,'证据文件列表'):bridge.agent('complete',{'summary':'complete'})
        self.assertFalse((self.canonical.parent/'paperclip-completion.json').exists())
        self.assertFalse(self.legacy.exists())
    def test_symlink_escape_rejected(self):
        self.declare()
        with tempfile.TemporaryDirectory() as outside:
            (self.root/'工单').symlink_to(outside,target_is_directory=True)
            with self.assertRaises(BridgeError):artifact_state_path(self.root,'design','TEST-1')
    def test_prompt_uses_actual_absolute_entry_and_supported_cli(self):
        prompt=agent_entry_instructions()
        self.assertIn(str(Path(sys.modules['pilot'].__file__).resolve()),prompt)
        self.assertIn(' agent inspect',prompt);self.assertIn(' agent claim',prompt)
        self.assertIn('无管道、重定向、cd 串联',prompt)

if __name__=='__main__':unittest.main()
