import {describe,expect,it} from "vitest";
import {deliveryWorkflowActions} from "./delivery-workflow-actions.js";
import type {deliveryWorkflows} from "@paperclipai/db";
type Flow=typeof deliveryWorkflows.$inferSelect;
const node=(taskId:string,extra:Record<string,unknown>={})=>({taskId,stage:"design",state:"review",executionMode:"human",reviewerUserId:"reviewer",ownerUserId:"owner",dependsOn:[],inputDigest:"a".repeat(64),...extra});
const flow=(stages:ReturnType<typeof node>[],extra:Record<string,unknown>={})=>({id:"flow",projectId:"project",snapshotId:"snapshot",demandNo:"ENTRY-1",state:"active",createdBy:"admin",updatedAt:new Date("2026-11-17"),stages,...extra}) as unknown as Flow;
describe("delivery workflow action projection",()=>{
 it("advertises human work only after activation and completion of all dependencies",()=>{
  const f=flow([node("up",{state:"running",executionMode:undefined}),node("human",{dependsOn:["up"]})]);
  expect(deliveryWorkflowActions(f)).toEqual([]);
  f.stages[0].state="done";f.stages[1].state="pending";expect(deliveryWorkflowActions(f)).toEqual([]);
  f.stages[1].state="review";
  expect(deliveryWorkflowActions(f)).toEqual([expect.objectContaining({taskId:"human",kind:"work",ownerUserId:"reviewer",actionLabel:"提交人工交付",href:expect.stringContaining("#delivery-node-human")})]);
 });
 it("distinguishes human review, Agent verification, start confirmation and questions",()=>{
  const f=flow([node("review",{reviewWorkKeys:["WORK-1"]}),node("agent",{executionMode:undefined,requiresReview:true,receiptDigest:"a"}),node("start",{state:"pending",startMode:"confirmation"}),node("question",{state:"waiting",question:{text:"请确认",digest:"q"}})]);
  expect(deliveryWorkflowActions(f).map(a=>[a.taskId,a.kind,a.ownerUserId])).toEqual([["review","review","reviewer"],["agent","review","reviewer"],["start","confirm-start","owner"],["question","answer","owner"]]);
 });
 it("withdraws old decisions on rejection and ignores completed and reused nodes",()=>{
  const f=flow([node("old",{review:{decision:"reject"}}),node("next")]);expect(deliveryWorkflowActions(f)).toEqual([]);
  expect(deliveryWorkflowActions(flow([node("done",{state:"done"}),node("reuse",{priorCompletion:{version:"old"}})]))).toEqual([]);
 });
 it("handles acceptance and blocking separately and stops tasks after instance closure",()=>{
  expect(deliveryWorkflowActions(flow([],{state:"acceptance"}))[0]).toMatchObject({kind:"accept",ownerUserId:"admin"});
  expect(deliveryWorkflowActions(flow([],{state:"blocked",message:"原因"}))[0]).toMatchObject({kind:"recovery",reason:"原因"});
  for(const state of ["cancelled","completed"])expect(deliveryWorkflowActions(flow([node("work")],{state}))).toEqual([]);
 });
 it("keeps analysis in its existing publication and question workflow",()=>{
  expect(deliveryWorkflowActions(flow([node("analysis",{stage:"analysis"})]))).toEqual([]);
 });
});

it("waits for a verifiable result and supports existing legacy review ownership",()=>{
 expect(deliveryWorkflowActions(flow([node("missing",{inputDigest:null})]))).toEqual([]);
 expect(deliveryWorkflowActions(flow([node("old",{executionMode:undefined,requiresReview:undefined,reviewerUserId:undefined,receiptDigest:"digest"})]))[0]).toMatchObject({kind:"review",ownerUserId:"owner"});
});

it("does not offer start confirmation while a reworked node awaits its new input version",()=>{
 const f=flow([node("start",{state:"pending",startMode:"confirmation",inputDigest:""})]);
 expect(deliveryWorkflowActions(f)).toEqual([]);
 f.stages[0].inputDigest="a".repeat(64);
 expect(deliveryWorkflowActions(f).map(action=>action.kind)).toEqual(["confirm-start"]);
});
