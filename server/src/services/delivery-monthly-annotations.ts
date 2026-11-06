import { and, desc, eq, inArray } from "drizzle-orm";
import { activityLog, analysisExecutions, deliveryWorkflows, type Db } from "@paperclipai/db";
import type { DeliveryMonthlyEntries } from "@paperclipai/shared";
import { evaluateDeliveryAdmission, latestDeliverySnapshots } from "./delivery-admission.js";
import { deliveryChainAdmission } from "./delivery-chain-admission.js";
import { deliveryTemplateSettings } from "./delivery-templates.js";

/** Load current facts once per request, never cache authorization or admission decisions. */
export async function annotateMonthlyDelivery(db: Db, companyId: string, projectId: string, result: DeliveryMonthlyEntries) {
  if (!result.items.length) return;
  const snapshots = await latestDeliverySnapshots(db, companyId, projectId);
  // Preserve the existing first-match behavior for a demand with multiple origins.
  const byDemand = new Map<string, (typeof snapshots)[number]>();
  for (const snapshot of snapshots) if (!byDemand.has(snapshot.demandNo)) byDemand.set(snapshot.demandNo, snapshot);
  const selected = result.items.flatMap(item => {
    const snapshot = byDemand.get(item.demandNo);
    return snapshot ? [snapshot] : [];
  });
  if (!selected.length) return;
  const demandNos = selected.map(snapshot => snapshot.demandNo);
  const [analyses, records, flows] = await Promise.all([
    db.selectDistinctOn([analysisExecutions.demandNo]).from(analysisExecutions).where(and(
      eq(analysisExecutions.companyId, companyId), eq(analysisExecutions.projectId, projectId), inArray(analysisExecutions.demandNo, demandNos),
    )).orderBy(analysisExecutions.demandNo, desc(analysisExecutions.createdAt), desc(analysisExecutions.revision), desc(analysisExecutions.id)),
    db.selectDistinctOn([activityLog.entityId]).from(activityLog).where(and(
      eq(activityLog.companyId, companyId), eq(activityLog.action, "delivery.admission.checked"), inArray(activityLog.entityId, selected.map(snapshot => snapshot.id)),
    )).orderBy(activityLog.entityId, desc(activityLog.createdAt), desc(activityLog.id)),
    db.select().from(deliveryWorkflows).where(and(
      eq(deliveryWorkflows.companyId, companyId), eq(deliveryWorkflows.projectId, projectId), inArray(deliveryWorkflows.demandNo, demandNos),
    )),
  ]);
  const analysisByDemand = new Map(analyses.map(row => [row.demandNo, row]));
  const recordBySnapshot = new Map(records.map(row => [row.entityId, row]));
  const flowByDemand = new Map(flows.map(row => [row.demandNo, row]));
  const template = selected.some(snapshot => !flowByDemand.has(snapshot.demandNo))
    ? (await deliveryTemplateSettings(db, companyId, projectId)).effective : undefined;
  const latestSnapshotIds = new Set(snapshots.map(snapshot => snapshot.id));
  for (const item of result.items) {
    const snapshot = byDemand.get(item.demandNo);
    if (!snapshot) continue;
    const analysis = analysisByDemand.get(item.demandNo);
    item.snapshotId = snapshot.id;
    item.admission = evaluateDeliveryAdmission(snapshot, { newer: false, analysis, record: recordBySnapshot.get(snapshot.id) });
    item.chainAdmission = await deliveryChainAdmission(db, snapshot, {
      codingAdmission: item.admission, template, latestSnapshotIds,
      flow: flowByDemand.get(item.demandNo) ?? null, analysis: analysis ?? null,
    });
  }
}
