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
        self.rt=SimpleNamespace(folder=self.task,native_id='native',_call=lambda *a:'a'*64,status=lambda:{'phase':'P3','localCompleted':False})
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

if __name__=='__main__':unittest.main()
