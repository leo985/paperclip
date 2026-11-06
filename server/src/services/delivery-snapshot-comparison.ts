import type { DeliveryPlan, DeliverySnapshotComparison } from "@paperclipai/shared";

/** Compare immutable normalized versions; absence is not a cancellation instruction. */
export function compareDeliveryPlans(before: DeliveryPlan, after: DeliveryPlan): DeliverySnapshotComparison["changes"] {
  const changes: DeliverySnapshotComparison["changes"] = [];
  function change(key: string, field: string, old: string | null, value: string | null) {
    if (old !== value) changes.push({ key, field, before: old, after: value });
  }
  for (const field of ["title", "status", "demandId"] as const) change(after.demandNo, field, before[field], after[field]);
  change(after.demandNo, "scheduleCount", String(before.scheduleCount), String(after.scheduleCount));
  const analysisSummary = (plan: DeliveryPlan) => {
    const source = plan.sourceAnalysis;
    if (!source) return null;
    const saved = source.analysisSaved === true ? "分析已保存" : source.analysisSaved === false ? "分析内容为空" : "分析内容未采集";
    return [source.sourceStatus || "来源状态未提供", saved, ...source.reviewStages.map(stage => `${stage.role || "未提供角色"}：${stage.status || "未提供状态"}`)].join(" · ");
  };
  change(after.demandNo, "sourceAnalysis", analysisSummary(before), analysisSummary(after));
  const roles = new Map(before.roles.map(role => [role.label, role.name]));
  const nextRoles = new Map(after.roles.map(role => [role.label, role.name]));
  for (const label of [...new Set([...roles.keys(), ...nextRoles.keys()])].sort()) {
    change(after.demandNo, `role:${label}`, roles.get(label) ?? null, nextRoles.get(label) ?? null);
  }
  const oldItems = new Map(before.items.map(item => [item.key, item]));
  const newItems = new Map(after.items.map(item => [item.key, item]));
  for (const key of [...new Set([...oldItems.keys(), ...newItems.keys()])].sort()) {
    const old = oldItems.get(key), next = newItems.get(key);
    if (!old || !next) { change(key, "membership", old ? old.title : null, next ? next.title : null); continue; }
    for (const field of ["parentKey", "title", "type", "status", "assignee"] as const) change(key, field, old[field], next[field]);
    change(key, "scheduled", String(old.scheduled), String(next.scheduled));
  }
  const oldMains = new Map(before.mains.map(main => [main.key, main]));
  const newMains = new Map(after.mains.map(main => [main.key, main]));
  for (const key of [...new Set([...oldMains.keys(), ...newMains.keys()])].sort()) {
    change(key, "mainSourceId", oldMains.get(key)?.sourceId ?? null, newMains.get(key)?.sourceId ?? null);
  }
  const issues = (plan: DeliveryPlan) => new Map(plan.differences.map(d => [JSON.stringify([d.key, d.code]), d]));
  const oldDiffs = issues(before), newDiffs = issues(after);
  for (const id of [...new Set([...oldDiffs.keys(), ...newDiffs.keys()])].sort()) {
    const old = oldDiffs.get(id), next = newDiffs.get(id);
    change((next ?? old)!.key, `difference:${(next ?? old)!.code}`, old?.message ?? null, next?.message ?? null);
  }
  return changes;
}
