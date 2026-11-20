import { DELIVERY_STAGES, deliveryReviewExecution, matchesDeliveryWorkType, type DeliveryWorkflowConfig, type DeliveryTemplateDefinition, type DeliveryStageRecord, type DeliveryWorkItem } from "@paperclipai/shared";
import { conflict } from "../errors.js";
export interface PlannedDeliveryWork {
  stage: DeliveryStageRecord["stage"];
  key: string | null;
  seatId: string;
  intent?: DeliveryStageRecord["intent"];
  executionMode?: "human";
  reviewWorkKeys?: string[];
  executorUserId?: string;
}
/** Explicit bindings prevent title matching or silently skipping a missing review. */
export function planDeliveryWork(config: DeliveryWorkflowConfig, definition: DeliveryTemplateDefinition, items: DeliveryWorkItem[], deferSeats = false, incompletePreview = false, sharedAnalysis = false): PlannedDeliveryWork[] {
  const result: PlannedDeliveryWork[] = [];
  if (config.workTasks?.some(t => !definition.stages[t.stage].enabled)) throw conflict("停用阶段不能绑定工作单");
  if (config.workTasks && config.codingTasks) throw conflict("工作单不能同时使用两套绑定配置");
  for (const stage of DELIVERY_STAGES) {
    const policy = definition.stages[stage];
    const bindings = config.reviewTasks?.filter(r => r.stage === stage) ?? [];
    if (stage === "analysis" && sharedAnalysis) continue;
    if (!policy.enabled) {
      if (bindings.length) throw conflict("停用阶段不能配置评审工单");
      continue;
    }
    const seatId = (stage === "analysis" && config.analysisSeatId) || policy.seatId || (stage === "analysis" ? config.analysisSeatId : ["design", "coding"].includes(stage) ? config.developmentSeatId : config.qaSeatId);
    const work: PlannedDeliveryWork[] = config.workTasks && stage !== "analysis"
      ? config.workTasks.filter(t => t.stage === stage).map(t => ({stage, key:t.jiraKey, seatId:t.seatId || seatId}))
      : stage === "coding"
      ? (config.codingTasks ?? [{jiraKey: config.codingKey, seatId}]).map(t => ({stage, key:t.jiraKey, seatId:t.seatId}))
      : [{stage, seatId, key:stage === "analysis" ? null : stage === "design" ? config.designKey : stage === "test-cases" ? config.testCasesKey : config.testExecutionKey}];
    for (const node of work) node.seatId = config.workSeats?.find(s => s.jiraKey === node.key)?.seatId || node.seatId;
    if (!work.length && incompletePreview) continue;
    if (!work.length || work.some(w => (!deferSeats && !w.seatId && !(policy.workExecution === "human" && policy.workExecutorUserId)) || (stage !== "analysis" && !w.key))) throw conflict("请为模板启用的每个阶段配置席位及真实工单");
    if (policy.workExecution === "human") for (const node of work) { node.executionMode="human";node.executorUserId=policy.workExecutorUserId; }
    result.push(...work);
    if (policy.taskSequence !== "work_then_review") {
      if (bindings.length) throw conflict("当前阶段未启用独立评审工单");
      continue;
    }
    // Preview retains known nodes while selection reports the missing-review blocker.
    if (incompletePreview && !bindings.length) continue;
    const covered = bindings.flatMap(b => b.workKeys);
    const fullStageReviews = bindings.length > 0 && bindings.every(b =>
      new Set(b.workKeys).size === work.length && b.workKeys.length === work.length && work.every(w => b.workKeys.includes(w.key!)));
    const exclusiveCoverage = new Set(covered).size === covered.length && covered.length === work.length && work.every(w => covered.includes(w.key!));
    if (!fullStageReviews && !exclusiveCoverage) throw conflict("评审必须覆盖本阶段全部工作单；不允许遗漏或交叉覆盖");
    for (const binding of bindings) {
      const source = items.find(i => i.key === binding.jiraKey && i.parentKey);
      const reviewed = work.filter(w => binding.workKeys.includes(w.key!));
      if (!source || !matchesDeliveryWorkType(stage, true, source.type) || binding.workKeys.some(key => items.find(i => i.key === key)?.parentKey !== source.parentKey)) throw conflict("评审单类型或所属主工单不匹配，请明确绑定真实评审子单");
      const manual=deliveryReviewExecution(stage,policy)==="human";
      const reviewerSeat = config.workSeats?.find(s => s.jiraKey === binding.jiraKey)?.seatId || binding.seatId || policy.reviewSeatId || (manual || stage !== "coding" ? reviewed[0].seatId : "");
      if (!deferSeats && !reviewerSeat && !manual) throw conflict("请为 Agent 评审单选择独立评审席位");
      if (!deferSeats && !manual && reviewed.some(w => w.executionMode !== "human" && w.seatId === reviewerSeat)) throw conflict("Agent 评审必须使用不同于被审工作单的独立席位");
      result.push({stage, key:binding.jiraKey, seatId:reviewerSeat, intent:stage === "coding" ? "code-review" : stage === "design" ? "design-review" : "test-case-review", ...(manual ? {executionMode:"human" as const,executorUserId:policy.reviewExecutorUserId || (policy.review === "specified_user" ? policy.reviewerUserId : undefined) || (policy.workExecution === "human" ? policy.workExecutorUserId : undefined)} : {}), reviewWorkKeys:[...binding.workKeys]});
    }
  }
  const keys=result.flatMap(w => w.key ? [w.key] : []);
  if (new Set(keys).size !== keys.length) throw conflict("每张真实子工单只能绑定一个流程节点");
  return result;
}
/** All review nodes join before the next business stage. Shared reviews wait for every explicitly bound work item. */
export function wireDeliveryWork(stages: DeliveryStageRecord[], definition: DeliveryTemplateDefinition, sharedUpstream: string[] = []) {
  let upstream = sharedUpstream;
  for(const kind of DELIVERY_STAGES) {
    const group=stages.filter(s=>s.stage===kind);
    if(!group.length)continue;
    const work=group.filter(s=>!s.reviewWorkKeys);
    for(const [index,stage] of work.entries())stage.dependsOn=kind==="coding"&&definition.codingExecution==="serial"&&index>0?[work[index-1].taskId]:[...upstream];
    for(const stage of group.filter(s=>s.reviewWorkKeys))stage.dependsOn=work.filter(w=>stage.reviewWorkKeys!.includes(w.jiraKey!)).map(w=>w.taskId);
    upstream=group.map(s=>s.taskId);
  }
}
