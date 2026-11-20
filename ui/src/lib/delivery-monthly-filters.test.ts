import { describe, expect, it } from "vitest";
import type { DeliveryMonthlyEntries, DeliveryChainAdmission } from "@paperclipai/shared";
import { normalizeMonthlyFilters, clearMonthlyFilters, filterMonthlyEntries, monthlyDetailHref, monthlySourceOptions, sourceFilterValue, managementToday, monthlyRisks, monthlyNextAction, monthlyProgress, monthlyProgressViews, monthlyFilterKeys } from "./delivery-monthly-filters";
const item: DeliveryMonthlyEntries["items"][number] = {demandNo:"ATS3-00001",title:"权限管理",owner:"李巍",sourceStatus:"开发中",startDate:"2026-10-01",endDate:"2026-10-31",workCount:2,snapshotId:null,admission:null};
describe("monthly delivery filters",()=>{
  it("filters overlapping schedule/delivery memberships and does not label unknown work counts as zero work",()=>{
    const scheduled={...item,demandNo:"SCHED-1",inSchedule:true,inExpectedDeliveryMonth:false};
    const both={...item,demandNo:"BOTH-1",inSchedule:true,inExpectedDeliveryMonth:true};
    const expected={...item,demandNo:"TWGF-00919",inSchedule:false,inExpectedDeliveryMonth:true,workCount:0,workCountKnown:false};
    const rows=[scheduled,both,expected];
    expect(filterMonthlyEntries(rows,new URLSearchParams({mScope:"scheduled"})).map(x=>x.demandNo).sort()).toEqual(["BOTH-1","SCHED-1"]);
    expect(filterMonthlyEntries(rows,new URLSearchParams({mScope:"expected"})).map(x=>x.demandNo).sort()).toEqual(["BOTH-1","TWGF-00919"]);
    expect(filterMonthlyEntries(rows,new URLSearchParams())).toHaveLength(3);
    expect(filterMonthlyEntries([expected],new URLSearchParams({mWork:"none"}))).toEqual([]);
    expect(clearMonthlyFilters(new URLSearchParams({mScope:"expected",month:"2026-11"})).toString()).toBe("month=2026-11");
  });
  it("combines analysis owner with other filters across the entire month and preserves it in links",()=>{
    const rows=Array.from({length:25},(_,index)=>({...item,demandNo:`ATS3-${index}`,analysisOwner:index===24?" 分析人员 ":"其他分析人员"}));
    const params=new URLSearchParams({projectId:"p",month:"2026-10",mAnalysisOwner:sourceFilterValue("分析人员"),mOwner:sourceFilterValue(item.owner),mStatus:sourceFilterValue(item.sourceStatus)});
    expect(filterMonthlyEntries(rows,params).map(row=>row.demandNo)).toEqual(["ATS3-24"]);
    expect(new URLSearchParams(monthlyDetailHref(params,"p","s","2026-10").split("?")[1]).get("mAnalysisOwner")).toBe(params.get("mAnalysisOwner"));
    expect(clearMonthlyFilters(params).toString()).toBe("projectId=p&month=2026-10");
    params.set("mOwner",sourceFilterValue("其他负责人"));
    expect(filterMonthlyEntries(rows,params)).toEqual([]);
  });
  it("offers distinct missing analysis owners, trims and deduplicates options, and searches names",()=>{
    const rows=[item,{...item,demandNo:"2",analysisOwner:" "},{...item,demandNo:"3",analysisOwner:"来源未提供"},{...item,demandNo:"4",analysisOwner:" 分析人员 "},{...item,demandNo:"5",analysisOwner:"分析人员"}];
    expect(monthlySourceOptions(rows,"analysisOwner")).toHaveLength(3);
    expect(filterMonthlyEntries(rows,new URLSearchParams({mAnalysisOwner:sourceFilterValue("")}))).toEqual([rows[1],rows[0]]);
    expect(filterMonthlyEntries(rows,new URLSearchParams({mAnalysisOwner:sourceFilterValue("来源未提供")}))).toEqual([rows[2]]);
    expect(filterMonthlyEntries(rows,new URLSearchParams({mq:"分析人员"}))).toHaveLength(2);
  });
  it("migrates retired shortcuts into visible admission and sync controls",()=>{
    expect(normalizeMonthlyFilters(new URLSearchParams({mRisk:"entry_unconfigured"})).toString()).toBe("mAdmission=unconfigured");
    expect(normalizeMonthlyFilters(new URLSearchParams({mRisk:"admission"})).toString()).toBe("mAdmission=pending");
    expect(normalizeMonthlyFilters(new URLSearchParams({mAdmission:"unchecked"})).get("mAdmission")).toBe("pending");
    const oldSync=new URLSearchParams({mAdmission:"unsynced",mSync:"saved",month:"2026-11"});
    const migrated=normalizeMonthlyFilters(oldSync);
    expect(migrated.has("mAdmission")).toBe(false);
    expect(migrated.get("mSync")).toBe("unsynced");
    expect(migrated.get("month")).toBe("2026-11");
    expect(oldSync.get("mSync")).toBe("saved");
    expect(filterMonthlyEntries([item],oldSync)).toEqual([item]);
  });
  it("clears every filter including repeated statuses while preserving navigation context",()=>{
    const params=new URLSearchParams({projectId:"p",month:"2026-11",view:"monthly",mRisk:"past_plan",mSort:"start",mAdmission:"pending",mq:"权限"});
    params.append("mStatus",sourceFilterValue("开发中"));params.append("mStatus",sourceFilterValue("已完成"));
    const cleared=clearMonthlyFilters(params);
    expect([...cleared.keys()]).toEqual(["projectId","month","view"]);
    expect(params.getAll("mStatus")).toHaveLength(2);
  });

  it("partitions source progress without treating cancellation, closure or unknown states as completion",()=>{
    expect(monthlyProgress({...item,sourceStatus:"全部交付"})).toBe("completed");
    expect(monthlyProgress({...item,sourceStatus:"部分交付"})).toBe("in_progress");
    const statuses=["已完成","已发版","已上线","已验收","待需求分析","未开始","待开发","开发中","待测试","需求评审不通过","已挂起","已作废","已关闭","","未知状态","  done  "];
    const rows=statuses.map((sourceStatus,index)=>({...item,demandNo:`row-${index}`,sourceStatus}));
    expect(rows.map(monthlyProgress)).toEqual(["completed","completed","completed","completed","not_started","not_started","in_progress","in_progress","in_progress","in_progress","in_progress","unknown","unknown","unknown","unknown","completed"]);
    const groups=monthlyProgressViews.filter(([key])=>key!=="all").map(([key])=>filterMonthlyEntries(rows,new URLSearchParams({mProgress:key})));
    expect(groups.flat()).toHaveLength(rows.length);
    expect(new Set(groups.flat().map(row=>row.demandNo)).size).toBe(rows.length);
  });
  it("combines progress with risk and source filters before paging and preserves progress in detail links",()=>{
    const rows=Array.from({length:30},(_,index)=>({...item,demandNo:`row-${index}`,sourceStatus:index===29?"已完成":"未开始",endDate:"2026-10-01"}));
    const params=new URLSearchParams({mProgress:"completed",mRisk:"past_plan",mOwner:sourceFilterValue(item.owner)});
    expect(filterMonthlyEntries(rows,params,new Date("2026-11-01T00:00:00Z")).map(row=>row.demandNo)).toEqual(["row-29"]);
    expect(new URLSearchParams(monthlyDetailHref(params,"p","s","2026-10").split("?")[1]).get("mProgress")).toBe("completed");
    expect(monthlyFilterKeys).toContain("mProgress");
    params.set("mStatus",sourceFilterValue("未开始"));
    expect(filterMonthlyEntries(rows,params)).toEqual([]);
  });
  it("filters normal entries as the complement of all risk signals and combines source filters",()=>{
    const now=new Date("2026-10-27T08:00:00Z");
    const normal={...item,snapshotId:"s",endDate:"2026-11-30",chainAdmission:{state:"ready",ready:true,template:null,startStage:"analysis",checks:[],reasons:[]} as DeliveryChainAdmission};
    const rows=[normal,{...normal,demandNo:"missing-owner",owner:""},{...normal,demandNo:"past-and-owner",owner:"",endDate:"2026-10-01"},{...normal,demandNo:"due",endDate:"2026-10-31"},{...normal,demandNo:"date",endDate:""},{...normal,demandNo:"admission",chainAdmission:undefined},{...normal,demandNo:"unconfigured",chainAdmission:{...normal.chainAdmission,state:"unconfigured",ready:false} as DeliveryChainAdmission}];
    expect(monthlyRisks(normal,now)).toEqual([]);
    const params=new URLSearchParams({mRisk:"normal"});
    expect(filterMonthlyEntries(rows,params,now).map(row=>row.demandNo)).toEqual(["admission",normal.demandNo,"unconfigured"]);
    params.set("mOwner",sourceFilterValue("其他人"));
    expect(filterMonthlyEntries(rows,params,now)).toEqual([]);
    expect(new URLSearchParams(monthlyDetailHref(new URLSearchParams({mRisk:"normal"}),"p","s","2026-10").split("?")[1]).get("mRisk")).toBe("normal");
  });
  it("uses chain admission independently of coding evidence and distinguishes unconfigured templates",()=>{
    const codingReady={...item,snapshotId:"s",admission:{ready:true,reasons:[],analysisExecutionId:null,evidence:null}};
    expect(filterMonthlyEntries([codingReady],new URLSearchParams({mAdmission:"pending"}))).toEqual([codingReady]);
    const admitted={...codingReady,chainAdmission:{state:"admitted",ready:true,template:null,startStage:null,checks:[],reasons:[]} as DeliveryChainAdmission};
    expect(monthlyRisks(admitted)).not.toContain("admission");
    const unconfigured={...codingReady,chainAdmission:{...admitted.chainAdmission,state:"unconfigured",ready:false} as DeliveryChainAdmission};
    expect(filterMonthlyEntries([unconfigured],new URLSearchParams({mAdmission:"pending"}))).toEqual([]);
    expect(monthlyRisks(unconfigured)).not.toContain("admission");
    expect(filterMonthlyEntries([unconfigured,admitted],new URLSearchParams({mAdmission:"unconfigured"}))).toEqual([unconfigured]);
  });
  it("combines conditions across the entire month before pagination",()=>{
    const rows=Array.from({length:25},(_,index)=>({...item,demandNo:`ATS3-${index}`,owner:index===24?"目标负责人":"其他人"}));
    const params=new URLSearchParams({mOwner:sourceFilterValue("目标负责人"),mStatus:sourceFilterValue("开发中"),mSync:"unsynced",mWork:"has",mq:"权限"});
    expect(filterMonthlyEntries(rows,params).map(i=>i.demandNo)).toEqual(["ATS3-24"]);
    params.set("mWork","none");expect(filterMonthlyEntries(rows,params)).toEqual([]);
  });
  it("keeps unverified records distinct from checked admission and unsynced entries",()=>{
    const rows=[item,{...item,demandNo:"ATS3-2",snapshotId:"snapshot-2",chainAdmission:{ready:false,state:"blocked",template:null,startStage:"analysis",checks:[],reasons:["待核对"]} as DeliveryChainAdmission,admission:{ready:false,reasons:["待核对"],analysisExecutionId:null,evidence:null}},{...item,demandNo:"ATS3-3",snapshotId:"snapshot-3",chainAdmission:{ready:true,state:"ready",template:null,startStage:"analysis",checks:[],reasons:[]} as DeliveryChainAdmission,admission:{ready:true,reasons:[],analysisExecutionId:null,evidence:null}}];
    expect(filterMonthlyEntries(rows,new URLSearchParams({mAdmission:"pending"})).map(i=>i.demandNo)).toEqual(["ATS3-00001","ATS3-2"]);
    expect(filterMonthlyEntries(rows,new URLSearchParams({mAdmission:"verified"})).map(i=>i.demandNo)).toEqual(["ATS3-3"]);
    expect(filterMonthlyEntries(rows,new URLSearchParams({mAdmission:"unsynced"}))).toEqual([item]);
  });
  it("supports missing source fields without colliding with literal source values",()=>{
    const rows=[{...item,owner:"",sourceStatus:""},{...item,owner:"来源未提供"}];
    expect(monthlySourceOptions(rows,"owner")).toHaveLength(2);
    expect(filterMonthlyEntries(rows,new URLSearchParams({mOwner:sourceFilterValue("")}))).toEqual([rows[0]]);
    expect(filterMonthlyEntries(rows,new URLSearchParams({mStatus:sourceFilterValue("已完成")}))).toEqual([]);
  });
  it("preserves project, month and filters on detail navigation and sorts without mutating input",()=>{
    const params=new URLSearchParams({mq:"权限",mSync:"saved",mOwner:sourceFilterValue("李巍"),month:"2026-10"});
    const href=monthlyDetailHref(params,"project-1","snapshot-1","2026-10");
    const detail=new URLSearchParams(href.split("?")[1]);
    expect(detail.get("mOwner")).toBe(params.get("mOwner"));expect(detail.get("mq")).toBe("权限");expect(detail.get("month")).toBe("2026-10");expect(detail.get("snapshotId")).toBe("snapshot-1");expect(detail.get("projectId")).toBe("project-1");expect(params.has("snapshotId")).toBe(false);
    const rows=[{...item,startDate:""},{...item,demandNo:"ATS3-2",startDate:"2026-10-01"}];
    expect(filterMonthlyEntries(rows,new URLSearchParams({mSort:"start"}))[0]?.demandNo).toBe("ATS3-2");expect(rows[0]?.startDate).toBe("");
  });
  it("matches any selected source status and preserves repeated statuses in detail links",()=>{
    const rows=[item,{...item,demandNo:"ATS3-2",sourceStatus:"已完成"},{...item,demandNo:"ATS3-3",sourceStatus:"已发版"}];
    const params=new URLSearchParams({mStatus:sourceFilterValue("开发中")});params.append("mStatus",sourceFilterValue("已完成"));
    expect(filterMonthlyEntries(rows,params).map(i=>i.demandNo)).toEqual(["ATS3-00001","ATS3-2"]);
    const linked=new URLSearchParams(monthlyDetailHref(params,"p","s","2026-10").split("?")[1]);
    expect(linked.getAll("mStatus")).toEqual(params.getAll("mStatus"));
    params.delete("mStatus");expect(filterMonthlyEntries(rows,params)).toHaveLength(3);
  });
});


