import copy
import datetime
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch
import uuid
sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
from harness_validation import validate,prepare,check_renewal
from harness_bundle_registry import descriptor
from managed_sessions import Collector
from pilot import BridgeError

@unittest.skipUnless(os.environ.get('HARNESS_V2_ROOT'),'HARNESS_V2_ROOT required')
class ValidationTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        if os.name=='nt':
            from platform_support import own_process_job
            own_process_job()
        cls.build=tempfile.TemporaryDirectory();cls.bundle=Path(cls.build.name).resolve()/'bundle'
        v2=Path(os.environ['HARNESS_V2_ROOT']).resolve()
        result=subprocess.run([sys.executable,str(v2/'packaging/packages.py'),'build','--repo',str(v2.parents[1]),'--output',str(cls.bundle),'--pilot-alias'],check=True,capture_output=True,text=True)
        cls.catalog=json.loads(result.stdout)
    @classmethod
    def tearDownClass(cls):cls.build.cleanup()
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory();self.root=Path(self.temp.name).resolve()
        company,seat,machine,task,run,dispatch=[str(uuid.uuid4()) for _ in range(6)]
        self.cfg=dict(database=str(self.root/'pilot.db'),company_id=company,agent_id=seat,seat=dict(machine_id=machine),
            harness_v2_pilot=dict(companyId=company,seatId=seat,taskIds=[task]),
            harness_v2_observation=dict(enabled=True,bundleRoot=str(self.bundle),bundleDigest=self.catalog['bundleDigest'],project='base-harness-infrastructure'))
        observer=dict(schema='harness.observer-binding/1',companyId=company,seatId=seat,machineId=machine,taskId=task,runId=run,projectId=None,registryRevision=1,bundle=descriptor(self.cfg['harness_v2_observation']),purpose='observation-only',executionReady=False,loadState='unconfirmed')
        validation={k:v for k,v in observer.items() if k not in ('purpose','executionReady','loadState')}
        validation.update(schema='harness.validation-binding/1',dispatchId=dispatch,expiresAt=(datetime.datetime.now(datetime.timezone.utc)+datetime.timedelta(minutes=10)).isoformat(),purpose='synthetic-history',fixtureVersion=1)
        self.packet=dict(companyId=company,agentId=seat,taskId=task,runId=run,harnessValidationDispatchId=dispatch,executionKind='validation',executionRoute=None,permit=dict(harnessObserver=observer,harnessValidation=validation),skills=[],mcp=[],prompt='This issue text must never be run')
        self.b=SimpleNamespace(cfg=self.cfg,config_path=self.root/'config.json')
        self.folder=self.root/run;self.folder.mkdir()
    def tearDown(self):self.temp.cleanup()
    def test_freezes_identity_and_rejects_unknown_fields_expiry_cross_run_and_legacy(self):
        self.assertEqual(validate(self.packet,self.cfg)['runId'],self.packet['runId'])
        for field,value in [('runId',str(uuid.uuid4())),('schema','wrong'),('fixtureVersion',True),('script','/tmp/anything.py'),('expiresAt','2020-01-01T00:00:00Z')]:
            with self.subTest(field=field):
                bad=copy.deepcopy(self.packet);bad['permit']['harnessValidation'][field]=value
                with self.assertRaises(BridgeError):validate(bad,self.cfg)
        for field,value in [('executionKind','development'),('skills',[{'script':'bad'}]),('mcp',[{}]),('executionRoute',{})]:
            with self.subTest(field=field):
                bad=copy.deepcopy(self.packet);bad[field]=value
                with self.assertRaises(BridgeError):validate(bad,self.cfg)
    def test_renewal_must_keep_original_validation_binding(self):
        expected=self.packet['permit']['harnessValidation'];check_renewal(expected,self.packet['permit'])
        for permit in [None,{},dict(harnessValidation={**expected,'runId':str(uuid.uuid4())})]:
            with self.assertRaises(BridgeError):check_renewal(expected,permit)
    def test_fixed_entry_creates_private_fixture_and_registered_collector_without_jira_or_model(self):
        with patch('seats.verify_runtime',return_value={'claudeCommand':'claude'}):ctx=prepare(self.b,self.packet,self.folder)
        try:
            state=ctx['state'];cmd=state['command'];prompt=cmd[-1]
            self.assertNotIn(self.packet['prompt'],prompt)
            self.assertEqual(cmd[cmd.index('--session-id')+1],self.packet['runId'])
            self.assertIn('--restricted',cmd);self.assertIn('--strict-mcp-config',cmd)
            self.assertNotIn('--dangerously-skip-permissions',cmd)
            self.assertEqual(state['cwd'],str(self.folder/'validation/workspace'))
            self.assertEqual(ctx['collector'].row()['task_id'],self.packet['taskId'])
            self.assertFalse((self.root/'state.json').exists())
            # Real Git fixture and pinned collector; not mocked model outputs.
            spec=importlib.util.spec_from_file_location('fixed_tool',self.bundle/'runtime/tools/history-probe-tool.py')
            tool=importlib.util.module_from_spec(spec);exec(compile((self.bundle/'runtime/tools/history-probe-tool.py').read_bytes(),str(self.bundle/'runtime/tools/history-probe-tool.py'),'exec'),tool.__dict__)
            config=self.folder/'validation/control/tool-config.json'
            self.assertEqual(tool.run(config,'count')['commitCount'],3)
            self.assertEqual(tool.run(config,'collect')['summary']['commits'],3)
            self.assertIn('return amount < 100',tool.run(config,'evidence')['currentCode'])
            with self.assertRaises(ValueError):tool.run(config,'arbitrary-shell')
            with self.assertRaises(ValueError):tool.run(config,'collect')
            with patch('seats.verify_runtime',return_value={'claudeCommand':'claude'}):
                with self.assertRaises(FileExistsError):prepare(self.b,self.packet,self.folder)
        finally:ctx['collector'].db.close()
    def test_missing_required_permit_never_creates_run_output(self):
        self.packet['permit'].pop('harnessValidation')
        with self.assertRaises(BridgeError):prepare(self.b,self.packet,self.folder)
        self.assertFalse((self.folder/'validation').exists())

