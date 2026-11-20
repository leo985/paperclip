import { describe, expect, it } from "vitest";
import type { DeliverySnapshotInput } from "@paperclipai/shared";
import { normalizeDeliverySnapshot } from "./delivery-intake.js";
import { fixture } from "./delivery-intake.fixture.js";

describe("delivery source normalization",()=>{
  it("reads the production nested analysis and translated demand state, and distinguishes processed flags from rejection",()=>{
    const input=fixture();
    input.detailJson=JSON.stringify({success:true,code:"0",data:{demandDto:{urid:"1828643972046290945",demandNo:input.demandNo,demandStateTranslate:"待开发"},demandAnalysisDetailsDTO:{demandAnalysisDto:{analysisResult:"<p>已分析</p>"}},demandReviewStageDtoList:[{role:"需求分析人员",status:1},{role:"需求评审人员",status:1},{role:"项目经理验收",status:0}]}});
    expect(normalizeDeliverySnapshot(input).sourceAnalysis).toEqual({sourceStatus:"待开发",analysisSaved:true,reviewStages:[{role:"需求分析人员",status:"已处理"},{role:"需求评审人员",status:"已处理"}]});
    input.detailJson=input.detailJson.replaceAll('"status":1','"status":0');
    expect(normalizeDeliverySnapshot(input).sourceAnalysis?.reviewStages[1].status).toBe("未处理");
  });
  it("deduplicates month contexts and explains void and unscheduled issues without executing",()=>{
    const p=normalizeDeliverySnapshot(fixture());expect(p.scheduleCount).toBe(1);expect(p.items).toHaveLength(3);expect(p.differences.map(d=>d.code).sort()).toEqual(["jira_only","void"]);expect(p.executionAllowed).toBe(false);
  });
  it("recognizes a custom Jira Done status on the child independently of its parent", () => {
    const input = fixture();
    const jira = JSON.parse(input.jiraJson);
    jira.issues[0].fields.status = { name: "研发中", statusCategory: { key: "indeterminate" } };
    jira.issues[2].fields.status = { name: "测试通过待上线", statusCategory: { key: "done" } };
    input.jiraJson = JSON.stringify(jira);
    const facts = normalizeDeliverySnapshot(input).monthlyChildIssues!.issues;
    expect(facts["ATSES-1"]).toBeUndefined();
    expect(facts["ATSES-3"]).toMatchObject({ done: true, dueDate: null });
  });
  it("ignores unlinked Qingzhou child placeholders while preserving real children of a void main",()=>{
    const input=fixture();
    input.scheduleJsons=input.scheduleJsons.map(raw=>{const value=JSON.parse(raw);const main=value.data[0].children[0];main.status="已作废";main.children.push(...[null,"","  ",undefined].map(issueNo=>({issueNo,status:"待受理"})));return JSON.stringify(value);});
    const jira=JSON.parse(input.jiraJson);jira.issues[0].fields.status.name="已作废";input.jiraJson=JSON.stringify(jira);
    const plan=normalizeDeliverySnapshot(input);
    expect(plan.scheduleCount).toBe(1);
    expect(plan.items.map(i=>i.key)).toEqual(["ATSES-1","ATSES-2","ATSES-3"]);
    expect(plan.items.find(i=>i.key==="ATSES-3")?.status).toBe("已完成");
    expect(plan.items.find(i=>i.key==="ATSES-1")?.status).toBe("已作废");
    expect(plan.executionAllowed).toBe(false);
    expect(plan.differences.some(d=>!d.key)).toBe(false);
  });
  it("still rejects malformed nonempty child keys and unidentified main issues",()=>{
    for (const issueNo of ["NOT-A-KEY",123," ATSES-2 "]) {
      const input=fixture();input.scheduleJsons=input.scheduleJsons.map(raw=>{const value=JSON.parse(raw);value.data[0].children[0].children[0].issueNo=issueNo;return JSON.stringify(value);});
      expect(()=>normalizeDeliverySnapshot(input)).toThrow("Jira 工单编号无效");
    }
    const input=fixture();input.scheduleJsons=input.scheduleJsons.map(raw=>{const value=JSON.parse(raw);value.data[0].children[0].issueNo=null;return JSON.stringify(value);});
    expect(()=>normalizeDeliverySnapshot(input)).toThrow("Jira 工单编号无效");
  });
  it("preserves unquoted long integer identifiers losslessly",()=>{
    const input=fixture();input.demandJson=input.demandJson.replace('"1828643972046290945"','1828643972046290945');expect(normalizeDeliverySnapshot(input).demandId).toBe("1828643972046290945");
  });
  it("rejects truncated or failed responses",()=>{
    const input=fixture();input.jiraJson=input.jiraJson.replace('"total":3','"total":4');expect(()=>normalizeDeliverySnapshot(input)).toThrow("截断");
    const other=fixture();other.demandJson=other.demandJson.replace('"success":true','"success":false');expect(()=>normalizeDeliverySnapshot(other)).toThrow("失败");
  });
  it("rejects parent identity mismatches and contradictory months",()=>{
    const input=fixture();input.scheduleJsons[0]=input.scheduleJsons[0]!.replace('"parentId":"1846012231615135745"','"parentId":"1846012231606747137"');expect(()=>normalizeDeliverySnapshot(input)).toThrow("父子");
    const other=fixture();other.scheduleJsons[1]=other.scheduleJsons[1]!.replace('"status":"已完成"','"status":"待开发"');expect(()=>normalizeDeliverySnapshot(other)).toThrow("冲突");
  });
  it("records in-demand parent drift as a difference while retaining the Jira tree",()=>{
    const input=fixture();
    const analysis=JSON.parse(input.analysisJson);analysis.data.demandIssuePoList.push({...analysis.data.demandIssuePoList[0],urid:"2",itemNo:"ATSES-4"});input.analysisJson=JSON.stringify(analysis);
    const jira=JSON.parse(input.jiraJson);jira.issues[0].fields.subtasks=[{key:"ATSES-3"}];jira.issues[1].fields.parent.key="ATSES-4";jira.issues.push({key:"ATSES-4",fields:{summary:"第二主单",issuetype:{name:"需求",subtask:false},status:{name:"处理中"},subtasks:[{key:"ATSES-2"}]}});jira.total++;input.jiraJson=JSON.stringify(jira);
    const plan=normalizeDeliverySnapshot(input);
    expect(plan.items.find(i=>i.key==="ATSES-2")?.parentKey).toBe("ATSES-4");
    expect(plan.differences).toContainEqual({code:"parent_mismatch",key:"ATSES-2",message:expect.stringContaining("轻舟排期父工单为 ATSES-1，Jira 父工单为 ATSES-4")});
    jira.issues[1].fields.parent.key="OTHER-1";input.jiraJson=JSON.stringify(jira);
    expect(()=>normalizeDeliverySnapshot(input)).toThrow("混入其他需求");
  });
  it("requires all declared Jira children",()=>{
    const input=fixture();const jira=JSON.parse(input.jiraJson);jira.issues.pop();jira.total--;input.jiraJson=JSON.stringify(jira);expect(()=>normalizeDeliverySnapshot(input)).toThrow("完整返回");
  });
  it("has stable fingerprints, and changes them when source evidence changes",()=>{
    const input=fixture();const prior=normalizeDeliverySnapshot(input);expect(normalizeDeliverySnapshot(input).fingerprint).toBe(prior.fingerprint);input.analysisJson=input.analysisJson.replace('"del":0','"extraEvidence":"v2","del":0');expect(normalizeDeliverySnapshot(input).fingerprint).not.toBe(prior.fingerprint);
  });
  it("accepts null task lists as empty schedules without hiding Jira children",()=>{
    const input=fixture();input.scheduleJsons=input.scheduleJsons.map(raw=>{const value=JSON.parse(raw);value.data[0].children[0].children=null;return JSON.stringify(value)});
    const plan=normalizeDeliverySnapshot(input);expect(plan.scheduleCount).toBe(0);expect(plan.items).toHaveLength(3);expect(plan.items.filter(x=>x.parentKey)).toHaveLength(2);expect(plan.differences.filter(x=>x.code==="jira_only")).toHaveLength(2);expect(plan.executionAllowed).toBe(false);
    const empty=fixture();empty.scheduleJsons=empty.scheduleJsons.map(raw=>{const value=JSON.parse(raw);value.data[0].children=null;return JSON.stringify(value)});
    expect(normalizeDeliverySnapshot(empty).scheduleCount).toBe(0);
  });
  it("continues rejecting malformed non-null task containers",()=>{
    for(const children of [{},"",0]){
      const input=fixture();input.scheduleJsons=input.scheduleJsons.map(raw=>{const value=JSON.parse(raw);value.data[0].children[0].children=children;return JSON.stringify(value)});
      expect(()=>normalizeDeliverySnapshot(input)).toThrow("子工单数组");
    }
  });

  it("keeps source analysis and translated review facts without treating them as admission",()=>{
    const input=fixture();
    input.detailJson=JSON.stringify({success:true,code:"0",data:{demandDto:{urid:"1828643972046290945",demandNo:input.demandNo,demandState_show:"待开发"},demandAnalysisDetailsDTO:{analysisResult:"<p>分析内容</p>"},demandReviewStageDtoList:[{role:"需求负责人",status:"1",statusTranslate:"通过"}]}});
    const plan=normalizeDeliverySnapshot(input);
    expect(plan.sourceAnalysis).toEqual({sourceStatus:"待开发",analysisSaved:true,reviewStages:[{role:"需求负责人",status:"通过"}]});
    expect(plan.executionAllowed).toBe(false);
    const before=plan.fingerprint;input.detailJson=input.detailJson.replace("通过","未通过");
    expect(normalizeDeliverySnapshot(input).fingerprint).not.toBe(before);
  });
  it("keeps legacy snapshots and missing analysis details unknown",()=>{
    const input=fixture();expect(normalizeDeliverySnapshot(input).sourceAnalysis).toBeUndefined();
    const data={demandDto:{urid:"1828643972046290945",demandNo:input.demandNo}};
    input.detailJson=JSON.stringify({success:true,code:"0",data});
    expect(normalizeDeliverySnapshot(input).sourceAnalysis).toEqual({sourceStatus:"",analysisSaved:null,reviewStages:[]});
    input.detailJson=JSON.stringify({success:true,code:"0",data:{...data,demandAnalysisDetailsDTO:{analysisResult:"<p>&nbsp;</p>"}}});
    expect(normalizeDeliverySnapshot(input).sourceAnalysis?.analysisSaved).toBe(false);
  });
  it("rejects unrelated details, invalid review lists and changes during source reads",()=>{
    for(const data of [
      {demandDto:{urid:"2",demandNo:"OTHER-1"}},
      {demandDto:{urid:"1828643972046290945",demandNo:"ATS3-00156"},demandReviewStageDtoList:{}},
      {demandDto:{urid:"1828643972046290945",demandNo:"ATS3-00156"},demandReviewStageDtoList:[null]},
      {demandDto:{urid:"1828643972046290945",demandNo:"ATS3-00156",demandState_show:"待评审"}},
    ]) {
      const input=fixture();const demand=JSON.parse(input.demandJson);demand.rows[0].demandState_show="待开发";input.demandJson=JSON.stringify(demand);
      input.detailJson=JSON.stringify({success:true,code:"0",data});expect(()=>normalizeDeliverySnapshot(input)).toThrow();
    }
  });
});
