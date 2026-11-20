import {
  DELIVERY_STAGES,
  DELIVERY_STAGE_LABELS,
  matchesDeliveryWorkType,
  type DeliveryAutomaticPlanInput,
  type DeliveryAutomaticPlan,
  type DeliveryTemplateDefinition,
  type DeliveryWorkItem,
  type DeliveryWorkflowConfig,
} from "@paperclipai/shared";
export const completedDeliverySource = (status: string) =>
  [
    "已完成",
    "完成",
    "已关闭",
    "关闭",
    "已发版",
    "已发布",
    "done",
    "closed",
    "resolved",
    "released",
  ].includes(status.trim().toLowerCase());
export const cancelledDeliverySource = (status: string) =>
  ["已取消", "取消", "已作废", "作废", "cancelled", "canceled"].includes(
    status.trim().toLowerCase(),
  );
/** Review coverage is determined by stage type and common parent; links are source metadata only. */
export interface AutomaticSourceItem extends DeliveryWorkItem {
  reviewLinks: string[];
  updated: string;
  account: string;
}
export function selectAutomaticDeliveryWork(
  items: AutomaticSourceItem[],
  parents: string[],
  definition: DeliveryTemplateDefinition,
  input: DeliveryAutomaticPlanInput,
) {
  const blockers: DeliveryAutomaticPlan["blockers"] = [],
    excluded: DeliveryAutomaticPlan["excluded"] = [];
  const parentKey =
    input.parentKey ?? (parents.length === 1 ? parents[0] : null);
  if (!parentKey || !parents.includes(parentKey))
    blockers.push({
      code: "parent",
      message: "条目有多个主工单或缺少主工单，请明确本次交付范围",
    });
  const config: DeliveryWorkflowConfig = {
    requestId: "",
    snapshotId: input.snapshotId,
    analysisSeatId: input.analysisSeatId ?? "",
    developmentSeatId: "",
    qaSeatId: "",
    designKey: "",
    codingKey: "",
    testCasesKey: "",
    testExecutionKey: "",
    environmentReference: input.environmentReference,
    workTasks: [],
    reviewTasks: [],
    workSeats: input.workSeats,
  };
  const selected = items.filter(
    (i) => i.parentKey === parentKey && !cancelledDeliverySource(i.status),
  );
  for (const item of items.filter((i) => i.parentKey)) {
    if (item.parentKey !== parentKey)
      excluded.push({ jiraKey: item.key, reason: "不属于本次主工单" });
    else if (cancelledDeliverySource(item.status))
      excluded.push({ jiraKey: item.key, reason: "来源已取消或作废" });
    else if (
      !DELIVERY_STAGES.some(
        (s) =>
          definition.stages[s].enabled &&
          (matchesDeliveryWorkType(s, false, item.type) ||
            (definition.stages[s].taskSequence === "work_then_review" &&
              matchesDeliveryWorkType(s, true, item.type))),
      )
    )
      excluded.push({
        jiraKey: item.key,
        reason: "项目模板未启用对应类型节点",
      });
  }
  for (const stage of DELIVERY_STAGES) {
    const policy = definition.stages[stage];
    if (!policy.enabled || stage === "analysis") continue;
    const work = selected.filter((i) =>
      matchesDeliveryWorkType(stage, false, i.type),
    );
    if (!work.length)
      blockers.push({
        code: "missing_work",
        message: DELIVERY_STAGE_LABELS[stage] + "缺少真实工作子单",
      });
    for (const row of work)
      config.workTasks!.push({ stage, jiraKey: row.key, seatId: "" });
    if (policy.taskSequence !== "work_then_review") continue;
    const reviews = selected.filter((i) =>
      matchesDeliveryWorkType(stage, true, i.type),
    );
    if (!reviews.length)
      blockers.push({code: "missing_review", message: DELIVERY_STAGE_LABELS[stage] + "缺少对应类型的评审子单，请在 Jira 补齐后同步来源"});
    for (const review of reviews) {
      if (["design", "coding", "test-cases"].includes(stage))
        config.reviewTasks!.push({
          stage: stage as "design" | "coding" | "test-cases",
          jiraKey: review.key,
          workKeys: work.map(w => w.key),
        });
    }
  }
  const keys = new Set([
    ...config.workTasks!.map((t) => t.jiraKey),
    ...config.reviewTasks!.map((t) => t.jiraKey),
  ]);
  if (
    input.workSeats?.some((s) => !keys.has(s.jiraKey)) ||
    input.passedTests?.some(
      (t) =>
        !config.workTasks!.some(
          (w) => w.jiraKey === t.jiraKey && w.stage === "functional-test",
        ),
    )
  )
    blockers.push({
      code: "invalid_override",
      message: "例外配置包含本次计划以外的工单",
    });
  return { config, blockers, excluded, parentKey };
}
