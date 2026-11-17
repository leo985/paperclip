"""Native Windows Job evidence survives worker death while its watcher lives."""
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import time
import unittest
import uuid
from types import SimpleNamespace
from unittest.mock import patch
sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
import windows_validation_supervisor as supervisor
from platform_support import process_alive

@unittest.skipUnless(os.name=='nt','Native Windows Job handles required')
class WindowsValidationSupervisorTests(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory();self.root=Path(self.tmp.name).resolve()
        self.cfg=dict(database=str(self.root/'bridge.sqlite'),company_id=str(uuid.uuid4()),agent_id=str(uuid.uuid4()),seat=dict(machine_id=str(uuid.uuid4())))
        self.config=self.root/'config.json';self.config.write_text('{}')
        self.b=SimpleNamespace(config_path=self.config,cfg=self.cfg);self.children=[]
    def tearDown(self):
        for state in list(supervisor._ACTIVE.values()):state['job'].close()
        supervisor._ACTIVE.clear()
        for child in self.children:
            if child.poll() is None:child.kill()
            child.wait(timeout=8)
        self.tmp.cleanup()
    def launch(self,release=True):
        run=str(uuid.uuid4());folder=self.root/'outbound'/run;folder.mkdir(parents=True)
        packet=dict(runId=run,lease=str(uuid.uuid4()),companyId=self.cfg['company_id'],agentId=self.cfg['agent_id'],executionKind='validation')
        bridge=str(Path(__file__).resolve().parents[1])
        model=folder/'model.py';model.write_text('import os,subprocess,sys,json,time\nfrom pathlib import Path\np=subprocess.Popen([sys.executable,"-c","import time;time.sleep(45)"],close_fds=True)\nPath('+repr(str(folder/'model-pids.json'))+').write_text(json.dumps([os.getpid(),p.pid]))\ntime.sleep(45)\n',encoding='utf8')
        code='''import json,os,subprocess,sys,time
from pathlib import Path
packet=json.loads(sys.stdin.buffer.read())
sys.path.insert(0,BRIDGE)
from platform_support import own_process_job
from pilot import atomic_json
own_process_job()
folder=Path(FOLDER)
atomic_json(folder/'validation-recovery.json',dict(runId=packet['runId'],lease=packet['lease'],companyId=packet['companyId'],seatId=packet['agentId'],machineId=MACHINE,supervisorPid=os.getpid(),receiptQueued=False))
p=subprocess.Popen([sys.executable,str(folder/'model.py')],close_fds=True)
time.sleep(45)
'''.replace('BRIDGE',repr(bridge)).replace('FOLDER',repr(str(folder))).replace('MACHINE',repr(self.cfg['seat']['machine_id']))
        worker=subprocess.Popen([sys.executable,'-c',code],stdin=subprocess.PIPE,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,close_fds=True)
        self.children.append(worker)
        if release:supervisor.release(worker,self.config,self.cfg,packet,folder)
        return worker,packet,folder
    def wait_model(self,folder):
        deadline=time.monotonic()+8
        while not (folder/'model-pids.json').is_file() and time.monotonic()<deadline:time.sleep(.05)
        self.assertTrue((folder/'model-pids.json').is_file())
        return json.loads((folder/'model-pids.json').read_text())
    def test_worker_crash_stops_only_its_job_and_queues_original_proof(self):
        a,packet,folder=self.launch();pids=self.wait_model(folder)
        other,_,other_folder=self.launch();other_pids=self.wait_model(other_folder)
        a.kill();a.wait(timeout=3)
        deadline=time.monotonic()+5
        while not (folder/'exit-receipt.json').exists() and time.monotonic()<deadline:supervisor.recover(self.b);time.sleep(.05)
        receipt=json.loads((folder/'exit-receipt.json').read_text())
        self.assertEqual(receipt['lease'],packet['lease']);self.assertEqual(receipt['runId'],packet['runId'])
        self.assertEqual(receipt['treeProof']['isolation'],'windows-job');self.assertEqual(receipt['treeProof']['remaining'],0)
        self.assertFalse(any(process_alive(p) for p in pids))
        self.assertTrue(all(process_alive(p) for p in other_pids));self.assertIsNone(other.poll())
        before=(folder/'exit-receipt.json').read_bytes();supervisor.recover(self.b)
        self.assertEqual((folder/'exit-receipt.json').read_bytes(),before)
    def test_no_packet_bytes_before_successful_job_assignment(self):
        worker,packet,folder=self.launch(release=False)
        with patch.object(supervisor.Job,'assign',side_effect=OSError('denied')):
            with self.assertRaises(OSError):supervisor.release(worker,self.config,self.cfg,packet,folder)
        self.assertIsNotNone(worker.poll());self.assertFalse((folder/'model-pids.json').exists());self.assertFalse(supervisor._ACTIVE)
    def test_normal_queued_receipt_is_never_reclassified_after_ack_unlinks_file(self):
        worker,packet,folder=self.launch();self.wait_model(folder)
        journal=folder/'validation-recovery.json';value=json.loads(journal.read_text());value['receiptQueued']=True;journal.write_text(json.dumps(value))
        worker.kill();worker.wait(timeout=3);supervisor.recover(self.b)
        self.assertFalse((folder/'exit-receipt.json').exists());self.assertFalse(supervisor._ACTIVE)
    def test_query_failure_keeps_unknown_and_retains_original_handle_for_retry(self):
        worker,packet,folder=self.launch();self.wait_model(folder);worker.kill();worker.wait(timeout=3)
        state=next(iter(supervisor._ACTIVE.values()))
        with patch.object(state['job'],'count',side_effect=OSError('query unavailable')):supervisor.recover(self.b)
        self.assertFalse((folder/'exit-receipt.json').exists());self.assertTrue(supervisor._ACTIVE)
        self.assertIsNotNone(state['job'].handle)
        supervisor.recover(self.b);self.assertTrue((folder/'exit-receipt.json').exists())
    def test_job_construction_failure_cleans_unreleased_worker(self):
        worker,packet,folder=self.launch(release=False)
        with patch.object(supervisor,'Job',side_effect=OSError('create denied')):
            with self.assertRaises(OSError):supervisor.release(worker,self.config,self.cfg,packet,folder)
        self.assertIsNotNone(worker.poll());self.assertFalse((folder/'model-pids.json').exists());self.assertFalse(supervisor._ACTIVE)
    def test_duplicate_binding_preserves_original_job_and_worker(self):
        original,packet,folder=self.launch();self.wait_model(folder)
        key=next(iter(supervisor._ACTIVE));state=supervisor._ACTIVE[key]
        worker,_,_=self.launch(release=False)
        with self.assertRaises(ValueError):supervisor.release(worker,self.config,self.cfg,packet,folder)
        self.assertIs(supervisor._ACTIVE[key],state);self.assertIsNone(original.poll())
        self.assertIsNotNone(state['job'].handle);self.assertIsNotNone(worker.poll())
    def test_pending_receipt_without_proof_is_completed_from_original_job(self):
        worker,packet,folder=self.launch();self.wait_model(folder)
        path=folder/'exit-receipt.json';path.write_text(json.dumps(dict(runId=packet['runId'],lease=packet['lease'])))
        worker.kill();worker.wait(timeout=3);supervisor.recover(self.b)
        receipt=json.loads(path.read_text());self.assertEqual(receipt['treeProof']['remaining'],0)
        self.assertEqual(receipt['lease'],packet['lease']);self.assertFalse(supervisor._ACTIVE)
    def test_existing_proof_and_mismatched_receipt_are_preserved(self):
        for wrong_identity in (False,True):
            worker,packet,folder=self.launch();self.wait_model(folder)
            path=folder/'exit-receipt.json'
            receipt=dict(runId=packet['runId'],lease=str(uuid.uuid4()) if wrong_identity else packet['lease'])
            if not wrong_identity:receipt['treeProof']={'original':'preserve'}
            path.write_text(json.dumps(receipt));before=path.read_bytes()
            worker.kill();worker.wait(timeout=3);supervisor.recover(self.b)
            self.assertEqual(path.read_bytes(),before)
    def test_packet_write_failure_cleans_only_new_binding(self):
        original,_,folder=self.launch();self.wait_model(folder)
        old=dict(supervisor._ACTIVE)
        worker,packet,folder=self.launch(release=False)
        with patch.object(worker.stdin,'write',side_effect=OSError('pipe failed')):
            with self.assertRaises(OSError):supervisor.release(worker,self.config,self.cfg,packet,folder)
        self.assertEqual(supervisor._ACTIVE,old);self.assertIsNone(original.poll())
        self.assertIsNotNone(worker.poll());self.assertFalse((folder/'model-pids.json').exists())
    def test_cold_watcher_cannot_invent_proof_from_journal_or_missing_job_name(self):
        folder=self.root/'outbound'/str(uuid.uuid4());folder.mkdir(parents=True)
        (folder/'validation-recovery.json').write_text(json.dumps(dict(supervisorPid=999999,receiptQueued=False)))
        supervisor.recover(self.b);self.assertFalse((folder/'exit-receipt.json').exists())

if __name__=='__main__':unittest.main()
