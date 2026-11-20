import type { DeliveryStageRecord } from "@paperclipai/shared";
export const isHistoricalDelivery = (stage: DeliveryStageRecord) =>
  !!(stage.priorCompletion || stage.historicalVerification || stage.deferredPriorCompletion);

/** Legacy rows without graph metadata keep their original sequential semantics. */
export function readyDeliveryStages(
  stages: DeliveryStageRecord[],
): DeliveryStageRecord[] {
  const done = new Set(
    stages.filter((s) => s.state === "done").map((s) => s.taskId),
  );
  return stages.filter(
    (s, index) =>
      s.state !== "done" && !s.branchBlocked &&
      (s.dependsOn ?? stages.slice(0, index).map((x) => x.taskId)).every((id) =>
        done.has(id),
      ),
  );
}
export function deliveryStageCanStart(stage: DeliveryStageRecord) {
  return stage.startMode !== "confirmation" || !!stage.startApprovedBy;
}
export function assertDeliveryGraph(stages: DeliveryStageRecord[]) {
  const ids = new Set(stages.map((s) => s.taskId));
  if (ids.size !== stages.length) throw Error("交付流程存在重复阶段编号");
  const visited = new Set<string>();
  for (let i = 0; i < stages.length; i++) {
    const stage = stages[i];
    const dependencies =
      stage.dependsOn ?? stages.slice(0, i).map((s) => s.taskId);
    if (dependencies.some((id) => !ids.has(id) || !visited.has(id)))
      throw Error("交付流程依赖不存在、形成环或顺序无效");
    visited.add(stage.taskId);
  }
}

export function deliveryAncestors(
  stages: DeliveryStageRecord[],
  taskId: string,
): Set<string> {
  const result = new Set<string>();
  function visit(id: string) {
    const i = stages.findIndex((s) => s.taskId === id);
    if (i < 0) return;
    for (const dep of stages[i].dependsOn ??
      stages.slice(0, i).map((s) => s.taskId)) {
      if (!result.has(dep)) {
        result.add(dep);
        visit(dep);
      }
    }
  }
  visit(taskId);
  return result;
}

/** Reorder independent branches after an authorized dependency change. */
export function orderDeliveryGraph(stages: DeliveryStageRecord[]) {
  const byId = new Map(stages.map(stage => [stage.taskId, stage]));
  const ordered: DeliveryStageRecord[] = [];
  const visited = new Set<string>();
  const visiting = new Set<string>();
  function visit(stage: DeliveryStageRecord) {
    if (visited.has(stage.taskId)) return;
    if (visiting.has(stage.taskId)) throw Error("交付流程依赖形成环");
    visiting.add(stage.taskId);
    for (const id of stage.dependsOn ?? []) {
      const upstream = byId.get(id);
      if (!upstream) throw Error("交付流程前置节点不存在");
      visit(upstream);
    }
    visiting.delete(stage.taskId);
    visited.add(stage.taskId);
    ordered.push(stage);
  }
  for (const stage of stages) visit(stage);
  return ordered;
}
