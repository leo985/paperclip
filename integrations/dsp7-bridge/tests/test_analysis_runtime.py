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

if __name__ == '__main__': unittest.main()
