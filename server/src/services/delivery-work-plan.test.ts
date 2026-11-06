import { describe, expect, it } from "vitest";
import { DEFAULT_DELIVERY_TEMPLATE, deliveryTemplateDefinitionSchema, deliveryWorkflowStartSchema, type DeliveryWorkflowConfig, type DeliveryWorkItem, type DeliveryStageRecord } from "@paperclipai/shared";
import { planDeliveryWork, wireDeliveryWork } from "./delivery-work-plan.js";
import { assertDeliveryGraph, readyDeliveryStages } from "./delivery-graph.js";
import { humanReviewInputDigest } from "./delivery-workflows.js";
const item=(key:string,type:string,parentKey="MAIN-1"):DeliveryWorkItem=>({key,type,parentKey,title:key,status:"待受理",assignee:"",scheduled:true});
const items=[item("DES-1","系统设计"),item("REV-1","设计评审"),item("FRONT-1","前端编码"),item("BACK-1","后端编码"),item("REV-2","代码评审"),item("REV-3","代码评审"),item("CASE-1","测试用例设计"),item("REV-4","测试用例评审"),item("TEST-1","功能测试")];
const definition=()=>structuredClone(DEFAULT_DELIVERY_TEMPLATE);
const config=():DeliveryWorkflowConfig=>({requestId:"request",snapshotId:"snapshot",analysisSeatId:"analysis",developmentSeatId:"dev",qaSeatId:"qa",designKey:"DES-1",codingKey:"",testCasesKey:"CASE-1",testExecutionKey:"TEST-1",environmentReference:"https://qa.example/build",codingTasks:[{jiraKey:"FRONT-1",seatId:"front"},{jiraKey:"BACK-1",seatId:"back"}],reviewTasks:[{stage:"design",jiraKey:"REV-1",workKeys:["DES-1"]},{stage:"coding",jiraKey:"REV-2",workKeys:["FRONT-1"],seatId:"review"},{stage:"coding",jiraKey:"REV-3",workKeys:["BACK-1"],seatId:"review"},{stage:"test-cases",jiraKey:"REV-4",workKeys:["CASE-1"]}]});
function records(c=config(),d=definition()) {
 return planDeliveryWork(c,d,items).map(w=>({stage:w.stage,intent:w.intent,executionMode:w.executionMode,reviewWorkKeys:w.reviewWorkKeys,jiraKey:w.key,taskId:w.key,state:"pending",receiptDigest:null,reviewerUserId:"owner"} as DeliveryStageRecord));
}
describe("ordered work and review nodes",()=>{
 it("fans out coding after the design review and joins every review before test cases",()=>{
  const stages=records();wireDeliveryWork(stages,definition());assertDeliveryGraph(stages);
  const ready=()=>readyDeliveryStages(stages).map(s=>s.jiraKey);
  const done=(key:string)=>{stages.find(s=>s.jiraKey===key)!.state="done";};
  expect(ready()).toEqual(["DES-1"]);done("DES-1");expect(ready()).toEqual(["REV-1"]);
  done("REV-1");expect(ready()).toEqual(["FRONT-1","BACK-1"]);
  done("FRONT-1");expect(ready()).toEqual(["BACK-1","REV-2"]);
  done("REV-2");done("BACK-1");expect(ready()).toEqual(["REV-3"]);
  stages.find(s=>s.jiraKey==="REV-3")!.state="interrupted";expect(ready()).not.toContain("CASE-1");
  done("REV-3");expect(ready()).toEqual(["CASE-1"]);done("CASE-1");expect(ready()).toEqual(["REV-4"]);done("REV-4");expect(ready()).toEqual(["TEST-1"]);
  expect(stages.find(s=>s.jiraKey==="REV-1")!.executionMode).toBe("human");expect(stages.find(s=>s.jiraKey==="REV-2")!.intent).toBe("code-review");
 });
 it("allows a shared explicit review only after all its work completes, with serial coding supported",()=>{
  const c=config();c.reviewTasks=c.reviewTasks!.filter(r=>r.stage!=="coding");c.reviewTasks.push({stage:"coding",jiraKey:"REV-2",workKeys:["FRONT-1","BACK-1"],seatId:"review"});
  const d=definition();d.codingExecution="serial";
  const stages=records(c,d);wireDeliveryWork(stages,d);assertDeliveryGraph(stages);
  expect(stages.find(s=>s.jiraKey==="BACK-1")!.dependsOn).toEqual(["FRONT-1"]);
  expect(stages.find(s=>s.jiraKey==="REV-2")!.dependsOn).toEqual(["FRONT-1","BACK-1"]);
 });
 it("rejects missing, duplicate, cross-parent, wrong-type or same-seat review bindings",()=>{
  const cases:Array<(c:DeliveryWorkflowConfig)=>void>=[
   c=>{c.reviewTasks=[];},
   c=>{c.reviewTasks![2].workKeys=["FRONT-1"];},
   c=>{c.reviewTasks![1].workKeys=["UNBOUND-1"];},
   c=>{c.reviewTasks![1].jiraKey="REV-1";},
   c=>{c.reviewTasks![1].seatId="front";},
   c=>{c.reviewTasks![1].seatId=undefined;},
  ];
  for(const change of cases){const c=config();change(c);expect(()=>planDeliveryWork(c,definition(),items)).toThrow();}
  expect(()=>planDeliveryWork(config(),definition(),items.map(i=>i.key==="REV-2"?{...i,parentKey:"MAIN-2"}:i))).toThrow(/主工单/);
 });
 it("keeps legacy definitions work-only and rejects hidden review bindings for disabled stages",()=>{
  const d=definition();Object.values(d.stages).forEach(s=>delete s.taskSequence);
  const c=config();c.reviewTasks=[];
  const stages=records(c,d);wireDeliveryWork(stages,d);expect(stages).toHaveLength(5);expect(stages.some(s=>s.intent)).toBe(false);
  d.stages.design.enabled=false;expect(()=>planDeliveryWork(config(),d,items)).toThrow(/停用/);
  expect(deliveryTemplateDefinitionSchema.safeParse({...d,stages:{...d.stages,design:{...d.stages.design,taskSequence:"review_then_work"}}}).success).toBe(false);
 });
 it("binds human review to all exact upstream versions, never a model exit or a stale digest",()=>{
  const stages=records();wireDeliveryWork(stages,definition());const review=stages.find(s=>s.jiraKey==="REV-1")!;const work=stages[0];
  expect(()=>humanReviewInputDigest({fingerprint:"source",stages},review)).toThrow();
  work.state="done";expect(()=>humanReviewInputDigest({fingerprint:"source",stages},review)).toThrow();
  work.receiptDigest="a".repeat(64);const digest=humanReviewInputDigest({fingerprint:"source",stages},review);
  work.receiptDigest="b".repeat(64);expect(humanReviewInputDigest({fingerprint:"source",stages},review)).not.toBe(digest);
  expect(humanReviewInputDigest({fingerprint:"changed",stages},review)).not.toBe(digest);
 });
 it("allows independently configured review execution and rejects empty work bindings",()=>{
  const d=definition();d.stages.design.review="none";d.stages.design.reviewExecution="agent";d.stages.design.reviewSeatId="11111111-1111-4111-8111-111111111111";expect(deliveryTemplateDefinitionSchema.safeParse(d).success).toBe(true);
  d.stages.coding.workExecution="human";d.stages.coding.workExecutorUserId="owner";expect(records(config(),d).find(s=>s.jiraKey==="FRONT-1")!.executionMode).toBe("human");
  expect(records(config(),d).find(s=>s.jiraKey==="REV-1")!.executionMode).toBeUndefined();
  d.stages.coding.reviewExecution="human";const manual=config();manual.reviewTasks!.filter(r=>r.stage==="coding").forEach(r=>delete r.seatId);
  const review=planDeliveryWork(manual,d,items).find(w=>w.key==="REV-2")!;expect(review.executionMode).toBe("human");expect(review.seatId).toBe("front");expect(review.executorUserId).toBe("owner");
  const bad={...config(),reviewTasks:[{stage:"coding",jiraKey:"REV-2",workKeys:[]}]};expect(deliveryWorkflowStartSchema.safeParse(bad).success).toBe(false);
 });
});
