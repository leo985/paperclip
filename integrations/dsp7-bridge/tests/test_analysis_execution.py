"""Version-bound decision relay: real answers, never invented approvals."""
import json
from pathlib import Path
import sys,tempfile,unittest
from types import SimpleNamespace
from unittest.mock import patch
sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
import analysis_execution as relay
from pilot import atomic_json

class AnalysisExecutionTest(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory();self.addCleanup(self.tmp.cleanup)
        self.root=Path(self.tmp.name);self.task=self.root/'native';self.task.mkdir()
        atomic_json(self.task/'requirements.json',{'questions':[]});atomic_json(self.task/'review.json',{})
        (self.task/'intake.md').write_text('intake');(self.task/'analysis.md').write_text('analysis');atomic_json(self.task/'evidence.json',{'items':[]})
        self.rt=SimpleNamespace(export_report=lambda *args:None,folder=self.task,native_id='native',_call=lambda *a:'a'*64,status=lambda:{'phase':'P3','localCompleted':False})
        self.context={'runId':'test-run'}
    def test_review_invalidates_on_input_change(self):
        first=relay.questions(self.rt)
        atomic_json(self.task/'review.json',{'decision':'approved','input_sha256':'a'*64})
        self.assertEqual(relay.questions(self.rt),[])
        self.rt._call=lambda *a:'b'*64
        second=relay.questions(self.rt)
        self.assertNotEqual(first[0]['contentDigest'],second[0]['contentDigest'])
    def test_only_open_blocking_business_questions_are_relayed(self):
        self.rt.status=lambda:{'phase':'P2','localCompleted':False}
        atomic_json(self.task/'requirements.json',{'questions':[{'id':'Q1','question':'Scope?','status':'open','blocking':True},{'id':'Q2','question':'Optional','status':'open','blocking':False}]})
        self.assertEqual([q['key'] for q in relay.questions(self.rt)],['Q1'])
    def run_hook(self,response,receipt=None):
        def call(b,c,suffix,**body):
            if suffix=='questions':return {'decisions':response}
            return {'received':True}
        if receipt:atomic_json(self.root/'analysis-decisions.json',receipt)
        with patch.object(relay,'context_from_env',return_value=(object(),self.context,self.root)),patch.object(relay,'runtime_for',return_value=self.rt),patch.object(relay,'api_call',side_effect=call) as api,patch('managed_sessions.write_hook'):
            result=relay.stop_hook(timeout=1)
        return result,api
    def decision(self,answer='approve'):
        return {**relay.questions(self.rt)[0],'id':'decision','status':'answered','answer':answer,'answeredBy':'actual-test-reviewer','answeredAt':'2026-10-25T12:00:00Z'}
    def test_current_answer_writes_exact_reviewer_and_continues_same_session(self):
        d=self.decision();result,api=self.run_hook([d])
        review=json.loads((self.task/'review.json').read_text())
        self.assertEqual(review['reviewer'],d['answeredBy']);self.assertEqual(review['input_sha256'],d['inputDigest'])
        self.assertEqual(result['decision'],'block');self.assertIn('advance',result['reason'])
        self.assertEqual([c.args[2] for c in api.call_args_list].count('ack'),1)
    def test_rejection_never_approves(self):
        result,_=self.run_hook([self.decision('reject: clarify scope')])
        self.assertEqual(json.loads((self.task/'review.json').read_text()),{})
        self.assertIn('clarify scope',result['reason'])
    def test_no_question_never_invents_human_decision(self):
        self.rt.status=lambda:{'phase':'P1','localCompleted':False}
        result,api=self.run_hook([])
        self.assertEqual(result,{})
        self.assertNotIn('ack',[c.args[2] for c in api.call_args_list])
    def test_receipt_survives_server_ack_response_loss(self):
        d=self.decision();result,api=self.run_hook([],receipt={d['id']:d})
        self.assertEqual(result['decision'],'block')
        self.assertIn('ack',[c.args[2] for c in api.call_args_list])

    def test_completion_retry_sends_frozen_delivery_without_mutable_observation(self):
        self.context['execution']={'demandNo':'ATS3-00156'}
        self.rt.status=lambda:{'phase':'P4','localCompleted':True}
        from unittest.mock import Mock
        self.rt.delivery=Mock(return_value={'inputDigest':'a'*64,'analysisMarkdown':'分析正文'})
        result,api=self.run_hook([])
        self.assertEqual(result,{})
        self.rt.delivery.assert_called_once_with(include_content=True)
        self.assertEqual([c.args[2] for c in api.call_args_list],['delivery'])
        self.assertTrue((self.root/'analysis-completion.json').is_file())

    def test_transient_status_failure_recovers_saved_answer(self):
        d=self.decision()
        from pilot import BridgeError
        status={'phase':'P3','localCompleted':False}
        from unittest.mock import Mock
        self.rt.status=Mock(side_effect=[BridgeError('temporary status collision'),status,status])
        with patch.object(relay.time,'sleep'):
            result,api=self.run_hook([d])
        self.assertEqual(result['decision'],'block')
        self.assertIn('ack',[c.args[2] for c in api.call_args_list])
        self.assertEqual(json.loads((self.task/'review.json').read_text())['reviewer'],d['answeredBy'])

    def test_expired_wait_never_silently_accepts_stop(self):
        with patch.object(relay,'context_from_env',return_value=(object(),self.context,self.root)),patch.object(relay,'runtime_for',return_value=self.rt):
            result=relay.stop_hook(timeout=0)
        self.assertEqual(result['decision'],'block')
        self.assertEqual(json.loads((self.task/'review.json').read_text()),{})

    def test_retry_keeps_original_deadline_and_does_not_hide_failure(self):
        from pilot import BridgeError
        with patch.object(relay,'_stop_hook',side_effect=[BridgeError('status'),{'decision':'block','reason':'real answer'}]) as attempt,patch.object(relay.time,'monotonic',side_effect=[100,100,280,280,280]),patch.object(relay.time,'sleep'):
            result=relay.stop_hook(timeout=3600)
        self.assertEqual(result['reason'],'real answer')
        self.assertEqual(attempt.call_args_list[1].kwargs['timeout'],3420)

    def test_review_capture_includes_exact_documents_but_removes_signed_metadata(self):
        atomic_json(self.task/'evidence.json',{'items':[{'id':'E1','kind':'file','source':'https://example.com/api?token=secret','metadata':{'url':'signed-secret'},'path':'sources/file.pdf','sha256':'b'*64}]})
        result=relay.review_materials(self.rt,'test-run')
        self.assertEqual(result['inputDigest'],'a'*64)
        self.assertTrue(result['capturedAt'].endswith('Z'))
        self.assertEqual(len(result['documents']),3)
        self.assertNotIn('secret',json.dumps(result))
        self.assertEqual(result['evidence'][0]['source'],'https://example.com/api')

    def test_changed_review_inputs_are_not_uploaded_as_a_stable_version(self):
        self.rt._call=lambda *a: next(values)
        values=iter(['a'*64,'b'*64])
        from pilot import BridgeError
        with self.assertRaises(BridgeError):relay.review_materials(self.rt,'test-run')

if __name__=='__main__':unittest.main()