class OutboundFaultTests(unittest.TestCase):
    """Real local process tree + native worker; transport responses are fixtures."""
    def test_cancel_expiry_and_network_loss_stop_the_exact_tree_and_leave_durable_proof(self):
        import outbound
        from pilot import read_json
        for failure in ('cancel','expiry','network'):
            with self.subTest(failure=failure), tempfile.TemporaryDirectory() as tmp:
                root=Path(tmp).resolve();run,task,company,seat,machine=[str(uuid.uuid4()) for _ in range(5)]
                folder=root/'outbound'/run;folder.mkdir(parents=True);probe=folder/'validation';probe.mkdir()
                for name in ('host.stdout','host.stderr'):(probe/name).touch()
                binding={'scope':'fixture'};observer={'observer':'fixture'}
                permit={'protocolVersion':1,'permitId':str(uuid.uuid4()),'validForMs':250 if failure=='expiry' else 60000,'mode':'observed_cost','harnessObserver':observer,'harnessValidation':binding}
                packet=dict(runId=run,taskId=task,agentId=seat,companyId=company,lease=str(uuid.uuid4()),authToken='fixture-not-a-secret',reason='fixture',executionKind='validation',permit=permit)
                cfg=dict(database=str(root/'pilot.db'),company_id=company,agent_id=seat,paperclip_url='https://example.invalid',seat=dict(machine_id=machine))
                b=SimpleNamespace(cfg=cfg,config_path=root/'config.json',root=root)
                context=dict(binding=binding,collector=SimpleNamespace(db=SimpleNamespace(close=lambda:None)),state=dict(command=[sys.executable,'-c','import time; '+('' if failure=='expiry' else 'print(123,flush=True); ')+'time.sleep(20)'],env=dict(os.environ),cwd=str(root),probe=probe))
                calls=[]
                def request(method,path,body,*args,**kwargs):
                    calls.append(body)
                    if len(calls)==1:return dict(alive=True,permit=permit)
                    if failure=='network':raise BridgeError('simulated transport loss')
                    if failure=='cancel':return dict(alive=False)
                    return dict(alive=True,permit=permit)
                api=SimpleNamespace(request=request)
                with patch('outbound.verify_runtime'),patch('seat_lifecycle.offline_requested',return_value=False),patch('harness_validation.prepare',return_value=context),patch('harness_validation.validate'),patch('harness_validation.observe'),patch('harness_observer_binding.validate_binding',return_value=observer),patch('outbound.seat_api',return_value=api),patch('outbound.identity',return_value={}),patch('outbound.collect_usage_checkpoint',return_value=(0,None)),patch('outbound.flush_exit_receipts'),patch('outbound.signal.signal'):
                    with self.assertRaises(BridgeError):outbound._run(b,packet,b.config_path)
                proof=read_json(folder/'exit-receipt.json')['treeProof']
                self.assertEqual(proof['runId'],run);self.assertEqual(proof['remaining'],0)
                self.assertEqual(proof['isolation'],'posix-sessions')
                self.assertGreaterEqual(proof['observations'],2)
                self.assertFalse((folder/'tree-stop-pending.json').exists())


