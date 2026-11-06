import { describe, expect, it } from "vitest";
import { BUILTIN_DELIVERY_TEMPLATE, type DeliveryEntryCheck } from "@paperclipai/shared";
import { evaluateDeliveryChainAdmission } from "./delivery-chain-admission.js";
import { normalizeDeliverySnapshot } from "./delivery-intake.js";
import { fixture } from "./delivery-intake.fixture.js";
const facts = {analysisPublished:false,evidence:null};
const plan = normalizeDeliverySnapshot(fixture());
function template(checks: DeliveryEntryCheck[]) {
  const value = structuredClone(BUILTIN_DELIVERY_TEMPLATE);
  value.definition.stages.design.entryChecks = checks;
  return value;
}
describe("delivery chain entry checks",()=>{
  it("checks the configured environment reference only when selected",()=>{
    const value=template(["environment_reference"]);
    expect(evaluateDeliveryChainAdmission(plan,value,facts).ready).toBe(false);
    expect(evaluateDeliveryChainAdmission(plan,value,{...facts,environmentReference:"https://example.com/test-build"}).ready).toBe(true);
  });
  it("uses only the first enabled stage, without requiring downstream coding evidence",()=>{
    const value = template(["title"]);
    value.definition.stages.coding.entryChecks=["design_approved"];
    expect(evaluateDeliveryChainAdmission(plan,value,facts)).toMatchObject({ready:true,state:"ready",startStage:"design",checks:[{key:"title",passed:true}]});
    value.definition.stages.analysis.enabled=true;
    expect(evaluateDeliveryChainAdmission(plan,value,facts)).toMatchObject({ready:false,state:"unconfigured",startStage:"analysis"});
    value.definition.stages.analysis.entryChecks=["title","entry_task"];
    expect(evaluateDeliveryChainAdmission(plan,value,facts).ready).toBe(true);
  });
  it("requires all selected conditions, treats absent input as failing, and does not use other owners",()=>{
    const value=template(["title","owner","main_issue","entry_task","source_consistent"]);
    const result=evaluateDeliveryChainAdmission({...plan,roles:[{label:"条目当前经办人",name:"Someone"}]},value,facts);
    expect(result.checks).toEqual(expect.arrayContaining([{key:"owner",label:"需求拆分人员已指定",passed:false},{key:"entry_task",label:expect.any(String),passed:false},{key:"source_consistent",label:expect.any(String),passed:false}]));
    const clean={...plan,roles:[{label:"条目研发负责人",name:"Splitter"}],differences:[],items:[...plan.items,{...plan.items[1]!,type:"系统设计"}]};
    expect(evaluateDeliveryChainAdmission(clean,value,facts).ready).toBe(true);
  });
  it("does not infer formal approval from downstream source progress or a closed review task",()=>{
    const value=template(["analysis_approved","design_approved"]);
    expect(evaluateDeliveryChainAdmission({...plan,status:"全部交付"},value,facts).ready).toBe(false);
    expect(evaluateDeliveryChainAdmission(plan,value,{...facts,analysisPublished:true}).checks).toMatchObject([{passed:true},{passed:false}]);
    const evidence={analysisReference:"https://example.com/analysis",designReference:"https://example.com/design",designRequired:true,note:"Checked",checkedBy:"admin",checkedAt:new Date().toISOString()};
    expect(evaluateDeliveryChainAdmission(plan,value,{analysisPublished:false,evidence}).ready).toBe(true);
    expect(evaluateDeliveryChainAdmission(plan,value,{analysisPublished:true,evidence:{...evidence,designRequired:false,designReference:""}}).ready).toBe(false);
  });
  it("does not treat unconfigured or empty legacy rules as admission",()=>{
    const value=template([]);
    expect(evaluateDeliveryChainAdmission(plan,value,facts).state).toBe("unconfigured");
    delete value.definition.stages.design.entryChecks;
    expect(evaluateDeliveryChainAdmission(plan,value,facts).ready).toBe(false);
  });
});
