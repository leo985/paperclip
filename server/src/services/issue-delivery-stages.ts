import { and, eq, inArray, sql } from "drizzle-orm";
import { analysisExecutions, deliveryWorkflows, type Db } from "@paperclipai/db";
import { DELIVERY_STAGES, type DeliveryStage, type DeliveryStageRecord } from "@paperclipai/shared";

/** Classify only explicitly associated tasks, including reviews, repairs and old runs. */
export function projectIssueDeliveryStages(ids: string[], analysisIds: string[], workflows: Array<{ stages: DeliveryStageRecord[] }>) {
  const requested = new Set(ids);
  const stages = new Map(ids.map(id => [id, new Set<DeliveryStage>()]));
  for (const id of analysisIds) stages.get(id)?.add("analysis");
  for (const flow of workflows) for (const record of flow.stages) {
    if (requested.has(record.taskId) && DELIVERY_STAGES.includes(record.stage)) stages.get(record.taskId)!.add(record.stage);
  }
  return new Map([...stages].map(([id, values]) => [id, DELIVERY_STAGES.filter(stage => values.has(stage))]));
}

/** The compact list already applied actor visibility; never return additional task IDs. */
export async function listIssueDeliveryStages(db: Db, companyId: string, issueIds: string[]) {
  if (!issueIds.length) return new Map<string, DeliveryStage[]>();
  const [analyses, workflows] = await Promise.all([
    db.select({ id: analysisExecutions.id }).from(analysisExecutions).where(and(eq(analysisExecutions.companyId, companyId), inArray(analysisExecutions.id, issueIds))),
    db.select({ stages: deliveryWorkflows.stages }).from(deliveryWorkflows).where(and(eq(deliveryWorkflows.companyId, companyId), sql`exists (select 1 from jsonb_array_elements(${deliveryWorkflows.stages}) stage where stage->>'taskId' in (${sql.join(issueIds.map(id => sql`${id}`), sql`, `)}))`)),
  ]);
  return projectIssueDeliveryStages(issueIds, analyses.map(row => row.id), workflows);
}