class ParentCrashTest(unittest.TestCase):
    def test_real_supervisor_sigkill_cannot_leave_validation_descendant_running(self):
        import signal,time
        from process_tree import posix_members
        worker=Path(__file__).resolve().parents[1]/'harness_validation_process.py'
        with tempfile.TemporaryDirectory() as tmp:
            run=str(uuid.uuid4());folder=Path(tmp).resolve()/run;folder.mkdir()
            anchor=folder/'process-tree-anchor.json'
            pidfile=folder/'pid'
            childcode='import os,time; from pathlib import Path; Path('+repr(str(pidfile))+').write_text(str(os.getpid())); time.sleep(20)'
            parentcode='import os,subprocess,sys,time; subprocess.Popen([sys.executable,'+repr(str(worker))+',str(os.getpid()),'+repr(run)+','+repr(str(anchor))+',sys.executable,"-c",'+repr(childcode)+'],start_new_session=True); time.sleep(20)'
            parent=subprocess.Popen([sys.executable,'-c',parentcode],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,start_new_session=True)
            sid=None
            try:
                deadline=time.monotonic()+5
                while not pidfile.exists() and time.monotonic()<deadline:time.sleep(.05)
                self.assertTrue(pidfile.exists());pid=int(pidfile.read_text());sid=os.getsid(pid)
                parent.kill();parent.wait(timeout=3)
                deadline=time.monotonic()+4
                while posix_members({sid}) and time.monotonic()<deadline:time.sleep(.05)
                self.assertEqual(posix_members({sid}),[])
                from pilot import atomic_json,read_json
                from harness_validation import recover_orphans
                company,seat,machine,lease=[str(uuid.uuid4()) for _ in range(4)]
                cfg=dict(database=str(Path(tmp)/'pilot.db'),company_id=company,agent_id=seat,seat=dict(machine_id=machine))
                destination=Path(tmp)/'outbound'/run;destination.mkdir(parents=True)
                (destination/'process-tree-anchor.json').write_bytes(anchor.read_bytes())
                journal=destination/'validation-recovery.json'
                atomic_json(journal,dict(runId=run,companyId=company,seatId=seat,machineId=machine,lease=lease,supervisorPid=parent.pid,receiptQueued=False))
                recover_orphans(SimpleNamespace(cfg=cfg))
                receipt=read_json(destination/'exit-receipt.json')
                self.assertEqual(receipt['treeProof']['runId'],run)
                self.assertEqual(receipt['treeProof']['isolation'],'posix-sessions')
                self.assertTrue(read_json(journal)['receiptQueued'])
                before=(destination/'exit-receipt.json').read_bytes()
                recover_orphans(SimpleNamespace(cfg=cfg))
                self.assertEqual((destination/'exit-receipt.json').read_bytes(),before)

            finally:
                if parent.poll() is None:parent.kill();parent.wait()
                if sid:
                    try:os.killpg(sid,signal.SIGKILL)
                    except ProcessLookupError:pass


class ModelConnectionTests(unittest.TestCase):
    def test_only_local_model_connection_keys_cross_restricted_boundary(self):
        from harness_validation import model_environment
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp);(root/'.claude').mkdir();(root/'.claude/settings.json').write_text(json.dumps({'env':{'ANTHROPIC_BASE_URL':'https://fixture.invalid','ANTHROPIC_MODEL':'default','PAPERCLIP_API_KEY':'must-not-copy','UNSAFE':'must-not-copy'},'hooks':{'must-not-copy':True}}))
            explicit=root/'explicit.json';explicit.write_text(json.dumps({'env':{'ANTHROPIC_MODEL':'explicit','ANTHROPIC_API_KEY':'fixture-only'}}))
            with patch('harness_validation.Path.home',return_value=root):
                value=model_environment({'ANTHROPIC_MODEL':'inherited'},dict(claudeSettingsFile=str(explicit)))
            self.assertEqual(value,{'ANTHROPIC_MODEL':'inherited','ANTHROPIC_BASE_URL':'https://fixture.invalid','ANTHROPIC_API_KEY':'fixture-only'})


class RecoveryFenceTests(unittest.TestCase):
    def test_missing_anchor_wrong_scope_and_live_supervisor_never_release_capacity(self):
        from harness_validation import recover_orphans
        from pilot import atomic_json
        for failure in ('missing-anchor', 'wrong-scope', 'live-supervisor', 'live-members', 'inspection-failed'):
            with self.subTest(failure=failure), tempfile.TemporaryDirectory() as tmp:
                root=Path(tmp).resolve();run,company,seat,machine,lease=[str(uuid.uuid4()) for _ in range(5)]
                folder=root/'outbound'/run;folder.mkdir(parents=True)
                cfg=dict(database=str(root/'pilot.db'),company_id=company,agent_id=seat,seat=dict(machine_id=machine))
                atomic_json(folder/'validation-recovery.json',dict(runId=run,companyId=company if failure!='wrong-scope' else str(uuid.uuid4()),seatId=seat,machineId=machine,lease=lease,supervisorPid=12345,receiptQueued=False))
                if failure!='missing-anchor':atomic_json(folder/'process-tree-anchor.json',dict(runId=run,supervisorPid=12345,sessionId=23456))
                with patch('platform_support.process_alive',return_value=failure=='live-supervisor'),patch('process_tree.posix_members',return_value=[{'pid':23456}] if failure=='live-members' else [],side_effect=subprocess.TimeoutExpired('ps',5) if failure=='inspection-failed' else None):
                    recover_orphans(SimpleNamespace(cfg=cfg))
                self.assertFalse((folder/'exit-receipt.json').exists())

if __name__=='__main__':unittest.main()
