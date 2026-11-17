import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch
from types import SimpleNamespace

sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
from managed_sessions import Collector,register_local
from harness_bundle import validate, read
from harness_observation_runtime import prepare,poll,poll_native

RUN='10000000-0000-4000-8000-000000000001'
TASK='10000000-0000-4000-8000-000000000003'

class BundlePathTests(unittest.TestCase):
    def test_drive_and_stream_names_rejected_before_filesystem_read(self):
        for name in ('C:/Windows/win.ini', 'C:relative', 'nested/file:stream', 'a\\b'):
            with self.subTest(name=name), self.assertRaisesRegex(ValueError, 'Unsafe bundle path'):
                read(Path(tempfile.gettempdir()).resolve(), name)

@unittest.skipUnless(os.environ.get('HARNESS_V2_ROOT'),'Set HARNESS_V2_ROOT for bundle integration')
class BundleLaunchTests(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory();self.root=Path(self.tmp.name).resolve()
        harness=Path(os.environ['HARNESS_V2_ROOT']).resolve()
        self.bundle=self.root/'bundle';self.cwd=self.root/'project';self.cwd.mkdir()
        result=subprocess.run([sys.executable,str(harness/'packaging/packages.py'),'build','--repo',str(harness.parents[1]),'--output',str(self.bundle)],check=True,capture_output=True,text=True)
        self.catalog=json.loads(result.stdout)
        self.config=dict(enabled=True,bundleRoot=str(self.bundle),bundleDigest=self.catalog['bundleDigest'],project='base-harness-infrastructure')
        cfg=dict(database=str(self.root/'pilot.db'),company_id='10000000-0000-4000-8000-000000000002',
            agent_id='10000000-0000-4000-8000-000000000005',seat={'machine_id':'10000000-0000-4000-8000-000000000006'},harness_v2_observation=self.config)
        cfg['harness_v2_pilot']=dict(companyId=cfg['company_id'],seatId=cfg['agent_id'],taskIds=[TASK])
        register_local(cfg,RUN,TASK,self.cwd,self.cwd/'state.json',self.root,self.root/'config.json')
        self.c=Collector(cfg,RUN)

    def tearDown(self):self.c.db.close();self.tmp.cleanup()

    def platform_attachment(self):
        from harness_bundle_registry import descriptor
        return dict(schema='harness.observer-binding/1',companyId=self.c.cfg['company_id'],
            seatId=self.c.cfg['agent_id'],machineId=self.c.cfg['seat']['machine_id'],taskId=TASK,runId=RUN,
            projectId=None,registryRevision=1,bundle=descriptor(self.config),
            purpose='observation-only',executionReady=False,loadState='unconfirmed')

    def test_required_platform_attachment_prepares_and_is_saved_without_claiming_execution(self):
        attachment=self.platform_attachment()
        args,env=prepare(self.c,['--session-id',RUN],platform_attachment=attachment)
        self.assertIn('--plugin-dir',args)
        self.assertEqual(self.c.meta('harness_observer_runtime')['platformAttachment'],attachment)
        self.assertNotIn('DSP7_HARNESS_OBSERVER_ATTACHMENT',env)

    def test_required_platform_attachment_refuses_scope_schema_version_or_disabled_local_config(self):
        attachment=self.platform_attachment()
        for field,value in [('runId',TASK),('taskId',RUN),('seatId',RUN),('machineId',RUN),
                ('companyId',RUN),('schema','wrong'),('executionReady',True),('registryRevision',True),
                ('loadState','confirmed'),('projectId','not-an-id')]:
            with self.subTest(field=field):
                bad=dict(attachment,**{field:value})
                with self.assertRaises(Exception):prepare(self.c,['--session-id',RUN],platform_attachment=bad)
        for change in [('bundleDigest','0'*64),('project','another-project')]:
            bad=json.loads(json.dumps(attachment));bad['bundle'][change[0]]=change[1]
            with self.assertRaises(Exception):prepare(self.c,['--session-id',RUN],platform_attachment=bad)
        self.config['enabled']=False
        with self.assertRaises(Exception):prepare(self.c,['--session-id',RUN],platform_attachment=attachment)
        self.assertIsNone(self.c.meta('harness_observer_runtime'))
        self.assertFalse((self.c.folder/'harness-observer').exists())

    def test_required_platform_attachment_refuses_pilot_task_miss_and_tampered_files(self):
        attachment=self.platform_attachment()
        self.c.cfg['harness_v2_pilot']['taskIds']=[RUN]
        with self.assertRaises(Exception):prepare(self.c,['--session-id',RUN],platform_attachment=attachment)
        self.c.cfg['harness_v2_pilot']['taskIds']=[TASK]
        path=Path(validate(self.config)['runtimeRoot'])/'src/native-state-query.py'
        path.write_text(path.read_text(encoding='utf8')+'\n# tampered\n', encoding='utf8')
        with self.assertRaises(Exception):prepare(self.c,['--session-id',RUN],platform_attachment=attachment)
        self.assertIsNone(self.c.meta('harness_observer_runtime'))

    def test_runtime_context_freezes_actual_roots_without_reading_personal_configuration(self):
        # The registered config need not exist: the context records its parent,
        # never reads it, and never substitutes plugin cache as configuration.
        args,env=prepare(self.c,['--session-id',RUN])
        state=self.c.meta('harness_observer_runtime');value=state['runtimeContext']
        self.assertEqual(value['roots']['project_root'],str(self.cwd))
        self.assertEqual(value['roots']['state_root'],str(self.cwd))
        self.assertEqual(value['roots']['user_config_root'],str(self.root))
        self.assertEqual(value['source_root'],str(self.cwd))
        self.assertEqual(value['identity']['runId'],RUN)
        self.assertEqual(json.loads(Path(env['HARNESS_CONTEXT_FILE']).read_text()),value)
        self.assertEqual(env['HARNESS_CONTEXT_DIGEST'],state['runtimeContextDigest'])
        if os.name != 'nt':
            self.assertEqual(Path(env['HARNESS_CONTEXT_FILE']).stat().st_mode & 0o777,0o600)
        self.assertFalse((self.root/'config.json').exists())

    def test_runtime_context_tampering_prevents_both_native_and_mod_projection(self):
        self.native_state();prepare(self.c,['--session-id',RUN],domain_context=self.native_context());self.snapshot()
        state=self.c.meta('harness_observer_runtime')
        path=Path(state['runtimeContextPath']);value=json.loads(path.read_text());value['identity']['taskId']=RUN
        path.write_text(json.dumps(value))
        self.assertEqual(poll_native(self.c),'unavailable')
        self.assertEqual(poll(self.c),'unavailable')
        self.assertEqual(self.native_events(),[])
        self.assertIsNone(self.c.meta('harness-native-state'))

    def test_runtime_context_worktree_or_personal_root_drift_refuses_new_projection(self):
        self.native_state();prepare(self.c,['--session-id',RUN],domain_context=self.native_context());self.snapshot()
        source=self.root/'other worktree';source.mkdir();self.c.info['source_cwd']=str(source)
        self.assertEqual(poll_native(self.c),'unavailable');self.assertEqual(poll(self.c),'unavailable')
        self.c.info['source_cwd']=str(self.cwd);self.c.info['config_path']=str(source/'config.json')
        self.assertEqual(poll_native(self.c),'unavailable');self.assertEqual(poll(self.c),'unavailable')
        self.assertEqual(self.native_events(),[])

    def test_runtime_context_missing_root_fails_before_creating_any_binding(self):
        self.c.info['config_path']=str(self.root/'missing personal root'/'config.json')
        with self.assertRaises(subprocess.CalledProcessError):prepare(self.c,['--session-id',RUN])
        self.assertFalse((self.c.folder/'harness-observer').exists())
        self.assertIsNone(self.c.meta('harness_observer_runtime'))

    def snapshot(self):
        binding=self.c.meta('harness_observer_runtime')['binding']
        path=Path(binding['runFolder'])/'harness-v2-observations.json'
        path.write_text(json.dumps(dict(schema='harness.v2.observation/1',binding=binding,
            sessionIdentitySource='launcher',hostSessionConfirmed=False,coverage='bounded-observation',dropped=0,lastSequence=1,
            processExitConfirmed=False,platformAccepted=False,events=[dict(sequence=1,kind='session.started',at=1)])))

    def native_context(self):
        cfg=self.c.cfg
        return dict(runId=RUN,stage=dict(taskId=TASK,jiraKey='TEST-123',parentKey='TEST-100'),
            executionRoute=dict(runId=RUN,companyId=cfg['company_id'],taskId=TASK,
                agentId=cfg['agent_id'],machineId=cfg['seat']['machine_id']),
            root=str(self.cwd),statePath=str(self.cwd/'state.json'),workflow='feature')

    def native_state(self,phase='P3',status='in-progress',**extra):
        path=self.cwd/'state.json'
        path.write_text(json.dumps(dict(工单号='TEST-123',父工单号='TEST-100',类型='feature',技能='jira-feature-dev',
            当前Phase=phase,状态=status,描述='private text',**extra)))
        return path

    def native_events(self):
        return [json.loads(r[0]) for r in self.c.db.execute(
            "SELECT event FROM outbox WHERE stream_id='harness-native' ORDER BY sequence")]

    def test_native_projection_uses_actual_pinned_reader_and_outbox_without_state_write(self):
        path=self.native_state();before=path.read_bytes()
        prepare(self.c,['--session-id',RUN],domain_context=self.native_context())
        self.assertEqual(poll_native(self.c),'queued')
        events=self.native_events();self.assertEqual(len(events),1)
        self.assertEqual(events[0]['eventType'],'phase')
        self.assertEqual(events[0]['payload']['status'],'observed')
        self.assertEqual(events[0]['payload']['evidence'],
            'sha256:'+__import__('hashlib').sha256(before).hexdigest())
        self.assertNotIn('private text',json.dumps(events));self.assertNotIn(str(self.cwd),json.dumps(events))
        self.assertEqual(path.read_bytes(),before)
        self.c.db.close();self.c=Collector(self.c.cfg,RUN)
        self.assertEqual(poll_native(self.c),'duplicate')
        self.native_state(status='completed')
        self.assertEqual(poll_native(self.c),'queued')
        self.assertEqual([e['sequence'] for e in self.native_events()],[1,2])
        self.assertEqual(self.native_events()[-1]['payload']['status'],'observed')

    def test_native_mismatched_launch_context_cannot_create_binding(self):
        original=self.native_context()
        for field in ('runId','companyId','taskId','agentId','machineId'):
            bad=json.loads(json.dumps(original));bad['executionRoute'][field]=RUN if original['executionRoute'][field]!=RUN else TASK
            with self.assertRaises(ValueError):prepare(self.c,['--session-id',RUN],domain_context=bad)
            self.assertIsNone(self.c.meta('harness_observer_runtime'))
            self.assertFalse((self.c.folder/'harness-observer').exists())
        bad=dict(original,statePath=str(self.root/'state.json'))
        with self.assertRaises(ValueError):prepare(self.c,['--session-id',RUN],domain_context=bad)

    def test_native_invalid_or_foreign_state_has_no_outbox_or_cursor(self):
        prepare(self.c,['--session-id',RUN],domain_context=self.native_context())
        self.assertEqual(poll_native(self.c),'unavailable')
        path=self.native_state();value=json.loads(path.read_text());value['工单号']='TEST-999';path.write_text(json.dumps(value))
        self.assertEqual(poll_native(self.c),'unavailable')
        self.assertEqual(self.native_events(),[]);self.assertIsNone(self.c.meta('harness-native-state'))
        self.native_state(phase='P1D');self.assertEqual(poll_native(self.c),'queued')

    def test_native_cursor_and_event_rollback_together_after_capacity_or_disk_failure(self):
        self.native_state();prepare(self.c,['--session-id',RUN],domain_context=self.native_context())
        self.c.quota=1;self.assertEqual(poll_native(self.c),'unavailable')
        self.assertEqual(self.native_events(),[]);self.assertIsNone(self.c.meta('harness-native-state'))
        self.c.quota=1000000
        real=self.c.setmeta
        def fail(key,value):
            if key=='harness-native-state':raise RuntimeError('disk')
            real(key,value)
        with patch.object(self.c,'setmeta',side_effect=fail):
            self.assertEqual(poll_native(self.c),'unavailable')
        self.assertEqual(self.native_events(),[]);self.assertIsNone(self.c.meta('harness-native-state'))
        self.assertEqual(poll_native(self.c),'queued');self.assertEqual(self.native_events()[0]['sequence'],1)

    def test_native_paused_interval_is_not_backfilled_and_finalized_is_ignored(self):
        self.native_state();prepare(self.c,['--session-id',RUN],domain_context=self.native_context())
        with self.c.db:self.c.db.execute('UPDATE sessions SET collection_paused=1')
        self.assertEqual(poll_native(self.c),'suspended')
        with self.c.db:self.c.db.execute('UPDATE sessions SET collection_paused=0')
        self.assertEqual(poll_native(self.c),'suspended');self.assertEqual(self.native_events(),[])
        with self.c.db:self.c.db.execute('UPDATE sessions SET finalized=1')
        self.assertEqual(poll_native(self.c),'finalized')

    def test_native_tampered_runtime_rejected_without_executing_it(self):
        self.native_state();prepare(self.c,['--session-id',RUN],domain_context=self.native_context())
        (self.bundle/'runtime/src/native-state-query.py').write_text('raise Exception("must not run")')
        with patch('harness_bundle.subprocess.run') as execution:
            self.assertEqual(poll_native(self.c),'unavailable');execution.assert_not_called()
        self.assertEqual(self.native_events(),[])

    def test_native_late_snapshot_cannot_be_attributed_after_current_scope_changes(self):
        self.native_state();prepare(self.c,['--session-id',RUN],domain_context=self.native_context())
        original=self.c.cfg['company_id'];self.c.cfg['company_id']=TASK
        self.assertEqual(poll_native(self.c),'unavailable');self.assertEqual(self.native_events(),[])
        self.c.cfg['company_id']=original
        with self.c.db:self.c.db.execute('UPDATE sessions SET task_id=?',(RUN,))
        self.assertEqual(poll_native(self.c),'unavailable');self.assertIsNone(self.c.meta('harness-native-state'))

    def test_collector_scan_has_one_native_phase_writer_and_frozen_context(self):
        self.native_state();context=self.native_context()
        prepare(self.c,['--session-id',RUN],domain_context=context);self.snapshot()
        context['stage']['jiraKey']='TEST-999'
        with patch.object(self.c,'sources',return_value=[]):self.c.scan()
        events=[json.loads(r[0]) for r in self.c.db.execute('SELECT event FROM outbox')]
        self.assertEqual(len([e for e in events if e['eventType']=='phase']),1)
        self.assertEqual(self.c.meta('harness_observer_runtime')['nativeDomain']['ticket'],'TEST-123')

    def test_native_concurrent_collectors_share_transactional_dedup(self):
        from concurrent.futures import ThreadPoolExecutor
        self.native_state();prepare(self.c,['--session-id',RUN],domain_context=self.native_context())
        cfg=dict(self.c.cfg)
        def scan(_):
            collector=Collector(cfg,RUN)
            try:return poll_native(collector)
            finally:collector.db.close()
        with ThreadPoolExecutor(max_workers=2) as pool:results=list(pool.map(scan,range(2)))
        self.assertEqual(sorted(results),['duplicate','queued']);self.assertEqual(len(self.native_events()),1)

    def test_native_phase_uses_existing_upload_and_recovers_lost_ack(self):
        self.native_state(status='completed');prepare(self.c,['--session-id',RUN],domain_context=self.native_context())
        self.assertEqual(poll_native(self.c),'queued')
        with self.c.db:self.c.db.execute('UPDATE sessions SET server_id=?',(TASK,))
        self.c.status=lambda *args:None
        remote={'streams':{},'events':[]}
        def request(method,path,body):
            if path.endswith('/receipts'):
                return dict(streams=[dict(streamId=k,ackSequence=v) for k,v in remote['streams'].items()],
                    collectionPaused=False,uploadPaused=False,capabilities=[])
            if path.endswith('/events'):
                remote['events'].extend(body['events'])
                for event in body['events']:remote['streams'][event['streamId']]=event['sequence']
                raise TimeoutError('persisted, ACK lost')
            raise AssertionError(path)
        modules={'pilot':SimpleNamespace(Bridge=lambda path:None),
            'seats':SimpleNamespace(seat_api=lambda bridge:SimpleNamespace(request=request),identity=lambda bridge:{})}
        with patch.dict(sys.modules,modules):
            with self.assertRaises(TimeoutError):self.c.upload()
            self.assertEqual(self.c.db.execute('SELECT count(*) FROM outbox WHERE acked_at IS NULL').fetchone()[0],1)
            self.c.upload()
        self.assertEqual(len(remote['events']),1)
        self.assertEqual(remote['events'][0]['payload']['status'],'observed')
        self.assertEqual(self.c.db.execute('SELECT count(*) FROM outbox WHERE acked_at IS NULL').fetchone()[0],0)

    def test_nonpilot_task_does_not_load_plugins_or_write_binding(self):
        self.c.cfg['harness_v2_pilot']['taskIds']=[RUN]
        args=['--session-id',RUN]
        self.assertEqual(prepare(self.c,args),(args,{}))
        self.assertIsNone(self.c.meta('harness_observer_runtime'))
        self.assertFalse((self.c.folder/'harness-observer').exists())

    def test_foreign_company_or_seat_does_not_load_candidate(self):
        original=dict(self.c.cfg['harness_v2_pilot'])
        for key in ('companyId','seatId'):
            self.c.cfg['harness_v2_pilot']={**original,key:RUN}
            self.assertEqual(prepare(self.c,['--session-id',RUN]),(['--session-id',RUN],{}))
            self.assertIsNone(self.c.meta('harness_observer_runtime'))

    def test_malformed_pilot_scope_rejects_candidate(self):
        original=dict(self.c.cfg['harness_v2_pilot'])
        for tasks in ([],['*'],[TASK]*17,'all'):
            self.c.cfg['harness_v2_pilot']={**original,'taskIds':tasks}
            with self.assertRaises(ValueError):prepare(self.c,['--session-id',RUN])
            self.assertIsNone(self.c.meta('harness_observer_runtime'))

    def test_missing_pilot_scope_rejects_candidate(self):
        del self.c.cfg['harness_v2_pilot']
        with self.assertRaisesRegex(ValueError,'pilot scope'):prepare(self.c,['--session-id',RUN])
        self.assertIsNone(self.c.meta('harness_observer_runtime'))

    def test_locked_bundle_wires_both_plugins_and_polls_actual_runtime(self):
        args,env=prepare(self.c,['--session-id',RUN])
        self.assertEqual(args,['--plugin-dir',str(self.bundle/'runtime'),'--plugin-dir',str(self.bundle/'resources'),'--session-id',RUN])
        self.assertEqual(env['HARNESS_RUNTIME_ROOT'],str(self.bundle/'runtime'))
        self.assertEqual(env['HARNESS_RESOURCE_ROOT'],str(self.bundle/'resources'))
        self.assertEqual(env['HARNESS_BUNDLE_DIGEST'],self.catalog['bundleDigest'])
        checked=validate(self.config)
        binding=self.c.meta('harness_observer_runtime')['binding']
        self.assertEqual(binding['resourceDigest'],checked['resourceDigest'])
        self.snapshot();self.assertEqual(poll(self.c),'queued');self.assertEqual(poll(self.c),'duplicate')
        event=json.loads(self.c.db.execute('SELECT event FROM outbox').fetchone()[0])
        self.assertEqual(event['payload']['resourceDigest'],checked['resourceDigest'])

    def test_tampered_verifier_never_executes(self):
        tool=self.bundle/'runtime/tools/packages.py';tool.write_text('raise Exception("must never run")')
        with patch('harness_bundle.subprocess.run') as execution:
            with self.assertRaises(ValueError):validate(self.config)
            execution.assert_not_called()
        self.assertIsNone(self.c.meta('harness_observer_runtime'))

    def test_changed_lock_foreign_scope_and_additional_plugin_reject(self):
        with self.assertRaises(ValueError):validate(dict(self.config,bundleDigest='0'*64))
        with self.assertRaises(subprocess.CalledProcessError):validate(dict(self.config,project='foreign-project'))
        with self.assertRaises(ValueError):prepare(self.c,['--plugin-dir','/another','--session-id',RUN])
        self.assertIsNone(self.c.meta('harness_observer_runtime'))

    def test_ancestor_legacy_entry_rejects_without_touching_it(self):
        old=self.root/'.claude/skills/git-history-analyzer/SKILL.md';old.parent.mkdir(parents=True);old.write_text('original')
        with self.assertRaisesRegex(ValueError,'conflicts'):prepare(self.c,['--session-id',RUN])
        self.assertEqual(old.read_text(),'original');self.assertIsNone(self.c.meta('harness_observer_runtime'))

    def test_explicit_pilot_entry_loads_from_original_harness_root(self):
        harness=Path(os.environ['HARNESS_V2_ROOT']).resolve()
        repo=harness.parents[1]
        target=self.root/'pilot-alias'
        result=subprocess.run([sys.executable,str(harness/'packaging/packages.py'),'build',
            '--repo',str(repo),'--output',str(target),'--pilot-alias'],check=True,capture_output=True,text=True)
        catalog=json.loads(result.stdout)
        self.c.cfg['harness_v2_observation']=dict(enabled=True,bundleRoot=str(target),
            bundleDigest=catalog['bundleDigest'],project='base-harness-infrastructure')
        self.c.info['cwd']=str(repo);self.c.info['source_cwd']=str(repo)
        original=(repo/'.claude/skills/git-history-analyzer/SKILL.md').read_bytes()
        args,env=prepare(self.c,['--session-id',RUN])
        self.assertEqual(self.c.info['cwd'],str(repo))
        self.assertEqual(args,['--plugin-dir',str(target/'runtime'),'--plugin-dir',str(target/'resources'),'--session-id',RUN])
        self.assertEqual(env['HARNESS_BUNDLE_DIGEST'],catalog['bundleDigest'])
        self.assertEqual(original,(repo/'.claude/skills/git-history-analyzer/SKILL.md').read_bytes())
        validate(self.c.cfg['harness_v2_observation'],(str(repo),))

    def test_changed_resource_after_start_is_not_collected(self):
        prepare(self.c,['--session-id',RUN]);self.snapshot()
        resource=self.bundle/'resources/skills/git-history-analyzer/templates/analysis-state.json'
        resource.write_text('{}')
        self.assertEqual(poll(self.c),'unavailable')
        self.assertEqual(self.c.db.execute('SELECT count(*) FROM outbox').fetchone()[0],0)

    def test_symlink_root_is_rejected(self):
        alias=self.root/'alias'
        try:alias.symlink_to(self.bundle,target_is_directory=True)
        except OSError as error:
            if os.name != 'nt' or getattr(error, 'winerror', None) != 1314:raise
            # Normal Windows users can create directory junctions without the
            # symlink privilege. They must hit the same canonical-path refusal.
            subprocess.run(['cmd.exe','/c','mklink','/J',str(alias),str(self.bundle)],check=True,capture_output=True)
        with self.assertRaises(ValueError):validate(dict(self.config,bundleRoot=str(alias)))

    def test_running_scope_retains_frozen_bundle_after_config_change(self):
        prepare(self.c,['--session-id',RUN]);self.snapshot()
        self.config['bundleDigest']='0'*64
        self.assertEqual(poll(self.c),'queued')
        self.assertEqual(self.c.meta('harness_observer_runtime')['bundleConfig']['bundleDigest'],self.catalog['bundleDigest'])

    def test_registration_exports_only_descriptor_and_negotiates_support(self):
        from harness_bundle_registry import register
        calls=[];supported=False
        def request(method,path,body=None):
            calls.append((method,path,body))
            return dict(registrationSupported=supported,revision=3) if method=='GET' else {'revision':4}
        seats=SimpleNamespace(seat_api=lambda b:SimpleNamespace(request=request),identity=lambda b:{'seat_id':b.cfg['agent_id']})
        bridge=SimpleNamespace(cfg=self.c.cfg)
        before=json.dumps(bridge.cfg,sort_keys=True)
        with patch.dict(sys.modules,{'seats':seats}):
            self.assertEqual(register(bridge)['reason'],'BUNDLE_REGISTRATION_UNSUPPORTED')
            self.assertEqual(len(calls),1)
            supported=True;self.assertEqual(register(bridge),{'revision':4})
        post=calls[-1][2];self.assertEqual(post['expectedRevision'],3)
        self.assertEqual(post['bundle']['mode'],'candidate')
        self.assertNotIn(str(self.root),json.dumps(post))
        self.assertNotIn('root',post['bundle']);self.assertEqual(json.dumps(bridge.cfg,sort_keys=True),before)

    def test_registration_cas_failure_never_retries_or_mutates_configuration(self):
        from harness_bundle_registry import register
        calls=[]
        def request(method,path,body=None):
            calls.append(method)
            if method=='POST':raise RuntimeError('409 revision conflict')
            return dict(registrationSupported=True,revision=0)
        seats=SimpleNamespace(seat_api=lambda b:SimpleNamespace(request=request),identity=lambda b:{})
        before=json.dumps(self.c.cfg,sort_keys=True)
        with patch.dict(sys.modules,{'seats':seats}):
            with self.assertRaisesRegex(RuntimeError,'409'):register(SimpleNamespace(cfg=self.c.cfg))
        self.assertEqual(calls,['GET','POST']);self.assertEqual(json.dumps(self.c.cfg,sort_keys=True),before)

if __name__=='__main__':unittest.main()
