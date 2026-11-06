import type { DeliveryStageRecord } from "@paperclipai/shared";
/** Legacy rows without graph metadata keep their original sequential semantics. */
export function readyDeliveryStages(
  stages: DeliveryStageRecord[],
): DeliveryStageRecord[] {
  const done = new Set(
    stages.filter((s) => s.state === "done").map((s) => s.taskId),
  );
  return stages.filter(
    (s, index) =>
      s.state !== "done" &&
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
