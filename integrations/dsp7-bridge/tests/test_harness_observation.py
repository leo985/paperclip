import json
from pathlib import Path
import sys
import tempfile
import os
import subprocess
import unittest
from unittest.mock import patch
from types import SimpleNamespace

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from managed_sessions import Collector, QueueCapacity, register_local
from harness_observation import enqueue_summary
from harness_observation_runtime import prepare, poll, package_digest

RUN = '10000000-0000-4000-8000-000000000001'
COMPANY = '10000000-0000-4000-8000-000000000002'
TASK = '10000000-0000-4000-8000-000000000003'

def summary():
    return dict(schema='harness.v2.observation-summary/1', runId=RUN, companyId=COMPANY,
        taskId=TASK, streamId='stream-1', sourceDigest='a'*64, resourceDigest='b'*64,
        observedEvents=3, droppedEvents=0, observedSessionEnd=False, pendingObservedCalls=0,
        hostSessionConfirmed=False, processExitConfirmed=False, platformAccepted=False, durationMinutes=None)

class ObservationOutboxTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        folder = Path(self.tmp.name)
        self.cfg = {'database': str(folder/'pilot.db'), 'company_id': COMPANY}
        register_local(self.cfg, RUN, TASK, folder, folder/'state.json', folder, folder/'config.json')
        self.c = Collector(self.cfg, RUN)

    def tearDown(self):
        self.c.db.close()
        self.tmp.cleanup()

    def count(self):
        return self.c.db.execute('SELECT count(*) FROM outbox').fetchone()[0]

    def test_restart_dedup_and_increment(self):
        self.assertEqual(enqueue_summary(self.c, summary()), 'queued')
        self.c.db.close(); self.c = Collector(self.cfg, RUN)
        self.assertEqual(enqueue_summary(self.c, summary()), 'duplicate')
        self.assertEqual(enqueue_summary(self.c, dict(summary(), observedEvents=4)), 'queued')
        rows = self.c.db.execute('SELECT event FROM outbox ORDER BY sequence').fetchall()
        self.assertEqual([json.loads(r[0])['sequence'] for r in rows], [1, 2])
        self.assertEqual(json.loads(rows[0][0])['eventType'], 'harness.observation')

    def test_quota_failure_rolls_back_cursor_and_sequence(self):
        self.c.quota = 1
        with self.assertRaises(QueueCapacity): enqueue_summary(self.c, summary())
        self.assertEqual(self.count(), 0); self.assertEqual(self.c.queued_bytes, 0)
        self.assertIsNone(self.c.meta('harness-observation:stream-1'))
        self.c.quota = 100000
        self.assertEqual(enqueue_summary(self.c, summary()), 'queued')
        self.assertEqual(self.c.db.execute('SELECT sequence FROM outbox').fetchone()[0], 1)

    def test_cursor_failure_rolls_back_outbox(self):
        with patch.object(self.c, 'setmeta', side_effect=RuntimeError('disk')):
            with self.assertRaises(RuntimeError): enqueue_summary(self.c, summary())
        self.assertEqual(self.count(), 0)
        self.assertEqual(enqueue_summary(self.c, summary()), 'queued')

    def test_scope_secrets_authority_and_regressions_rejected(self):
        for bad in [dict(companyId=RUN), dict(prompt='secret'), dict(platformAccepted=True), dict(observedEvents=True)]:
            with self.assertRaises(ValueError): enqueue_summary(self.c, dict(summary(), **bad))
        self.assertEqual(self.count(), 0)
        enqueue_summary(self.c, summary())
        for bad in [dict(observedEvents=2), dict(sourceDigest='c'*64), dict(pendingObservedCalls=1)]:
            with self.assertRaises(ValueError): enqueue_summary(self.c, dict(summary(), **bad))
        self.assertEqual(self.count(), 1)

    def test_paused_collection_has_no_cursor_or_event(self):
        with self.c.db: self.c.db.execute('UPDATE sessions SET collection_paused=1')
        self.assertEqual(enqueue_summary(self.c, summary()), 'paused')
        self.assertEqual(self.count(), 0)

    def uploader(self, supported=True, lose_ack=False):
        self.c.cfg['agent_id'] = RUN
        with self.c.db: self.c.db.execute('UPDATE sessions SET server_id=?', (TASK,))
        self.c.status = lambda *args: None
        state = {'streams': {}, 'posts': [], 'lose_ack': lose_ack}
        def request(method, path, body):
            if path.endswith('/receipts'):
                return dict(streams=[dict(streamId=k, ackSequence=v) for k,v in state['streams'].items()],
                    collectionPaused=False, uploadPaused=False, capabilities=['harness.observation/1'] if supported else [])
            if path.endswith('/events'):
                state['posts'].append(body['events'])
                for event in body['events']: state['streams'][event['streamId']] = event['sequence']
                if state['lose_ack']:
                    state['lose_ack'] = False
                    raise TimeoutError('response lost after persistence')
                return dict(streams=[dict(streamId=k, ackSequence=v) for k,v in state['streams'].items()])
            raise AssertionError(path)
        modules = {'pilot': SimpleNamespace(Bridge=lambda path: None),
            'seats': SimpleNamespace(seat_api=lambda bridge: SimpleNamespace(request=request), identity=lambda bridge: {})}
        return state, patch.dict(sys.modules, modules)

    def test_old_server_holds_new_stream_but_uploads_legacy(self):
        enqueue_summary(self.c, summary())
        with self.c.db: self.c.event('collector', 'coverage', {'reason':'test','source':'test'})
        state, mocks = self.uploader(supported=False)
        with mocks: self.c.upload()
        self.assertEqual([e['eventType'] for batch in state['posts'] for e in batch], ['coverage'])
        pending=self.c.db.execute('SELECT event FROM outbox WHERE acked_at IS NULL').fetchall()
        self.assertEqual(len(pending),1)
        self.assertEqual(json.loads(pending[0][0])['eventType'],'harness.observation')

    def test_lost_ack_reconciles_without_duplicate_append(self):
        enqueue_summary(self.c, summary())
        state, mocks = self.uploader(lose_ack=True)
        with mocks:
            with self.assertRaises(TimeoutError): self.c.upload()
            self.assertEqual(self.c.db.execute('SELECT count(*) FROM outbox WHERE acked_at IS NULL').fetchone()[0],1)
            self.c.upload()
        self.assertEqual(len(state['posts']),1)
        self.assertEqual(self.c.db.execute('SELECT count(*) FROM outbox WHERE acked_at IS NULL').fetchone()[0],0)

    @unittest.skipUnless(os.environ.get('HARNESS_V2_ROOT'), 'Set HARNESS_V2_ROOT for cross-repository producer test')
    def test_actual_harness_query_output_enters_bridge_outbox(self):
        folder=(Path(self.tmp.name)/RUN).resolve();folder.mkdir()
        binding=dict(schema='harness.v2.binding/1',runId=RUN,companyId=COMPANY,taskId=TASK,
            seatAgentId='seat-1',machineId='machine-1',nativeSessionId='session-1',streamId='stream-1',
            sourceDigest='a'*64,resourceDigest='b'*64,runFolder=str(folder))
        snapshot=dict(schema='harness.v2.observation/1',binding=binding,sessionIdentitySource='launcher',
            hostSessionConfirmed=False,coverage='bounded-observation',dropped=0,lastSequence=1,
            processExitConfirmed=False,platformAccepted=False,events=[dict(sequence=1,kind='session.started',at=1)])
        (folder/'harness-v2-binding.json').write_text(json.dumps(binding))
        (folder/'harness-v2-observations.json').write_text(json.dumps(snapshot))
        script=Path(os.environ['HARNESS_V2_ROOT'])/'src/observation-query.mjs'
        result=subprocess.run(['node',str(script),str(folder/'harness-v2-binding.json'),'--transport'],check=True,capture_output=True,text=True)
        payload=json.loads(result.stdout)
        self.assertEqual(enqueue_summary(self.c,payload),'queued')
        self.assertNotIn('runFolder',payload);self.assertNotIn('uploadBlocker',payload)
        state,mocks=self.uploader()
        with mocks:self.c.upload()
        self.assertEqual(state['posts'][0][0]['payload'],payload)

    def configure_runtime(self):
        root=Path(os.environ['HARNESS_V2_ROOT']).resolve()
        self.cfg.update(agent_id='10000000-0000-4000-8000-000000000005',seat={'machine_id':'10000000-0000-4000-8000-000000000006'},
            harness_v2_observation=dict(enabled=True,packageRoot=str(root),packageDigest=package_digest(root),resourceDigest='b'*64))
        self.cfg['harness_v2_pilot']=dict(companyId=self.cfg['company_id'],seatId=self.cfg['agent_id'],taskIds=[TASK])

    def runtime_snapshot(self):
        state=self.c.meta('harness_observer_runtime');binding=state['binding']
        snapshot=dict(schema='harness.v2.observation/1',binding=binding,sessionIdentitySource='launcher',
            hostSessionConfirmed=False,coverage='bounded-observation',dropped=0,lastSequence=1,
            processExitConfirmed=False,platformAccepted=False,events=[dict(sequence=1,kind='session.started',at=1)])
        path=Path(binding['runFolder'])/'harness-v2-observations.json'
        path.write_text(json.dumps(snapshot));return path

    def test_runtime_disabled_does_not_change_args_or_queue(self):
        args=['--session-id',RUN]
        self.assertEqual(prepare(self.c,args),(args,{}));self.assertEqual(poll(self.c),'disabled')
        self.assertEqual(self.count(),0)

    @unittest.skipUnless(os.environ.get('HARNESS_V2_ROOT'), 'Cross-repository runtime test')
    def test_launcher_binding_poller_and_restart_use_actual_query(self):
        self.configure_runtime();original=['--session-id',RUN]
        args,env=prepare(self.c,original)
        self.assertEqual(original,['--session-id',RUN]);self.assertIn('--plugin-dir',args)
        self.assertEqual(args[args.index('--plugin-dir')+2],'--session-id')
        binding_path=Path(env['HARNESS_V2_OBSERVER_BINDING'])
        self.assertEqual(binding_path.stat().st_mode & 0o777,0o600)
        self.assertEqual(poll(self.c),'pending');self.runtime_snapshot()
        self.assertEqual(poll(self.c),'queued')
        self.c.db.close();self.c=Collector(self.cfg,RUN)
        self.assertEqual(poll(self.c),'duplicate');self.assertEqual(self.count(),1)
        with self.assertRaises(ValueError):prepare(self.c,original)

    @unittest.skipUnless(os.environ.get('HARNESS_V2_ROOT'), 'Cross-repository runtime test')
    def test_wrong_package_or_native_session_rejected_before_binding(self):
        self.configure_runtime()
        with self.assertRaises(ValueError):prepare(self.c,['--session-id',TASK])
        self.cfg['harness_v2_observation']['packageDigest']='0'*64
        with self.assertRaises(ValueError):prepare(self.c,['--session-id',RUN])
        self.assertIsNone(self.c.meta('harness_observer_runtime'));self.assertEqual(self.count(),0)

    @unittest.skipUnless(os.environ.get('HARNESS_V2_ROOT'), 'Cross-repository runtime test')
    def test_tampering_truncation_timeout_and_pause_never_advance_cursor(self):
        self.configure_runtime();_,env=prepare(self.c,['--session-id',RUN]);path=self.runtime_snapshot()
        path.write_text('{');self.assertEqual(poll(self.c),'unavailable')
        self.runtime_snapshot()
        with patch('harness_observation_runtime.subprocess.run',side_effect=subprocess.TimeoutExpired('node',5)):
            self.assertEqual(poll(self.c),'unavailable')
        self.assertEqual(self.count(),0)
        binding=Path(env['HARNESS_V2_OBSERVER_BINDING']);saved=binding.read_text()
        binding.write_text('{}');self.assertEqual(poll(self.c),'unavailable');binding.write_text(saved)
        with self.c.db:self.c.db.execute('UPDATE sessions SET collection_paused=1')
        self.assertEqual(poll(self.c),'paused')
        with self.c.db:self.c.db.execute('UPDATE sessions SET collection_paused=0')
        self.assertEqual(poll(self.c),'suspended');self.assertEqual(self.count(),0)

    @unittest.skipUnless(os.environ.get('HARNESS_V2_ROOT'), 'Cross-repository runtime test')
    def test_symlink_observer_folder_rejected(self):
        self.configure_runtime();target=Path(self.tmp.name)/'elsewhere';target.mkdir()
        (self.c.folder/'harness-observer').symlink_to(target,target_is_directory=True)
        with self.assertRaises(ValueError):prepare(self.c,['--session-id',RUN])
        self.assertEqual(list(target.iterdir()),[])

    @unittest.skipUnless(os.environ.get('HARNESS_V2_ROOT'), 'Cross-repository runtime test')
    def test_existing_collector_scan_polls_without_a_second_scheduler(self):
        self.configure_runtime();prepare(self.c,['--session-id',RUN]);self.runtime_snapshot()
        with patch.object(self.c,'sources',return_value=[]):self.c.scan()
        kinds=[json.loads(row[0])['eventType'] for row in self.c.db.execute('SELECT event FROM outbox')]
        self.assertIn('harness.observation',kinds)
        self.assertIn('observation',kinds)

if __name__ == '__main__': unittest.main()
