// @vitest-environment jsdom
import { useState, type ReactNode } from "react";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DeliveryEntryDetail, DeliveryStageRecord, DeliveryWorkflow, DeliveryWorkItem } from "@paperclipai/shared";
import { deliveryEntryStageRows, sourceAnalysisRoleName, sourceEntryStage, sourceAnalysisStatus, sourceDesignStatus, sourceCodingStatus, type EntryStageId } from "@/lib/delivery-entry-stages";
import { DeliveryEntryStages } from "./DeliveryEntryStages";
vi.mock("@/lib/router",()=>({Link:({to,children,...props}:{to:string;children:ReactNode})=><a href={to} {...props}>{children}</a>}));
const item=(key:string,type:string,extra:Partial<DeliveryWorkItem>={}):DeliveryWorkItem=>({key,type,parentKey:"MAIN-1",title:key+" 标题",status:"待受理",assignee:"研发甲",scheduled:true,...extra});
const detail:DeliveryEntryDetail={snapshot:{id:"snapshot-1",projectId:"project-1",demandNo:"ATS3-00156",collectedAt:"2026-10-26",createdAt:"2026-10-26",sourceOrigin:"qingzhou",plan:{demandId:"1",demandNo:"ATS3-00156",title:"条目",status:"开发中",roles:[],mains:[],scheduleCount:1,differences:[],fingerprint:"test",sourceMode:"online_readonly",executionAllowed:false,items:[item("MAIN-1","产品功能需求",{parentKey:null}),item("DESIGN-1","系统设计"),item("CODE-1","编码",{status:"已完成"}),item("REVIEW-1","代码评审"),item("CASE-1","测试用例设计"),item("CASE-REVIEW-1","测试用例评审"),item("QA-1","功能测试"),item("OTHER-1","发布支持")]}},admission:{ready:false,reasons:[],analysisExecutionId:null,evidence:null},analyses:[{id:"analysis-old",title:"旧版分析",state:"published",revision:1,activeRunId:null,updatedAt:"2026-10-25"},{id:"analysis-new",title:"新版分析",state:"waiting",revision:2,activeRunId:null,updatedAt:"2026-10-26"}],tasks:[{id:"code-task",jiraKey:"CODE-1",title:"编码执行",status:"done",runStatus:"succeeded",updatedAt:"2026-10-26"},{id:"qa-task",jiraKey:"QA-1",title:"功能测试执行",status:"in_progress",runStatus:"running",updatedAt:"2026-10-26"}]};
let cleanup:(()=>void)|undefined;
afterEach(()=>{cleanup?.();cleanup=undefined;});
type StageFixture = { detail: DeliveryEntryDetail; workflow?: DeliveryWorkflow; selectedStage?: EntryStageId; onSelectStage?: (stage: EntryStageId) => void };
function StageOverview({ detail, workflow, selectedStage, onSelectStage }: StageFixture) {
  const [selected, setSelected] = useState(selectedStage);
  return <DeliveryEntryStages
    snapshot={detail.snapshot}
    stages={deliveryEntryStageRows(detail, workflow)}
    workflow={workflow}
    canManage
    selectedStage={selected}
    onSelectStage={onSelectStage ?? setSelected}
  />;
}
function mount(extra: Partial<StageFixture> = {}) {
  const node = document.createElement("div");
  document.body.append(node);
  const root = createRoot(node);
  flushSync(() => root.render(<StageOverview detail={detail} {...extra} />));
  cleanup = () => { flushSync(() => root.unmount()); node.remove(); };
  return node;
}
const record=(stage:DeliveryStageRecord["stage"],jiraKey:string|null,state:DeliveryStageRecord["state"]):DeliveryStageRecord=>({stage,jiraKey,state,taskId:stage+"-task",seatId:"seat-1",ownerUserId:"owner",dispatchId:"dispatch",runId:null,capabilityId:null,registryRevision:null,inputDigest:"a".repeat(64),receipt:null,receiptDigest:null,review:null,message:null});
describe("entry stage delivery overview",()=>{
 it("shows Jira parents above delivery stages and links child rows back to their parent",()=>{
  const node=mount({selectedStage:"design"});
  const mains=node.querySelector('[aria-label="关联主工单"]')!;
  const stages=node.querySelector('[aria-label="选择条目交付阶段"]')!;
  expect(mains.compareDocumentPosition(stages)&Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  const link=node.querySelector<HTMLAnchorElement>('tbody a[href^="#delivery-main-"]')!;
  expect(link.textContent).toBe("主单：MAIN-1");
  expect(node.querySelector('[id="'+link.getAttribute("href")!.slice(1)+'"]')?.textContent).toContain("MAIN-1 · 产品功能需求");
 });
 it("routes a design row to the instance plan without single-ticket intake",()=>{
  const node=mount({selectedStage:"design"});
  const link=node.querySelector<HTMLAnchorElement>('a[aria-label="打开工单交付计划 DESIGN-1"]');
  expect(link?.textContent).toBe("交付计划");
  const url=new URL(link!.href);expect(url.pathname).toBe("/delivery");
  expect(Object.fromEntries(url.searchParams)).toEqual({projectId:"project-1",snapshotId:"snapshot-1",tab:"work"});
  expect(node.textContent).toContain("查看计划不会启动执行");
 });
 it("does not offer intake for ended and review tickets",()=>{
  const copy={...detail,snapshot:{...detail.snapshot,plan:{...detail.snapshot.plan,items:[item("ENDED-1","系统设计",{status:"已完成"}),item("REVIEW-1","设计评审"),item("DESIGN-1","系统设计")]}}};
  const node=mount({detail:copy,selectedStage:"design"});
  expect(node.querySelector('a[href^="/jira-intake?"]')).toBeNull();
  expect(node.textContent).toContain("查看来源历史");
  expect(node.textContent).not.toContain("此类型暂不支持接入执行");
  expect(node.textContent).toContain("交付计划");
 });
 it.each(["task","workflow"])("keeps the original %s link instead of offering duplicate intake",(kind)=>{
  const workflow=kind==="workflow"?{stages:[record("design","DESIGN-1","running")]} as DeliveryWorkflow:undefined;
  const copy=kind==="task"?{...detail,tasks:[...detail.tasks,{...detail.tasks[0],id:"design-task",jiraKey:"DESIGN-1",status:"cancelled"}]}:detail;
  const node=mount({detail:copy,workflow,selectedStage:"design"});
  expect(node.querySelector('a[href^="/jira-intake?"]')).toBeNull();
  expect(node.querySelector('a[href="/issues/design-task"]')).not.toBeNull();
 });
 it.each([false,true])("respects coding admission before offering row intake (ready=%s)",(ready)=>{
  const copy={...detail,tasks:[],admission:{...detail.admission!,ready},snapshot:{...detail.snapshot,plan:{...detail.snapshot.plan,items:[item("CODE-READY","前端编码")]}}};
  const node=mount({detail:copy,selectedStage:"coding"});
  expect(node.querySelector('a[aria-label="打开工单交付计划 CODE-READY"]')).not.toBeNull();
  expect(node.querySelector('a[href^="/jira-intake?"]')).toBeNull();
 });
 it("uses Qingzhou source analysis independently of local tasks and never infers approval from development",()=>{
  const plan=detail.snapshot.plan;
  const stages=[{role:"需求分析人员",status:"已处理"},{role:"需求评审人员",status:"已处理"}];
  expect(sourceAnalysisStatus({...plan,sourceAnalysis:{sourceStatus:"待开发",analysisSaved:true,reviewStages:stages}})).toBe("需求评审已通过（来源记录）");
  expect(sourceAnalysisStatus({...plan,sourceAnalysis:{sourceStatus:"评审不通过",analysisSaved:true,reviewStages:stages}})).toBe("评审不通过");
  expect(sourceAnalysisStatus(plan)).toBe("待核对");
  expect(sourceAnalysisStatus({...plan,sourceAnalysis:{sourceStatus:"待开发",analysisSaved:null,reviewStages:[]}})).toBe("待核对");
  expect(sourceAnalysisStatus({...plan,sourceAnalysis:{sourceStatus:"待开发",analysisSaved:true,reviewStages:[]}})).toBe("分析已保存，评审待核对");
  for(const sourceStatus of ["待需求分析","分析完成待评审","评审不通过","研发打回"]){
    expect(sourceAnalysisStatus({...plan,sourceAnalysis:{sourceStatus,analysisSaved:true,reviewStages:[]}})).toBe(sourceStatus);
  }
  expect(sourceAnalysisStatus({...plan,sourceAnalysis:{sourceStatus:"待开发",analysisSaved:true,reviewStages:[{role:"需求负责人",status:"通过"}]}})).toBe("评审记录：通过");
 });
 it("shows source analysis reviewers by name and colors recorded approval as successful without a platform task",()=>{
  const copy={...detail,analyses:[],snapshot:{...detail.snapshot,plan:{...detail.snapshot.plan,roles:[{label:"需求分析",name:"张三"},{label:"需求评审",name:"李四"}],sourceAnalysis:{sourceStatus:"待开发",analysisSaved:true,reviewStages:[{role:"需求分析人员",status:"已处理"},{role:"需求评审人员",status:"已处理"}]}}}};
  const stage=deliveryEntryStageRows(copy)[0];expect(stage.statusTone).toBe("succeeded");expect(stage.analyses).toHaveLength(0);
  expect(sourceAnalysisRoleName(copy.snapshot.plan,"需求分析人员")).toBe("张三");expect(sourceAnalysisRoleName(copy.snapshot.plan,"需求评审人员")).toBe("李四");
  const node=mount({detail:copy,selectedStage:"analysis"});expect(node.textContent).toContain("需求分析人员（张三） · 已处理");expect(node.textContent).toContain("需求评审人员（李四） · 已处理");expect(node.textContent).toContain("完成依据：轻舟分析与评审记录");
 });
 it("shows old source snapshots as unknown while preserving local execution",()=>{
  const node=mount({selectedStage:"analysis"});const card=node.querySelector('[aria-label="选择条目交付阶段"] button');
  expect(card?.textContent).toContain("待核对");expect(card?.textContent).toContain("平台分析：待处理／核验");
  expect(node.textContent).toContain("请重新同步来源");
 });
 it("shows source review facts with no Jira analysis subtask or local analysis",()=>{
  const copy={...detail,analyses:[],snapshot:{...detail.snapshot,plan:{...detail.snapshot.plan,sourceAnalysis:{sourceStatus:"待开发",analysisSaved:true,reviewStages:[{role:"需求负责人",status:"通过"}]}}}};
  const node=mount({detail:copy,selectedStage:"analysis"});const card=node.querySelector('[aria-label="选择条目交付阶段"] button');
  expect(card?.textContent).toContain("评审记录：通过");expect(card?.textContent).toContain("完成依据：轻舟分析与评审记录");
  expect(card?.textContent).not.toContain("待安排");expect(card?.textContent).not.toContain("核验交付 0");
  expect(node.querySelector('[aria-label="轻舟需求分析与评审"]')?.textContent).toContain("需求负责人（未提供负责人） · 通过");
 });
 it("maps case design and reviews into testing, code review into coding and keeps unknown types unclassified",()=>{
  expect(sourceEntryStage("测试用例设计")).toBe("testing");expect(sourceEntryStage("测试用例评审")).toBe("testing");expect(sourceEntryStage("代码评审")).toBe("coding");expect(sourceEntryStage("系统设计补充")).toBe("design");expect(sourceEntryStage("发布支持")).toBeNull();
  const stages=deliveryEntryStageRows(detail);expect(stages.map(s=>s.rows.length)).toEqual([0,1,2,3]);expect(stages[3].running).toBe(1);
 });
 it("counts all three historical Jira testing tickets as complete without platform verification",()=>{
  const copy={...detail,snapshot:{...detail.snapshot,plan:{...detail.snapshot.plan,items:[item("CASE-1","用例编写",{status:"已完成"}),item("CASE-2","用例评审",{status:"已完成"}),item("TEST-1","功能测试",{status:"已完成"})]}}};
  const testing=deliveryEntryStageRows(copy)[3];expect(testing.sourceCompleted).toBe(3);expect(testing.sourceCount).toBe(3);expect(testing.verified).toBe(0);expect(testing.statusLabel).toBe("测试已完成（Jira）");expect(testing.statusTone).toBe("succeeded");
  const node=mount({detail:copy,selectedStage:"testing"});const card=node.querySelectorAll('[aria-label="选择条目交付阶段"] button')[3];
  expect(card.textContent).toContain("测试已完成（Jira）");expect(card.textContent).toContain("来源已完成 3/3");expect(card.textContent).toContain("完成依据：Jira 工单状态");expect(card.textContent).not.toContain("核验交付");expect(card.textContent).not.toContain("待交付核验");
  expect(node.querySelectorAll("tbody tr")).toHaveLength(3);expect(node.querySelector("tbody")?.textContent).not.toContain("来源结束不等于");
 });
 it.each([["analysis","需求分析"],["design","系统设计"],["coding","编码"],["testing","功能测试"]] as const)("uses completed Jira tickets for the %s stage without requiring additional platform reviews",(id,type)=>{
  const copy={...detail,analyses:[],tasks:[],snapshot:{...detail.snapshot,plan:{...detail.snapshot.plan,items:[item("COMPLETED",type,{status:"已完成"})]}}};
  const stage=deliveryEntryStageRows(copy).find(s=>s.id===id)!;expect(stage.statusTone).toBe("succeeded");expect(stage.statusLabel).toContain("已完成（Jira）");expect(stage.verified).toBe(0);expect(stage.hasPlatformRecords).toBe(false);
 });
 it("preserves platform attention as supplemental evidence while completed Jira work determines the stage",()=>{
  const copy={...detail,analyses:[],tasks:[{...detail.tasks[1],status:"blocked",runStatus:"failed"}],snapshot:{...detail.snapshot,plan:{...detail.snapshot.plan,items:[item("QA-1","功能测试",{status:"已完成"})]}}};
  const stage=deliveryEntryStageRows(copy)[3];expect(stage.statusTone).toBe("succeeded");expect(stage.statusLabel).toBe("测试已完成（Jira）");expect(stage.attention).toBe(1);expect(stage.hasPlatformRecords).toBe(true);
  const node=mount({detail:copy,selectedStage:"testing"});expect(node.textContent).toContain("平台记录：核验交付 0 · 执行 0 · 待处理 1");
 });
 it.each(["待受理","已取消","已关闭","", "未知状态"])("does not treat the Jira state %s as completed",status=>{
  const copy={...detail,snapshot:{...detail.snapshot,plan:{...detail.snapshot.plan,items:[item("QA-1","功能测试",{status})]}}};
  const stage=deliveryEntryStageRows(copy)[3];expect(stage.sourceCompleted).toBe(0);expect(stage.statusLabel).not.toContain("已完成");
 });
 it("keeps all analysis revisions but only the latest affects current stage evidence and attention",()=>{
  const analysis=deliveryEntryStageRows(detail)[0];expect(analysis.analyses.map(a=>a.revision)).toEqual([2,1]);expect(analysis.verified).toBe(0);expect(analysis.attention).toBe(1);expect(analysis.count).toBe(1);
 });
 it("never treats source closed or task success as version-bound delivery evidence",()=>{
  const coding=deliveryEntryStageRows(detail)[2];expect(coding.verified).toBe(0);expect(coding.statusLabel).toBe("待代码评审");expect(coding.executionLabel).toBe("待推进／核验");
 });
 it("shows completed coding awaiting code review separately from platform verification",()=>{
  const copy={...detail,snapshot:{...detail.snapshot,plan:{...detail.snapshot.plan,items:[item("ATSES-516124","编码",{status:"已完成",parentKey:"ATSES-515897"}),item("ATSES-516122","代码评审",{parentKey:"ATSES-515897"})]}}};
  const node=mount({detail:copy,selectedStage:"coding"});const card=node.querySelectorAll('[aria-label="选择条目交付阶段"] button')[2];
  expect(card.textContent).toContain("待代码评审");expect(card.textContent).not.toContain("平台：待代码评审");
  expect(card.textContent).toContain("完成依据：Jira 工单状态");expect(card.textContent).toContain("来源已完成 1/2");expect(card.textContent).not.toContain("核验交付 0");
  expect(node.querySelector("tbody")?.textContent).toContain("已完成（Jira）");
 });
 it("aggregates parallel coding and code review conservatively for each main issue",()=>{
  const code=item("CODE","后端编码",{status:"已完成"}),review=item("REVIEW","代码评审",{status:"已完成"});
  expect(sourceCodingStatus([{...code,status:"待受理"},review]).label).toBe("待编码");
  expect(sourceCodingStatus([{...code,status:"开发中"},review]).label).toBe("编码中");
  expect(sourceCodingStatus([code,{...code,key:"FRONT",type:"前端编码",status:"待受理"},review]).label).toBe("编码中");
  expect(sourceCodingStatus([code,{...review,status:"处理中"}]).label).toBe("代码评审中");
  expect(sourceCodingStatus([code,{...review,status:"评审不通过"}])).toEqual({label:"编码待修改",tone:"blocked"});
  expect(sourceCodingStatus([code,review])).toEqual({label:"代码评审已通过（来源记录）",tone:"succeeded"});
  for(const status of ["已关闭","已取消","未知",""])
    expect(sourceCodingStatus([code,{...review,status}]).label).toBe("编码已完成，评审待核对");
  expect(sourceCodingStatus([code]).label).toBe("编码已完成，评审待核对");
  expect(sourceCodingStatus([code,review,{...code,key:"OTHER",parentKey:"MAIN-2"}]).label).toBe("编码已完成，评审待核对");
  expect(sourceCodingStatus([review]).label).toBe("编码待核对");
  const copy={...detail,snapshot:{...detail.snapshot,plan:{...detail.snapshot.plan,items:[]}}};
  const stage=deliveryEntryStageRows(copy,{stages:[record("coding","MISSING","review")]} as DeliveryWorkflow)[2];
  expect(stage.sourceStatus).toBe(false);expect(stage.statusLabel).toBe("待处理／核验");
 });
 it("shows source progress separately from platform verification",()=>{
  const copy={...detail,snapshot:{...detail.snapshot,plan:{...detail.snapshot.plan,items:[item("DESIGN-1","系统设计",{status:"已完成"}),item("REVIEW-1","设计评审"),item("DESIGN-2","系统设计",{status:"已取消"})]}}};
  const design=deliveryEntryStageRows(copy)[1];expect(design.sourceCompleted).toBe(1);expect(design.sourceCount).toBe(3);expect(design.verified).toBe(0);
  const node=mount({detail:copy});const card=node.querySelectorAll('[aria-label="选择条目交付阶段"] button')[1];
  expect(card.textContent).toContain("来源已完成 1/3");expect(card.textContent).toContain("完成依据：Jira 工单状态");expect(card.textContent).toContain("设计待核对");
 });
 it("shows completed design awaiting review without claiming verified delivery",()=>{
  const copy={...detail,snapshot:{...detail.snapshot,plan:{...detail.snapshot.plan,items:[item("ATSES-516125","系统设计",{status:"已完成",parentKey:"ATSES-515897"}),item("ATSES-516127","设计评审",{parentKey:"ATSES-515897"})]}}};
  const node=mount({detail:copy,selectedStage:"design"});const card=node.querySelectorAll('[aria-label="选择条目交付阶段"] button')[1];
  expect(card.textContent).toContain("待设计评审");expect(card.textContent).not.toContain("平台：待设计评审");
  expect(card.textContent).toContain("完成依据：Jira 工单状态");expect(card.textContent).not.toContain("核验交付 0");
  expect(node.querySelector("tbody")?.textContent).toContain("已完成（Jira）");
 });
 it("distinguishes design progress, pending review, active review and explicit review outcomes",()=>{
  const design=item("DESIGN","系统设计",{status:"已完成"});
  const review=(status:string)=>item("REVIEW","设计评审",{status});
  expect(sourceDesignStatus([{...design,status:"待受理"},review("待受理")]).label).toBe("待设计");
  expect(sourceDesignStatus([{...design,status:"处理中"},review("待受理")]).label).toBe("设计中");
  expect(sourceDesignStatus([design,review("待受理")]).label).toBe("待设计评审");
  expect(sourceDesignStatus([design,review("处理中")]).label).toBe("设计评审中");
  for(const status of ["退回","评审不通过","驳回"])
    expect(sourceDesignStatus([design,review(status)])).toEqual({label:"设计待修改",tone:"blocked"});
  for(const status of ["已完成","评审通过","approved"])
    expect(sourceDesignStatus([design,review(status)])).toEqual({label:"设计评审已通过（来源记录）",tone:"succeeded"});
 });
 it("requires positive reviews for every parent and preserves unknown or frozen source states",()=>{
  const design=item("DESIGN","系统设计",{status:"已完成"}),review=item("REVIEW","设计评审",{status:"已完成"});
  for(const status of ["已关闭","已取消","未知状态",""])
    expect(sourceDesignStatus([design,{...review,status}]).label).toBe("设计已完成，评审待核对");
  expect(sourceDesignStatus([design]).label).toBe("设计已完成，评审待核对");
  expect(sourceDesignStatus([design,review,{...design,key:"DESIGN-2",parentKey:"MAIN-2"}]).label).toBe("设计已完成，评审待核对");
  expect(sourceDesignStatus([review]).label).toBe("设计待核对");
  const copy={...detail,snapshot:{...detail.snapshot,plan:{...detail.snapshot.plan,items:[]}}};
  const stage=deliveryEntryStageRows(copy,{stages:[record("design","MISSING","review")]} as DeliveryWorkflow)[1];
  expect(stage.sourceStatus).toBe(false);expect(stage.statusLabel).toBe("待处理／核验");
 });
 it("preserves multiple tasks of one issue without double counting issue delivery",()=>{
  const copy={...detail,tasks:[...detail.tasks,{...detail.tasks[0],id:"older-code-task"}]};
  const coding=deliveryEntryStageRows(copy)[2];expect(coding.rows[0].tasks).toHaveLength(2);expect(coding.count).toBe(2);
 });
 it("keeps workflow identity when current source does not return the child and separates case / functional test receipts",()=>{
  const workflow={stages:[record("test-cases","MISSING-1","done"),record("functional-test","QA-1","review")]} as DeliveryWorkflow;
  const testing=deliveryEntryStageRows(detail,workflow)[3];expect(testing.rows).toHaveLength(4);expect(testing.verified).toBe(1);expect(testing.attention).toBe(1);expect(testing.statusLabel).toBe("待测试");expect(testing.executionLabel).toBe("待处理／核验");
 });
 it("switches stage content and exposes task / conversation links while preserving unknown children",()=>{
  const node=mount();expect(node.textContent).not.toContain("新版分析 · 修订 2 · 最新");
  const buttons=[...node.querySelectorAll<HTMLButtonElement>('[aria-label="选择条目交付阶段"] button')];flushSync(()=>buttons[2].click());
  expect(node.querySelector('[aria-label="所选条目阶段"]')?.textContent).toContain("REVIEW-1");expect(node.querySelector('[aria-label="所选条目阶段"]')?.textContent).not.toContain("QA-1");expect(node.querySelector('a[href="/issues/code-task"]')).not.toBeNull();expect(node.textContent).toContain("OTHER-1");
  flushSync(()=>buttons[3].click());expect(node.querySelectorAll("tbody tr")).toHaveLength(3);expect(node.querySelector('[aria-label="所选条目阶段"]')?.textContent).toContain("CASE-REVIEW-1");
 });
 it("supports a direct-linked controlled stage and reports the next selection to the URL owner",()=>{
  const select=vi.fn();const node=mount({selectedStage:"testing",onSelectStage:select});expect(node.querySelector('[aria-label="所选条目阶段"] h3')?.textContent).toContain("测试");
  flushSync(()=>node.querySelectorAll<HTMLButtonElement>('[aria-label="选择条目交付阶段"] button')[1].click());expect(select).toHaveBeenCalledWith("design");
 });
 it("shows missing stages as unarranged and never calls missing work completed",()=>{
  const copy={...detail,analyses:[],tasks:[],snapshot:{...detail.snapshot,plan:{...detail.snapshot.plan,items:[]}}};
  const node=mount({detail:copy,selectedStage:"testing"});expect(node.textContent).toContain("当前来源未关联测试工单");expect(node.textContent).not.toContain("交付已核验");
 });
});
