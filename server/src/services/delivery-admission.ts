import { and, desc, eq, sql } from "drizzle-orm";
import { activityLog, analysisExecutions, deliverySnapshots, type Db } from "@paperclipai/db";
import type { DeliveryAdmission } from "@paperclipai/shared";
import { conflict } from "../errors.js";

export async function latestDeliverySnapshots(db: Db, companyId: string, projectId: string) {
  return db.select().from(deliverySnapshots).where(and(eq(deliverySnapshots.companyId,companyId),eq(deliverySnapshots.projectId,projectId),
    sql`not exists (select 1 from delivery_snapshots n where n.company_id = ${companyId} and n.project_id = ${projectId} and n.source_origin = ${deliverySnapshots.sourceOrigin} and n.demand_no = ${deliverySnapshots.demandNo} and (n.collected_at,n.created_at,n.id) > (${deliverySnapshots.collectedAt},${deliverySnapshots.createdAt},${deliverySnapshots.id}))`));
}
export async function deliveryAdmission(db: Db, snapshot: typeof deliverySnapshots.$inferSelect): Promise<DeliveryAdmission> {
  const [newer] = await db.select({id:deliverySnapshots.id}).from(deliverySnapshots).where(and(eq(deliverySnapshots.companyId,snapshot.companyId),eq(deliverySnapshots.projectId,snapshot.projectId),eq(deliverySnapshots.sourceOrigin,snapshot.sourceOrigin),eq(deliverySnapshots.demandNo,snapshot.demandNo),sql`(${deliverySnapshots.collectedAt},${deliverySnapshots.createdAt},${deliverySnapshots.id}) > (select s.collected_at,s.created_at,s.id from delivery_snapshots s where s.id = ${snapshot.id} and s.company_id = ${snapshot.companyId})`)).limit(1);
  const [analysis] = await db.select().from(analysisExecutions).where(and(eq(analysisExecutions.companyId,snapshot.companyId),eq(analysisExecutions.projectId,snapshot.projectId),eq(analysisExecutions.demandNo,snapshot.demandNo))).orderBy(desc(analysisExecutions.createdAt),desc(analysisExecutions.revision),desc(analysisExecutions.id)).limit(1);
  const [record] = await db.select().from(activityLog).where(and(eq(activityLog.companyId,snapshot.companyId),eq(activityLog.entityId,snapshot.id),eq(activityLog.action,"delivery.admission.checked"))).orderBy(desc(activityLog.createdAt),desc(activityLog.id)).limit(1);
  return evaluateDeliveryAdmission(snapshot, { newer: !!newer, analysis, record });
}

/** Shared evaluation for single-item guards and batched monthly read models. */
export function evaluateDeliveryAdmission(snapshot: typeof deliverySnapshots.$inferSelect, { newer, analysis, record }: {
  newer: boolean;
  analysis: Pick<typeof analysisExecutions.$inferSelect, "id" | "revision" | "state"> | undefined;
  record: Pick<typeof activityLog.$inferSelect, "details" | "actorId" | "createdAt"> | undefined;
}): DeliveryAdmission {
  const d = record?.details;
  const matches = !newer && d?.fingerprint === snapshot.fingerprint && (d?.analysisExecutionId ?? null) === (analysis?.id ?? null) && (d?.analysisRevision ?? null) === (analysis?.revision ?? null);
  const evidence = record && matches && typeof d?.analysisReference === "string" && typeof d?.designReference === "string" && typeof d?.designRequired === "boolean" && typeof d?.note === "string" ? { analysisReference:d.analysisReference, designReference:d.designReference, designRequired:d.designRequired, note:d.note, checkedBy:record.actorId, checkedAt:record.createdAt.toISOString() } : null;
  const reasons: string[] = [];
  if (newer) reasons.push("当前为历史来源版本，请切换最新版本核对开发准入");
  if (!evidence) reasons.push("尚未登记本来源版本的正式分析与设计准入核验；已有结论可直接登记引用，无须重复执行分析");
  if (analysis && analysis.state !== "published") reasons.push("最新平台分析修订尚未正式发布，请先完成或处理该修订");
  if (snapshot.plan.differences.length) reasons.push("存在来源结构差异，请核对轻舟与 Jira 后重新同步");
  if (!snapshot.plan.items.some(i => i.parentKey && /^(编码|前端编码)$/.test(i.type))) reasons.push("来源中尚无编码子工单");
  return { ready: reasons.length === 0, reasons, analysisExecutionId: analysis?.id ?? null, evidence };
}
/** Enforce at dispatch authorization and again before queued work can start. Existing running sessions keep their lifecycle. */
export async function assertDeliveryCodingAdmission(db: Db, companyId: string, projectId: string, jiraKey: string) {
  const snapshots = await latestDeliverySnapshots(db,companyId,projectId);
  const linked = snapshots.filter(s => s.plan.items.some(i => i.key === jiraKey && i.parentKey && /^(编码|前端编码)$/.test(i.type)));
  for (const snapshot of linked) {
    const admission = await deliveryAdmission(db,snapshot);
    if (!admission.ready) throw conflict(`${snapshot.demandNo} 暂不具备编码准入条件：${admission.reasons.join("；")}。请到需求条目详情处理。`);
  }
}
