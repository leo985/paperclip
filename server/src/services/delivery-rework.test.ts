import { describe, expect, it } from "vitest";
import type { DeliveryStageRecord } from "@paperclipai/shared";
import { deliveryReworkScope } from "./delivery-rework.js";
const node=(taskId:string,dependsOn:string[]=[],extra:Partial<DeliveryStageRecord>={}):DeliveryStageRecord=>({taskId,dependsOn,stage:"coding",seatId:"seat",ownerUserId:"owner",jiraKey:taskId,dispatchId:"dispatch",state:"done",runId:null,capabilityId:null,registryRevision:null,inputDigest:"",receipt:null,receiptDigest:null,review:null,message:null,...extra});
describe("delivery review rework dependency closure",()=>{
  it("invalidates the exact reviewed branch and join while retaining independent parallel work",()=>{
    const frontend=node("FE-1"),backend=node("BE-1"),feReview=node("REV-1",["FE-1"],{reviewWorkKeys:["FE-1"]}),beReview=node("REV-2",["BE-1"],{reviewWorkKeys:["BE-1"]}),qa=node("QA-1",["REV-1","REV-2"]);
    expect(deliveryReworkScope([frontend,backend,feReview,beReview,qa],feReview).map(s=>s.taskId)).toEqual(["FE-1","REV-1","QA-1"]);
  });
  it("reopens every explicitly bound work item for shared review and its downstream reviews",()=>{
    const stages=[node("FE-1"),node("BE-1"),node("REV-1",["FE-1","BE-1"],{reviewWorkKeys:["FE-1","BE-1"]}),node("QA-1",["REV-1"])];
    expect(deliveryReworkScope(stages,stages[2])).toEqual(stages);
    expect(()=>deliveryReworkScope(stages,{...stages[2],reviewWorkKeys:["MISSING-1"]})).toThrow(/原工作单/);
  });
});
