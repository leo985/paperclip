import hashlib
import json
from pathlib import Path
import sys
import tempfile
import unittest
import uuid
from unittest.mock import patch
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from analysis_runtime import AnalysisRuntime, ARTIFACTS, PHASES
from pilot import BridgeError, atomic_json

class AnalysisRuntimeTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(); self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.cap = {'kind': 'analysis', 'root': str(self.root/'harness'), 'repository': 'git.example.com/analysis',
                    'profile': 'dsp', 'roles': ['requirements-analysis'], 'commit': 'a'*40,
                    'manifestDigest': 'b'*64, 'protocolVersion': 1}
        self.inspection = patch('analysis_runtime.inspect', return_value=self.cap); self.inspection.start(); self.addCleanup(self.inspection.stop)
        self.runtime = AnalysisRuntime(self.cap, self.root/'tasks', str(uuid.uuid4()), str(uuid.uuid4()), 1)
        self.runtime.folder.mkdir(parents=True)
        for name in ARTIFACTS: (self.runtime.folder/name).write_text('{}')
        self.runtime.binding_file.parent.mkdir(); atomic_json(self.runtime.binding_file, self.runtime.binding)

    def status(self, completed=False, errors=None):
        return json.dumps({'state': {'schema_version': 1, 'id': self.runtime.native_id, 'profile': 'dsp',
            'phase': 'P4' if completed else 'P0', 'status': 'completed' if completed else 'in-progress',
            'completed_phases': PHASES if completed else []}, 'gate_errors': errors or []})

    def test_exit_zero_with_gate_errors_never_means_completion(self):
        with patch.object(self.runtime, '_call', return_value=self.status(True, ['P3: stale review'])):
            self.assertFalse(self.runtime.status()['localCompleted'])
            with self.assertRaises(BridgeError): self.runtime.delivery()

    def test_resume_never_reinitializes_or_grants_execution(self):
        with patch.object(self.runtime, '_call', return_value=self.status()) as call:
            result = self.runtime.prepare('Test analysis')
        self.assertEqual(result['skill'], 'analysis-resume'); self.assertFalse(result['executionGranted'])
        self.assertEqual(call.call_args.args[0], 'status')

    def test_unbound_or_foreign_tasks_are_not_adopted(self):
        atomic_json(self.runtime.binding_file, {**self.runtime.binding, 'companyId': str(uuid.uuid4())})
        with self.assertRaises(BridgeError): self.runtime.prepare('test')
        self.runtime.binding_file.unlink()
        with self.assertRaises(BridgeError): self.runtime.prepare('test')

    def test_handoff_is_hashed_separately_from_native_inputs(self):
        def output(command, *args): return 'f'*64 if command == 'fingerprint' else self.status(True)
        with patch.object(self.runtime, '_call', side_effect=output):
            first = self.runtime.delivery()
            (self.runtime.folder/'handoff.md').write_text('new handoff')
            second = self.runtime.delivery()
        self.assertEqual(first['inputDigest'], second['inputDigest'])
        self.assertNotEqual(first['handoffDigest'], second['handoffDigest'])
        self.assertEqual(second['formalPublication'], 'unverified')

    def test_changed_material_during_collection_is_rejected(self):
        fingerprints = iter(['a'*64, 'b'*64])
        def output(command, *args): return next(fingerprints) if command == 'fingerprint' else self.status(True)
        with patch.object(self.runtime, '_call', side_effect=output):
            with self.assertRaises(BridgeError): self.runtime.delivery()

    def test_only_bound_demands_transfer_the_exact_analysis_bytes(self):
        raw = '# 分析\r\n内容 <script> & test'.encode('utf-8')
        (self.runtime.folder/'analysis.md').write_bytes(raw)
        def output(command, *args): return 'f'*64 if command == 'fingerprint' else self.status(True)
        with patch.object(self.runtime, '_call', side_effect=output):
            self.assertNotIn('analysisMarkdown', self.runtime.delivery())
            delivery = self.runtime.delivery(include_content=True)
        self.assertEqual(delivery['analysisMarkdown'].encode('utf-8'), raw)
        self.assertEqual(next(a['sha256'] for a in delivery['artifacts'] if a['path'] == 'analysis.md'), hashlib.sha256(raw).hexdigest())

    def test_large_or_blank_analysis_is_not_transferred(self):
        def output(command, *args): return 'f'*64 if command == 'fingerprint' else self.status(True)
        with patch.object(self.runtime, '_call', side_effect=output):
            for content in [' ', '中'*40001]:
                (self.runtime.folder/'analysis.md').write_text(content, encoding='utf-8')
                with self.assertRaises(BridgeError): self.runtime.delivery(include_content=True)

    def test_changed_harness_or_invalid_identity_is_rejected(self):
        with patch('analysis_runtime.inspect', return_value={**self.cap, 'manifestDigest': 'c'*64}):
            with self.assertRaises(BridgeError): AnalysisRuntime(self.cap, self.root/'tasks', str(uuid.uuid4()), str(uuid.uuid4()), 1)
        with self.assertRaises(BridgeError): AnalysisRuntime(self.cap, self.root/'tasks', '../bad', str(uuid.uuid4()), 1)

    def test_native_commands_use_argv_cwd_and_timeout(self):
        with patch('analysis_runtime.subprocess.run') as run:
            run.return_value.returncode = 0; run.return_value.stdout = 'ok'
            self.runtime._call('status', self.runtime.native_id)
        args = run.call_args.args[0]
        self.assertIn('--tasks-root', args); self.assertEqual(run.call_args.kwargs['cwd'], Path(self.cap['root']))
        self.assertEqual(run.call_args.kwargs['timeout'], 30); self.assertNotIn('shell', run.call_args.kwargs)

    def test_status_lock_collision_retries_without_removing_native_lock(self):
        from types import SimpleNamespace
        busy=SimpleNamespace(returncode=1,stderr='ERROR: 任务正在写入或有遗留 .lock，请先核实进程',stdout='')
        good=SimpleNamespace(returncode=0,stderr='',stdout=self.status())
        with patch('analysis_runtime.subprocess.run',side_effect=[busy,good]) as run,patch('analysis_runtime.time.sleep'):
            self.assertEqual(json.loads(self.runtime._call('status',self.runtime.native_id))['gate_errors'],[])
            self.assertEqual(run.call_count,2)

    def test_persistent_lock_is_typed_and_writes_are_never_retried(self):
        from types import SimpleNamespace
        from analysis_runtime import AnalysisRuntimeBusy
        busy=SimpleNamespace(returncode=1,stderr='任务正在写入或有遗留 .lock',stdout='')
        with patch('analysis_runtime.subprocess.run',return_value=busy) as run,patch('analysis_runtime.time.sleep'):
            with self.assertRaises(AnalysisRuntimeBusy):self.runtime._call('status',self.runtime.native_id)
            self.assertEqual(run.call_count,5)
            run.reset_mock()
            with self.assertRaises(BridgeError):self.runtime._call('advance',self.runtime.native_id)
            self.assertEqual(run.call_count,1)

    def test_new_demand_directory_is_readable_and_task_unique(self):
        company,task=str(uuid.uuid4()),str(uuid.uuid4())
        rt=AnalysisRuntime(self.cap,self.root/'new-tasks',company,task,2,'TWGF-00919')
        self.assertEqual(rt.folder.name,'analysis-TWGF-00919-r2-'+task)
        self.assertEqual(rt.binding['nativeId'],'pc-'+task+'-r2')
        with patch.object(rt,'_call') as call:
            def create(command,*args):
                if command=='init':
                    rt.folder.mkdir(parents=True)
                    for name in ARTIFACTS:(rt.folder/name).write_text('{}')
                return ''
            call.side_effect=create
            with patch.object(rt,'status',return_value={}):rt.prepare('Test')
        restored=AnalysisRuntime(self.cap,self.root/'new-tasks',company,task,2,None)
        self.assertEqual(restored.native_id,rt.native_id)
        other=AnalysisRuntime(self.cap,self.root/'new-tasks',company,str(uuid.uuid4()),2,'TWGF-00919')
        self.assertNotEqual(other.folder,rt.folder)

    def test_legacy_binding_keeps_its_original_directory(self):
        rt=AnalysisRuntime(self.cap,self.runtime.tasks_root,self.runtime.binding['companyId'],self.runtime.binding['taskId'],1,'TWGF-00919')
        self.assertEqual(rt.folder,self.runtime.folder)
        self.assertEqual(rt.native_id,self.runtime.native_id)

    def test_location_registry_rejects_traversal_or_another_task(self):
        rt=self.runtime
        atomic_json(rt.location_file,{'companyId':rt.binding['companyId'],'taskId':rt.binding['taskId'],'revision':1,'nativeId':'../foreign'})
        with self.assertRaises(BridgeError):AnalysisRuntime(self.cap,rt.tasks_root,rt.binding['companyId'],rt.binding['taskId'],1,'TWGF-00919')

    def test_named_report_export_preserves_exact_reviewed_bytes(self):
        raw='# 德国付款分析\r\n正文'
        (self.runtime.folder/'analysis.md').write_bytes(raw.encode())
        path=self.runtime.export_report(raw,'TWGF-00919')
        self.assertEqual(path.name,'TWGF-00919-需求分析.md')
        self.assertEqual(path.read_bytes(),raw.encode())
        with self.assertRaises(BridgeError):self.runtime.export_report('obsolete','TWGF-00919')
        with self.assertRaises(BridgeError):self.runtime.export_report(raw,'../unsafe')

if __name__ == '__main__': unittest.main()
