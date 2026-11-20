import { DELIVERY_STAGES, type CompactIssue, type DeliveryStage } from "@paperclipai/shared";

export type TaskStageFilter = DeliveryStage | "all" | "other";
export function taskStageFilter(value: string | null): TaskStageFilter {
  return value === "other" || DELIVERY_STAGES.includes(value as DeliveryStage) ? value as TaskStageFilter : "all";
}
export function taskMatchesStage(issue: Pick<CompactIssue, "deliveryStages">, stage: TaskStageFilter) {
  if (stage === "all") return true;
  // A missing projection is a read/version problem, never evidence for "other".
  if (!issue.deliveryStages) return false;
  return stage === "other" ? issue.deliveryStages.length === 0 : issue.deliveryStages.includes(stage);
}
