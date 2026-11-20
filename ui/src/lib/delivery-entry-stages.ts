import type { DeliveryEntryDetail, DeliveryStageRecord, DeliveryWorkflow, DeliveryWorkItem, DeliveryPlan } from "@paperclipai/shared";
import { sourceWorkEnded } from "./delivery-work-dispatch";
export const DELIVERY_ANALYSIS_SECTION_ID = "delivery-entry-analysis";
export const ENTRY_STAGES = [
  { id: "analysis", label: "需求分析", description: "分析修订、人工决定与正式发布" },
  { id: "design", label: "设计", description: "研发设计、产物与设计评审" },
  { id: "coding", label: "编码", description: "编码任务与关联代码评审" },
  { id: "testing", label: "测试", description: "用例编写、用例评审与功能测试" },
] as const;
export type EntryStageId = (typeof ENTRY_STAGES)[number]["id"];
export function deliveryMainIssueKeys(plan: DeliveryPlan): string[] {
  return [...new Set([
    ...plan.mains.map(main => main.key),
    ...plan.items.flatMap(item => item.parentKey ? [item.parentKey] : []),
  ])];
}
export const workflowEntryStage = (stage: DeliveryStageRecord["stage"]): EntryStageId => ["test-cases", "functional-test"].includes(stage) ? "testing" : stage as EntryStageId;
export function sourceEntryStage(type: string): EntryStageId | null {
  // Testing comes before design so that 测试用例设计 is not a development design task.
  if (/测试|用例|缺陷验证/.test(type)) return "testing";
  if (/需求分析|需求评审/.test(type)) return "analysis";
  if (/代码评审|代码审查|编码|开发/.test(type)) return "coding";
  if (/设计/.test(type)) return "design";
  return null;
}
/** The source workflow is independent of local execution and delivery verification. */
export function sourceAnalysisStatus(plan: DeliveryPlan): string {
  const source = plan.sourceAnalysis;
  if (!source) return "待核对";
  const status = source.sourceStatus;
  // Only expose explicit source states; downstream development does not prove approval.
  if (["待需求分析", "分析完成待评审", "待需求评审", "待评审", "需求评审通过", "评审通过", "需求评审不通过", "评审不通过", "研发打回", "需求打回", "JIRA工单被打回", "已挂起", "挂起", "已关闭", "关闭"].includes(status)) return status;
  if (source.reviewStages.some(stage => stage.role === "需求评审人员" && stage.status === "已处理")) return "需求评审已通过（来源记录）";
  if (source.reviewStages.some(stage => stage.role === "需求分析人员" && stage.status === "已处理")) return "分析已登记，评审待核对";
  const reviewStatuses = [...new Set(source.reviewStages.map(stage => stage.status).filter(Boolean))];
  if (reviewStatuses.length === 1 && source.reviewStages.every(stage => stage.status)) return `评审记录：${reviewStatuses[0]}`;
  if (reviewStatuses.length) return "评审分阶段记录";
  if (source.analysisSaved === true) return "分析已保存，评审待核对";
  return "待核对";
}
export function sourceAnalysisRoleName(plan: DeliveryPlan, role: string): string {
  const label = role === "需求分析人员" ? "需求分析" : role === "需求评审人员" ? "需求评审" : role;
  return plan.roles.find(item => item.label === label)?.name ?? "";
}
function sourceAnalysisTone(status: string): string {
  if (/评审不通过|需求打回|研发打回|被打回/.test(status)) return "blocked";
  if (/需求评审已通过|评审通过/.test(status)) return "succeeded";
  return "queued";
}
const sourceCompletedSuccessfully = (status: string) => /^(已完成|完成|已发布|已发版|已解决|done|resolved|released)$/i.test(status.trim());
export function sourceCodingCompleted(plan: DeliveryPlan): boolean {
  const coding = plan.items.filter(item => item.parentKey && sourceEntryStage(item.type) === "coding" && !/评审|审查/.test(item.type));
  return coding.length > 0 && coding.every(item => sourceCompletedSuccessfully(item.status));
}
const sourceInProgress = (status: string) => /^(处理中|进行中|设计中|编码中|开发中|评审中|审查中|执行中|in_progress|in progress|running)$/i.test(status.trim());
const sourcePending = (status: string) => /^(待受理|待处理|未开始|待开始|待设计|待编码|待开发|待评审|待设计评审|待代码评审|待审查|待办|todo|pending|open|queued)$/i.test(status.trim());
/** Source progress is not evidence of a version-bound platform delivery. */
function sourceWorkReviewStatus(sources: DeliveryWorkItem[], workLabel: string, reviewLabel: string) {
  const reviews = sources.filter(item => /评审|审查/.test(item.type));
  const work = sources.filter(item => !reviews.includes(item));
  const reviewPassed = (item: DeliveryWorkItem) => sourceCompletedSuccessfully(item.status) || /^(评审通过|审查通过|已通过|通过|approved)$/i.test(item.status.trim());
  if (sources.some(item => /^(已退回|退回|已打回|打回|已驳回|驳回|评审不通过|审查不通过|不通过|rejected)$/i.test(item.status.trim()))) return { label: `${workLabel}待修改`, tone: "blocked" };
  if (!work.length) return { label: `${workLabel}待核对`, tone: "queued" };
  const unfinished = work.filter(item => !sourceCompletedSuccessfully(item.status));
  if (unfinished.length) {
    if (unfinished.some(item => !sourcePending(item.status) && !sourceInProgress(item.status))) return { label: `${workLabel}待核对`, tone: "queued" };
    return unfinished.some(item => sourceInProgress(item.status)) || unfinished.length < work.length
      ? { label: `${workLabel}中`, tone: "running" } : { label: `待${workLabel}`, tone: "queued" };
  }
  // Every main issue with work must have its own review before summarizing approval.
  if (work.some(item => !reviews.some(review => review.parentKey === item.parentKey)) || reviews.some(item => !reviewPassed(item) && !sourcePending(item.status) && !sourceInProgress(item.status))) return { label: `${workLabel}已完成，评审待核对`, tone: "queued" };
  if (reviews.every(reviewPassed)) return { label: `${reviewLabel}已通过（来源记录）`, tone: "succeeded" };
  if (reviews.some(item => sourceInProgress(item.status))) return { label: `${reviewLabel}中`, tone: "running" };
  return { label: `待${reviewLabel}`, tone: "queued" };
}
export const sourceDesignStatus = (sources: DeliveryWorkItem[]) => sourceWorkReviewStatus(sources, "设计", "设计评审");
export const sourceCodingStatus = (sources: DeliveryWorkItem[]) => sourceWorkReviewStatus(sources, "编码", "代码评审");
function sourceTestingStatus(sources: DeliveryWorkItem[]) {
  const unfinished = sources.filter(item => !sourceCompletedSuccessfully(item.status));
  if (unfinished.some(item => !sourcePending(item.status) && !sourceInProgress(item.status))) return {label:"测试待核对",tone:"queued"};
  return unfinished.some(item => sourceInProgress(item.status)) || unfinished.length < sources.length
    ? {label:"测试中",tone:"running"} : {label:"待测试",tone:"queued"};
}
export function deliveryEntryStageRows(detail: DeliveryEntryDetail, workflow?: DeliveryWorkflow) {
  const items = detail.snapshot.plan.items.filter(item => !!item.parentKey);
  return ENTRY_STAGES.map(stage => {
    const records = workflow?.stages.filter(record => workflowEntryStage(record.stage) === stage.id) ?? [];
    const sources = items.filter(item => sourceEntryStage(item.type) === stage.id);
    // Frozen workflow tasks can outlive a refreshed source snapshot. Keep their identity visible.
    const missing = records.filter(record => record.jiraKey && !sources.some(item => item.key === record.jiraKey));
    const rows = [...sources, ...missing.map(record => ({key: record.jiraKey!, parentKey: record.parentKey ?? null, title: "流程已关联，当前来源未返回详情", type: record.stage === "test-cases" ? "用例编写" : record.stage === "functional-test" ? "功能测试" : stage.label, status: "", assignee: "", scheduled: false} satisfies DeliveryWorkItem))].map(item => ({
      item, tasks: detail.tasks.filter(task => task.jiraKey === item.key),
      records: records.filter(record => record.jiraKey === item.key), ended: sourceWorkEnded(item.status), completed: sourceCompletedSuccessfully(item.status),
    }));
    const analyses = stage.id === "analysis" ? [...detail.analyses].sort((a,b) => b.revision - a.revision || b.updatedAt.localeCompare(a.updatedAt)) : [];
    const latestAnalysis = analyses[0];
    const unlistedRecords = records.filter(record => !record.jiraKey && !analyses.some(a => a.id === record.taskId));
    const analysisTasks = latestAnalysis ? [latestAnalysis] : [];
    const issueTasks = rows.flatMap(row => row.tasks);
    const attention = records.filter(r => ["waiting", "review", "interrupted"].includes(r.state)).length + issueTasks.filter(t => !records.some(r => r.taskId === t.id) && (t.status === "blocked" || t.status === "in_review" || ["failed", "timed_out"].includes(t.runStatus ?? ""))).length + analysisTasks.filter(a => !records.some(r => r.taskId === a.id) && ["waiting", "interrupted", "local_completed"].includes(a.state)).length;
    const running = records.filter(r => r.state === "running").length + issueTasks.filter(t => t.runStatus === "running" && !records.some(r => r.taskId === t.id)).length + analysisTasks.filter(a => a.state === "running" && !records.some(r => r.taskId === a.id)).length;
    const verified = rows.filter(row => row.records.some(r => r.state === "done")).length + (latestAnalysis?.state === "published" ? 1 : 0) + unlistedRecords.filter(r => r.state === "done").length;
    const count = rows.length + (latestAnalysis ? 1 : 0) + unlistedRecords.length;
    // Count only explicit successful source states; cancelled or closed work is
    // terminal but does not necessarily represent completed work.
    const sourceCompleted = sources.filter(item => sourceCompletedSuccessfully(item.status)).length;
    const allVerified = count > 0 && verified === count;
    const allSourcesCompleted = sources.length > 0 && sourceCompleted === sources.length;
    const hasPlatformRecords = records.length > 0 || issueTasks.length > 0 || analysisTasks.length > 0;
    const executionLabel = !hasPlatformRecords ? "未关联平台任务" : attention ? "待处理／核验" : running ? "执行中" : allVerified ? "交付已核验" : verified ? "部分交付已核验" : count ? "待推进／核验" : "待安排";
    const workStatus = allSourcesCompleted ? {label:`${stage.label}已完成（Jira）`,tone:"succeeded"} : sources.length ? stage.id === "design" ? sourceDesignStatus(sources) : stage.id === "coding" ? sourceCodingStatus(sources) : stage.id === "testing" ? sourceTestingStatus(sources) : null : null;
    const sourceStatus = stage.id === "analysis" || !!workStatus;
    const statusLabel = workStatus?.label ?? (stage.id === "analysis" ? sourceAnalysisStatus(detail.snapshot.plan) : executionLabel);
    const statusTone = workStatus?.tone ?? (stage.id === "analysis" ? sourceAnalysisTone(statusLabel) : attention ? "blocked" : running ? "running" : allVerified ? "succeeded" : "queued");
    return {...stage, executionLabel, rows, analyses, unlistedRecords, records, attention, running, verified, count, sourceCompleted, sourceCount: sources.length, sourceStatus, statusTone, statusLabel, hasPlatformRecords};
  });
}
