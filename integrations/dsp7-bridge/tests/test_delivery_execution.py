import hashlib,json,sys,tempfile,unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch
sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
import delivery_execution as delivery
from pilot import atomic_json,BridgeError
class DeliveryExecutionTest(unittest.TestCase):
 def setUp(self):
  self.tmp=tempfile.TemporaryDirectory();self.addCleanup(self.tmp.cleanup);self.root=Path(self.tmp.name);self.ticket=self.root/'tickets/design-TEST-1';self.ticket.mkdir(parents=True)
  self.stage={'taskId':'task','stage':'design','jiraKey':'TEST-1','inputDigest':'a'*64}
  self.c={'root':str(self.root),'ticketDirectory':str(self.ticket),'statePath':str(self.ticket/'state.json'),'stage':self.stage,'runId':'run'}
  self.state={'工单号':'TEST-1','状态':'completed','Phase状态':{'P1':{'状态':'completed'}}}
  atomic_json(self.ticket/'state.json',self.state);(self.ticket/'design.md').write_text('real artifact')
 def test_separate_review_delegation_does_not_claim_the_review_ticket_in_the_coding_run(self):
  c={**self.c,'role':'coding','workflow':'feature','environmentReference':'','upstream':[],'delegatedReviewKeys':['REV-2']}
  text=delivery.prompt(c)
  self.assertIn('REV-2',text);self.assertIn('不得初始化、流转、上传、计时或上报这些独立评审单',text)
  self.assertIn('保留当前工作单自身技术质量检查',text)
 def test_human_review_node_is_never_executed_by_a_device(self):
  bridge=SimpleNamespace(cfg={'company_id':'company'},config_path=self.root/'config.json')
  with patch.object(delivery,'api_call',return_value={'stage':{**self.stage,'executionMode':'human'}}):
   with self.assertRaisesRegex(BridgeError,'不能由席位执行通道代办'):
    delivery.prepare(bridge,{'runId':'run','lease':'lease','executionRoute':{}},self.root)
 def test_rework_prompt_contains_human_feedback_and_forbids_reusing_completed_evidence(self):
  c={**self.c,'role':'design','workflow':'design-doc','environmentReference':'','upstream':[],'stage':{**self.stage,'reworkHistory':[{'round':1,'rejection':{'note':'补充异常处理设计'}}]}}
  text=delivery.prompt(c)
  self.assertIn('补充异常处理设计',text);self.assertIn('原生恢复／重开流程',text);self.assertIn('不得直接复用 completed',text)
 def test_rework_cannot_relabel_old_completed_native_state(self):
  self.c['stage']['reworkHistory']=[{'previous':{'receipt':{'stateDigest':hashlib.sha256((self.ticket/'state.json').read_bytes()).hexdigest()}}}]
  with patch.object(delivery.subprocess,'run') as run:
   self.assertIsNone(delivery.collect_receipt(None,self.c));run.assert_not_called()
 def test_rework_state_change_alone_does_not_prove_material_changes(self):
  self.c['stage']['reworkHistory']=[{'previous':{'receipt':{'stateDigest':'0'*64,'artifacts':delivery.artifact_index(self.ticket)}}}]
  atomic_json(self.ticket/'metrics-source.json',{'source':'zhiyan','acknowledged_snapshot_id':'new'})
  with patch.object(delivery.subprocess,'run',return_value=SimpleNamespace(returncode=0)),patch.object(delivery,'tracker_receipt',return_value='42'):
   self.assertIsNone(delivery.collect_receipt(None,self.c))
 def test_adapter_exit_or_partial_state_is_not_delivery(self):
  self.state['状态']='in-progress';atomic_json(self.ticket/'state.json',self.state)
  self.assertIsNone(delivery.collect_receipt(None,self.c))
 def test_foreign_task_or_pending_confirmation_is_rejected_before_external_reads(self):
  for change in ({'工单号':'TEST-2'},{'Jira确认':{'当前':{'状态':'pending'}}}):
   atomic_json(self.ticket/'state.json',{**self.state,**change})
   with self.assertRaises(BridgeError):delivery.collect_receipt(None,self.c)
 def test_failed_native_identity_is_never_reported_as_completed(self):
  with patch.object(delivery.subprocess,'run',return_value=SimpleNamespace(returncode=1)),self.assertRaises(BridgeError):delivery.collect_receipt(None,self.c)
 def test_only_matching_jira_attachment_freezes_the_receipt(self):
  content=(self.ticket/'design.md').read_bytes()
  class Response:
   def __init__(self,data):self.data=data
   def __enter__(self):return self
   def __exit__(self,*args):pass
   def read(self,*args):return self.data
  guard=SimpleNamespace(credentials=lambda:('https://jira.example','secret'),NoRedirect=object)
  for match in (False,True):
   data=json.dumps({'fields':{'attachment':[{'content':'https://jira.example/secure/attachment/1/design.md','size':len(content)}]}}).encode()
   opener=SimpleNamespace(open=lambda req,**kw:Response(data if '/rest/api' in req.full_url else content if match else b'other artifact'))
   with patch.object(delivery.subprocess,'run',return_value=SimpleNamespace(returncode=0)),patch.object(delivery,'tracker_receipt',return_value='receipt-42'),patch.object(delivery,'load_module',return_value=guard),patch.object(delivery.urllib.request,'build_opener',return_value=opener):
    if match:
     r=delivery.collect_receipt(None,self.c);self.assertEqual(r['runId'],'run');self.assertEqual(r['trackerReceiptId'],'receipt-42');self.assertEqual(next(a for a in r['artifacts'] if a['path']=='design.md')['downloadUrl'],'https://jira.example/secure/attachment/1/design.md');self.assertTrue(any(a['sha256']==hashlib.sha256(content).hexdigest() for a in r['artifacts']))
    else:
     with self.assertRaises(BridgeError):delivery.collect_receipt(None,self.c)
 def test_symlinks_are_not_delivery_artifacts(self):
  outside=self.root/'secret.md';outside.write_text('secret');(self.ticket/'leak.md').symlink_to(outside)
  self.assertNotIn('leak.md',[a['path'] for a in delivery.artifact_index(self.ticket)])
 def test_delivery_without_frozen_server_ack_never_exits(self):
  with patch.object(delivery,'context_from_env',return_value=(None,self.c,self.root)),patch.object(delivery,'collect_receipt',return_value={'runId':'run'}),patch.object(delivery,'api_call',side_effect=BridgeError('network')):
   with self.assertRaises(BridgeError):delivery.stop_hook(timeout=1)
  self.assertFalse((self.root/'delivery-completion.json').exists())
 def test_questions_are_version_bound_and_reply_does_not_write_a_native_approval(self):
  atomic_json(self.ticket/'delivery-question.json',{'text':'Scope?'})
  with patch.object(delivery,'context_from_env',return_value=(None,self.c,self.root)),patch.object(delivery,'collect_receipt',return_value=None),patch.object(delivery,'api_call',return_value={'answer':'Use design A'}) as api:
   result=delivery.stop_hook(timeout=1);self.assertIn('Use design A',result['reason']);self.assertEqual(api.call_args.kwargs['digest'],hashlib.sha256((self.ticket/'delivery-question.json').read_bytes()).hexdigest())
  self.assertNotIn('Jira确认',json.loads((self.ticket/'state.json').read_text()))
 def test_qa_prepare_needs_harness_and_environment_but_no_business_repository(self):
  import harness_routing
  bridge=SimpleNamespace(cfg={'company_id':'company'},config_path=self.root/'config.json')
  packet={'runId':'run','lease':'lease','executionRoute':{}}
  guard=SimpleNamespace(resolve=lambda *a:{'status':'ready','target':{'父工单号':'TEST-100'}})
  for stage in ('test-cases','functional-test'):
   task={**self.stage,'stage':stage,'parentKey':'TEST-100','taskId':stage}
   with patch.object(delivery,'api_call',return_value={'stage':task,'environmentReference':'https://test.example/build-42','upstream':[]}),patch.object(harness_routing,'resolve_route',return_value={'root':str(self.root)}),patch.object(delivery,'load_module',return_value=guard):
    result=delivery.prepare(bridge,packet,self.root/'outbound')
    self.assertEqual(result['root'],str(self.root))
    self.assertIn('https://test.example/build-42',delivery.prompt(result))
    self.assertNotIn('project_repositories',bridge.cfg)

 def test_prepare_binds_native_history_and_rejects_a_different_parent(self):
  import harness_routing
  self.stage['parentKey']='TEST-100'
  bridge=SimpleNamespace(cfg={'company_id':'company'},config_path=self.root/'config.json')
  packet={'runId':'run','lease':'lease','executionRoute':{}}
  guard=SimpleNamespace(resolve=lambda *a:{'status':'ready','target':{'父工单号':'TEST-100'}})
  def prepare():return delivery.prepare(bridge,packet,self.root/'outbound')
  with patch.object(delivery,'api_call',return_value={'stage':self.stage}),patch.object(harness_routing,'resolve_route',return_value={'root':str(self.root)}),patch.object(delivery,'load_module',return_value=guard):
   with self.assertRaises(BridgeError):prepare() # unowned historical completed state
   atomic_json(self.ticket/'state.json',{**self.state,'状态':'in-progress'})
   prepare()
   atomic_json(self.ticket/'state.json',self.state)
   self.assertEqual(prepare()['stage']['taskId'],'task') # same-task recovery after ACK loss
   guard.resolve=lambda *a:{'status':'ready','target':{'父工单号':'OTHER-1'}}
   with self.assertRaises(BridgeError):prepare()
 def test_preflight_reads_project_jira_env_without_leaking_or_overwriting_other_settings(self):
  import os
  settings=self.root/'.claude/settings.local.json';atomic_json(settings,{'env':{'JIRA_BASE_URL':'https://jira.example','JIRA_PAT_TOKEN':'private','ANTHROPIC_API_KEY':'not-for-preflight'}})
  with patch.dict(os.environ,{'JIRA_PAT_TOKEN':'prior'},clear=True):
   with delivery.domain_jira_environment(self.root):
    self.assertEqual(os.environ['JIRA_PAT_TOKEN'],'private');self.assertNotIn('ANTHROPIC_API_KEY',os.environ)
   self.assertEqual(os.environ['JIRA_PAT_TOKEN'],'prior');self.assertNotIn('JIRA_BASE_URL',os.environ)
 def test_formal_confirmation_is_read_back_without_mutating_native_files(self):
  reply={'评论ID':'42','原文':'批准 #REQ-1','评论时间':'2026-10-30T00:00:00+00:00','评论人':{'账号':'reviewer'}}
  state={**self.state,'Jira确认':{'当前':{'状态':'approved','回复':reply}}}
  before=json.dumps(state,sort_keys=True)
  class Response:
   def __init__(self,payload):self.payload=payload
   def __enter__(self):return self
   def __exit__(self,*args):pass
   def read(self,*args):return json.dumps(self.payload).encode()
  def resolve(path,probe,comments):
   self.assertNotEqual(path,self.ticket/'state.json')
   self.assertEqual(probe['Jira确认']['当前']['状态'],'pending')
   path.write_text('temporary native state write')
   return comments[0]['decision'],{'回复':comments[0]['reply']}
  native=SimpleNamespace(resolve_confirmation=resolve)
  for change in ({}, {'原文':'批准 #REQ-1 修改后'}, {'评论ID':'43'}, {'评论人':{'账号':'other'}}):
   payload={'startAt':0,'total':1,'comments':[{'decision':'approved','reply':{**reply,**change}}]}
   opener=SimpleNamespace(open=lambda *a,**k:Response(payload))
   with patch.object(delivery,'load_module',return_value=native):
    if change:
     with self.assertRaises(BridgeError):delivery.verify_jira_confirmation(self.root,'TEST-1',state,'https://jira.example','private',opener)
    else:delivery.verify_jira_confirmation(self.root,'TEST-1',state,'https://jira.example','private',opener)
   self.assertEqual(json.dumps(state,sort_keys=True),before)
   self.assertEqual(json.loads((self.ticket/'state.json').read_text()),self.state)
 def test_formal_confirmation_rejects_incomplete_or_deleted_replies(self):
  reply={'评论ID':'42','原文':'批准','评论时间':'now','评论人':{'账号':'reviewer'}}
  state={'Jira确认':{'当前':{'状态':'approved','回复':reply}}}
  class Response:
   def __init__(self,payload):self.payload=payload
   def __enter__(self):return self
   def __exit__(self,*args):pass
   def read(self,*args):return json.dumps(self.payload).encode()
  native=SimpleNamespace(resolve_confirmation=lambda *a:('pending',None))
  for payload in ({'startAt':0,'total':1,'comments':[]},{'startAt':0,'total':0,'comments':[]},{'startAt':0,'total':1001,'comments':[]}):
   with patch.object(delivery,'load_module',return_value=native),self.assertRaises(BridgeError):
    delivery.verify_jira_confirmation(self.root,'TEST-1',state,'https://jira.example','private',SimpleNamespace(open=lambda *a,**k:Response(payload)))
 def test_dependent_run_rechecks_pinned_formal_material_and_rejects_changes(self):
  from unittest.mock import Mock
  data=b'approved design'
  artifact={'path':'design.md','sha256':hashlib.sha256(data).hexdigest(),'downloadUrl':'https://jira.example/secure/attachment/1/design.md'}
  receipt={'jiraReference':'https://jira.example/browse/TEST-1','jiraKey':'TEST-1','artifacts':[artifact]}
  class Response:
   def __init__(self,content):self.content=content
   def __enter__(self):return self
   def __exit__(self,*args):pass
   def read(self,*args):return self.content
  guard=SimpleNamespace(credentials=lambda:('https://jira.example','private'),NoRedirect=object)
  for content in (data,b'changed',b''):
   opener=SimpleNamespace(open=Mock(return_value=Response(content)))
   with patch.object(delivery.urllib.request,'build_opener',return_value=opener):
    if content==data:delivery.verify_upstream_artifacts([{'receipt':receipt}],guard)
    else:
     with self.assertRaises(BridgeError):delivery.verify_upstream_artifacts([{'receipt':receipt}],guard)
   self.assertEqual(opener.open.call_args.args[0].full_url,artifact['downloadUrl'])
  for change in ({'downloadUrl':'https://foreign.example/secure/attachment/1/design.md'},{'downloadUrl':'https://jira.example/secure/attachment/1/design.md?token=private'},{'downloadUrl':None}):
   opener=SimpleNamespace(open=Mock())
   invalid={**receipt,'artifacts':[{**artifact,**change}]}
   with patch.object(delivery.urllib.request,'build_opener',return_value=opener),self.assertRaises(BridgeError):
    delivery.verify_upstream_artifacts([{'receipt':invalid}],guard)
   opener.open.assert_not_called()
 def test_test_summary_requires_native_counts_version_and_matching_case_records(self):
  records=self.ticket/'execution-records.md'
  records.write_text('| 用例ID | 结果 |\n|---|---|\n| TC-1 | Passed |\n| TC-2 | Failed |\n')
  state={'证据':{'用例总数':2,'通过数':1,'失败数':1,'阻塞数':0,'跳过数':0},'环境信息':{'被测版本':'build-123'}}
  artifacts=delivery.artifact_index(self.ticket)
  result=delivery.collect_test_results(state,self.ticket,artifacts)
  self.assertEqual(result['failed'],1);self.assertEqual(result['testedVersion'],'build-123')
  for change in ({'证据':{**state['证据'],'通过数':2,'失败数':0}},{'环境信息':{'被测版本':''}},{'证据':{**state['证据'],'失败数':None}}):
   with self.assertRaises(BridgeError):delivery.collect_test_results({**state,**change},self.ticket,artifacts)
  records.write_text('| 用例ID | 结果 |\n|---|---|\n| TC-1 | Passed |\n| TC-1 | Failed |\n')
  with self.assertRaises(BridgeError):delivery.collect_test_results(state,self.ticket,delivery.artifact_index(self.ticket))
  with self.assertRaises(BridgeError):delivery.collect_test_results(state,self.ticket,artifacts)
 def test_repair_launch_uses_native_bugfix_and_independent_review_identities(self):
  import harness_routing
  bridge=SimpleNamespace(cfg={'company_id':'company'},config_path=self.root/'config.json')
  guard=SimpleNamespace(resolve=lambda *a:{'status':'ready','target':{'父工单号':None}})
  packet={'runId':'run','lease':'lease','executionRoute':{}}
  for intent,role,prefix in (('bugfix','coding','bugfix'),('code-review','code-review','review'),('design-review','design-review','design-review'),('test-case-review','test-case-review','testcase-review')):
   stage={**self.stage,'stage':'coding','intent':intent,'taskId':intent}
   with patch.object(delivery,'api_call',return_value={'stage':stage}),patch.object(harness_routing,'resolve_route',return_value={'root':str(self.root)}),patch.object(delivery,'load_module',return_value=guard):
    prepared=delivery.prepare(bridge,packet,self.root/'outbound')
   self.assertEqual(prepared['role'],role)
   self.assertEqual(Path(prepared['ticketDirectory']).name,prefix+'-TEST-1')
   self.assertEqual(json.loads((self.root/'tickets/.platform-delivery-bindings'/(intent+'.json')).read_text())['intent'],intent)
 def test_independent_review_requires_native_passed_version_and_formal_completion(self):
  self.c['stage']={**self.stage,'stage':'coding','intent':'code-review'}
  content=(self.ticket/'design.md').read_bytes()
  class Response:
   def __init__(self,data):self.data=data
   def __enter__(self):return self
   def __exit__(self,*args):pass
   def read(self,*args):return self.data
  data=json.dumps({'fields':{'attachment':[{'content':'https://jira.example/secure/attachment/1/design.md','size':len(content)}]}}).encode()
  opener=SimpleNamespace(open=lambda req,**kw:Response(data if '/rest/api' in req.full_url else content))
  guard=SimpleNamespace(credentials=lambda:('https://jira.example','secret'),NoRedirect=object)
  good={**self.state,'评审结果':'passed','交付状态':'completed','完成状态已核验':True,'被审版本':{'sha':'a'*40},'报告路径':'design.md'}
  with patch.object(delivery.subprocess,'run',return_value=SimpleNamespace(returncode=0)),patch.object(delivery,'tracker_receipt',return_value='42'),patch.object(delivery,'load_module',return_value=guard),patch.object(delivery.urllib.request,'build_opener',return_value=opener):
   for change in ({'评审结果':'failed'},{'完成状态已核验':False},{'被审版本':{}},{'报告路径':'missing.md'}):
    atomic_json(self.ticket/'state.json',{**good,**change})
    with self.assertRaises(BridgeError):delivery.collect_receipt(None,self.c)
   atomic_json(self.ticket/'state.json',good)
   result=delivery.collect_receipt(None,self.c)
   self.assertEqual(result['codeReview']['decision'],'passed')
   self.assertEqual(result['codeReview']['sourceSha256'],hashlib.sha256(content).hexdigest())
   for intent,stage in (('design-review','design'),('test-case-review','test-cases')):
    self.c['stage']={**self.stage,'stage':stage,'intent':intent}
    atomic_json(self.ticket/'state.json',{**good,'被审版本':{'inputDigest':self.stage['inputDigest'],'workKeys':self.stage.get('reviewWorkKeys')}})
    result=delivery.collect_receipt(None,self.c)
    self.assertNotIn('codeReview',result);self.assertEqual(result['domainReview']['decision'],'passed')
 def test_zhiyan_receipt_requires_current_ack_scope_generation_and_metrics(self):
  state={**self.state,'类型':'design-review','_paperclip_state_path':str(self.ticket/'state.json')}
  remote={'project_id':7,'metrics_generation':2,'harness_duration_minutes':12}
  meta={'source':'zhiyan','project':'tracker:7','ticket_no':'TEST-1','metrics_generation':2,'acknowledged_snapshot_id':'current'}
  snapshot={**meta,'snapshot_id':'current','payload':{'harness_duration_minutes':12}}
  atomic_json(self.ticket/'metrics-source.json',meta);atomic_json(self.ticket/'zhiyan-snapshot.json',snapshot)
  delivery.verify_zhiyan_readback(self.root,state,remote)
  for change in ({'metrics_generation':3},{'project_id':8},{'harness_duration_minutes':11}):
   with self.assertRaises(BridgeError):delivery.verify_zhiyan_readback(self.root,state,{**remote,**change})
  for change in ({'acknowledged_snapshot_id':'old'},{'pending_snapshot_id':'next'},{'reset_pending':True}):
   atomic_json(self.ticket/'metrics-source.json',{**meta,**change})
   with self.assertRaises(BridgeError):delivery.verify_zhiyan_readback(self.root,state,remote)
  atomic_json(self.ticket/'metrics-source.json',meta)
  (self.ticket/'zhiyan-snapshot.json').unlink()
  with self.assertRaisesRegex(BridgeError,'缺少知言统计快照'):delivery.verify_zhiyan_readback(self.root,state,remote)
 def test_native_layout_and_existing_legacy_binding_are_respected(self):
  import harness_routing
  self.stage['parentKey']='TEST-100'
  state=self.root/'工单/design-TEST-1/state.json'
  atomic_json(state,self.state)
  expected={'companyId':'company','taskId':'task','stage':'design','jiraKey':'TEST-1','parentKey':'TEST-100'}
  atomic_json(self.root/'tickets/.platform-delivery-bindings/task.json',expected)
  guard=SimpleNamespace(resolve=lambda *a:{'status':'ready','target':{'父工单号':'TEST-100'}},execution_state_path=lambda *a:state)
  bridge=SimpleNamespace(cfg={'company_id':'company'},config_path=self.root/'config.json')
  with patch.object(delivery,'api_call',return_value={'stage':self.stage}),patch.object(harness_routing,'resolve_route',return_value={'root':str(self.root)}),patch.object(delivery,'load_module',return_value=guard):
   result=delivery.prepare(bridge,{'runId':'run','lease':'lease','executionRoute':{}},self.root/'outbound')
   self.assertEqual(result['statePath'],str(state))
   self.assertEqual(json.loads((self.root/'工单/.platform-delivery-bindings/task.json').read_text()),expected)
 def test_identity_refresh_tolerates_legacy_timestamp_only_and_rejects_business_edits(self):
  for change in ({'工单身份':{'校验时间':'now'}},{'状态':'in-progress'}):
   atomic_json(self.ticket/'state.json',self.state)
   def verify(*a,**k):
    atomic_json(self.ticket/'state.json',{**self.state,**change});return SimpleNamespace(returncode=0)
   with patch.object(delivery.subprocess,'run',side_effect=verify),patch.object(delivery,'tracker_receipt',side_effect=BridgeError('reached external read')):
    with self.assertRaisesRegex(BridgeError,'reached external read' if '工单身份' in change else '业务状态变化'):delivery.collect_receipt(None,self.c)
if __name__=='__main__':unittest.main()