describe("management schedule signals", () => {
  const now = new Date("2026-10-27T08:00:00Z");
  it("uses Shanghai calendar days around UTC midnight", () => {
    expect(managementToday(new Date("2026-10-26T16:01:00Z"))).toBe("2026-10-27");
    expect(monthlyRisks({...item,endDate:"2026-10-26"}, new Date("2026-10-26T16:01:00Z"))).toContain("past_plan");
    expect(monthlyRisks({...item,endDate:"2026-10-27"}, now)).not.toContain("past_plan");
  });
  it("includes today through Sunday, and never next Monday, in this week's due dates", () => {
    expect(monthlyRisks({...item,endDate:"2026-11-01"}, now)).toContain("due_week");
    expect(monthlyRisks({...item,endDate:"2026-11-02"}, now)).not.toContain("due_week");
    expect(monthlyRisks({...item,endDate:"2026-10-26"}, now)).not.toContain("due_week");
  });
  it("marks missing or invalid dates as unknown and missing owner separately", () => {
    const risks = monthlyRisks({...item,owner:"  ",endDate:"2026-02-30"}, now);
    expect(risks).toContain("missing_date"); expect(risks).toContain("missing_owner"); expect(risks).not.toContain("past_plan");
    expect(monthlyNextAction({...item,owner:""},now)).toContain("补齐责任人");
  });
  it("filters the full result before paging and combines risk with source filters", () => {
    const rows = Array.from({length:30},(_,i)=>({...item,demandNo:`DEV-${i}`,endDate:i===29?"2026-10-26":"2026-11-30"}));
    const params = new URLSearchParams({mRisk:"past_plan",mOwner:sourceFilterValue("李巍")});
    expect(filterMonthlyEntries(rows,params,now).map(r=>r.demandNo)).toEqual(["DEV-29"]);
    expect(rows[0].demandNo).toBe("DEV-0");
  });
  it("prioritizes schedule attention and offers independent deadline or start sorting", () => {
    const rows=[{...item,demandNo:"future",startDate:"2026-01-01",endDate:"2026-12-01"},{...item,demandNo:"past",startDate:"2026-10-20",endDate:"2026-10-21"},{...item,demandNo:"missing",endDate:"",owner:""}];
    expect(filterMonthlyEntries(rows,new URLSearchParams({mSort:"risk"}),now)[0].demandNo).toBe("past");
    expect(filterMonthlyEntries(rows,new URLSearchParams({mSort:"deadline"}),now).map(i=>i.demandNo)).toEqual(["past","future","missing"]);
    expect(filterMonthlyEntries(rows,new URLSearchParams({mSort:"start"}),now)[0].demandNo).toBe("future");
  });
  it("places malformed and empty source dates after valid dates", () => {
    const rows = [{...item,demandNo:"invalid",endDate:"2026-02-30"},{...item,demandNo:"valid",endDate:"2026-10-31"},{...item,demandNo:"empty",endDate:""}];
    expect(filterMonthlyEntries(rows,new URLSearchParams({mSort:"deadline"}),now).map(i=>i.demandNo)).toEqual(["valid","empty","invalid"]);
  });
  it("preserves risk and sorting through detail navigation without implying formal delay", () => {
    const params = new URLSearchParams({mRisk:"past_plan",mSort:"deadline"});
    const result = new URLSearchParams(monthlyDetailHref(params,"p","s","2026-10").split("?")[1]);
    expect(result.get("mRisk")).toBe("past_plan"); expect(result.get("mSort")).toBe("deadline");
    expect(monthlyNextAction({...item,endDate:"2026-10-26"},now)).toContain("核对最新来源和正式交付结论");
  });
});
