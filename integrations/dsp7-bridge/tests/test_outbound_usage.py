from pathlib import Path
import sys
import unittest
import tempfile
import json
import uuid
from types import SimpleNamespace
from unittest.mock import Mock, patch
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from outbound import execution_result, flush_exit_receipts, collect_usage_checkpoint
from pilot import BridgeError

class OutboundUsageTest(unittest.TestCase):
    def test_synthetic_api_errors_are_unknown_rather_than_zero_usage(self):
        from interactive import usage_ledger
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp);session=root/'projects'/'project';session.mkdir(parents=True)
            record={'type':'assistant','isApiErrorMessage':True,'message':{'id':'error-message','model':'<synthetic>','usage':{'input_tokens':0,'output_tokens':0}}}
            (session/'fixture.jsonl').write_text(json.dumps(record)+'\n')
            with patch.dict('os.environ',{'CLAUDE_CONFIG_DIR':str(root)}):
                observed,status=usage_ledger('unused','fixture')
            self.assertEqual(status,'unknown');self.assertEqual(observed['modelUsage'],{})

    def test_failed_run_retains_known_tokens_without_inventing_relay_cost(self):
        summary={'modelUsage':{'claude':{'inputTokens':100,'outputTokens':20,'cacheReadInputTokens':50}},'total_cost_usd':5.25}
        result=execution_result(1,summary,'run')
        self.assertEqual(result['exitCode'],1);self.assertEqual(result['usage']['inputTokens'],100)
        self.assertIsNone(result['costUsd']);self.assertEqual(result['billingType'],'unknown')

    def test_sums_multiple_models_once(self):
        result=execution_result(0,{'modelUsage':{'a':{'inputTokens':100,'outputTokens':0,'cacheReadInputTokens':0},'b':{'inputTokens':200,'outputTokens':50,'cacheReadInputTokens':0}}},'run')
        self.assertEqual(result['usage'],{'inputTokens':300,'outputTokens':50,'cachedInputTokens':0})
        self.assertEqual(result['exitCode'],0)

    def test_missing_model_counters_stay_unknown_instead_of_becoming_zero(self):
        complete={'inputTokens':100,'outputTokens':20,'cacheReadInputTokens':0}
        for missing in complete:
            incomplete={key:value for key,value in complete.items() if key!=missing}
            result=execution_result(0,{'modelUsage':{'claude':incomplete}},'run')
            self.assertEqual(result['exitCode'],1)
            self.assertNotIn('usage',result)

    def test_missing_usage_is_not_success(self):
        self.assertEqual(execution_result(0,None,'run')['exitCode'],1)

    def test_malformed_or_overflow_usage_is_not_accounted_as_valid(self):
        for tokens in [-1,True,'100',2147483648]:
            result=execution_result(0,{'modelUsage':{'a':{'inputTokens':tokens}}},'run')
            self.assertEqual(result['exitCode'],1);self.assertNotIn('usage',result)

class ReceiptOutboxTest(unittest.TestCase):
    def test_checkpoints_are_cumulative_immutable_and_ignore_missing_or_regressing_source(self):
        with tempfile.TemporaryDirectory() as tmp:
            folder=Path(tmp)
            observed={'modelUsage':{'claude':{'inputTokens':100,'outputTokens':10,'cacheReadInputTokens':0}}}
            with patch('interactive.usage_ledger',return_value=(observed,'observed')):
                sequence,previous=collect_usage_checkpoint(folder,'run','lease','cwd',0,None)
                self.assertEqual(sequence,1)
                self.assertEqual(collect_usage_checkpoint(folder,'run','lease','cwd',sequence,previous)[0],1)
            with patch('interactive.usage_ledger',return_value=({},'unknown')):
                self.assertEqual(collect_usage_checkpoint(folder,'run','lease','cwd',sequence,previous),(sequence,previous))
            observed['modelUsage']['claude']['inputTokens']=50
            with patch('interactive.usage_ledger',return_value=(observed,'observed')):
                self.assertEqual(collect_usage_checkpoint(folder,'run','lease','cwd',sequence,previous)[0],1)
            files=list((folder/'usage-checkpoints').glob('*.json'));self.assertEqual(len(files),1)
            self.assertEqual(json.loads(files[0].read_text())['usage']['inputTokens'],100)

    def test_only_explicit_acknowledgement_removes_receipts(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp);run_id = str(uuid.uuid4())
            folder = root/'outbound'/run_id;folder.mkdir(parents=True)
            exit_file = folder/'exit-receipt.json';usage_file = folder/'usage-receipt.json'
            exit_file.write_text(json.dumps({'runId':run_id,'lease':'lease'}))
            usage_file.write_text(json.dumps({'runId':run_id,'lease':'lease','model':'claude','usage':{'inputTokens':100}}))
            b = SimpleNamespace(cfg={'database':str(root/'bridge.db'),'agent_id':'seat'})
            api = Mock();api.request.side_effect = [BridgeError('offline'),[]]
            with patch('outbound.identity',return_value={'machine_id':'machine'}), patch('outbound.seat_api',return_value=api):
                flush_exit_receipts(b)
                self.assertTrue(exit_file.exists());self.assertTrue(usage_file.exists())
                api.request.side_effect = [{'received':True},{'received':True}]
                flush_exit_receipts(b)
                self.assertFalse(exit_file.exists());self.assertFalse(usage_file.exists())
                uploaded=[c for c in api.request.call_args_list if c.args[1].endswith('/usage-final')]
                self.assertEqual(uploaded[-1].args[2]['usage']['inputTokens'],100)

if __name__=='__main__':unittest.main()
