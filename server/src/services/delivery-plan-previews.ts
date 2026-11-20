import { and, desc, eq, sql } from "drizzle-orm";
import { activityLog, deliveryPlanPreviews, deliverySnapshots, type Db } from "@paperclipai/db";
import type { DeliveryAutomaticPlan, DeliveryAutomaticPlanInput, DeliverySavedAutomaticPlan } from "@paperclipai/shared";
import { conflict, notFound } from "../errors.js";
import { buildAutomaticDeliveryPlan } from "./delivery-automatic-plan.js";

async function readEntry(db: Db, companyId: string, snapshotId: string) {
  const [entry] = await db.select({
    companyId: deliverySnapshots.companyId, projectId: deliverySnapshots.projectId,
    sourceOrigin: deliverySnapshots.sourceOrigin, demandNo: deliverySnapshots.demandNo,
  }).from(deliverySnapshots).where(and(eq(deliverySnapshots.companyId, companyId), eq(deliverySnapshots.id, snapshotId)));
  if (!entry) throw notFound("条目版本不存在");
  return entry;
}

export async function getSavedDeliveryPlan(db: Db, companyId: string, snapshotId: string) {
  const entry = await readEntry(db, companyId, snapshotId);
  return findPreview(db, entry);
}

async function findPreview(db: Db, entry: Awaited<ReturnType<typeof readEntry>>) {
  const [row] = await db.select({ preview: deliveryPlanPreviews.preview }).from(deliveryPlanPreviews).where(and(
    eq(deliveryPlanPreviews.companyId, entry.companyId), eq(deliveryPlanPreviews.projectId, entry.projectId),
    eq(deliveryPlanPreviews.sourceOrigin, entry.sourceOrigin), eq(deliveryPlanPreviews.demandNo, entry.demandNo),
  ));
  return row?.preview ?? null;
}

export async function generateAndSaveDeliveryPlan(
  db: Db, companyId: string, actorId: string, input: DeliveryAutomaticPlanInput, ifMissing = false,
): Promise<DeliverySavedAutomaticPlan> {
  if (ifMissing) {
    const saved = await getSavedDeliveryPlan(db, companyId, input.snapshotId);
    if (saved) return saved;
  }
  const built = await buildAutomaticDeliveryPlan(db, companyId, input);
  const { existing } = built;
  return db.transaction(async tx => {
    const store = tx as unknown as Db;
    const entry = await readEntry(store, companyId, input.snapshotId);
    const lockKey = JSON.stringify(["delivery-plan-preview", entry.companyId, entry.projectId, entry.sourceOrigin, entry.demandNo]);
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${lockKey}, 0))`);
    if (ifMissing) {
      const saved = await findPreview(store, entry);
      if (saved) return saved;
    }
    const [latest] = await tx.select({ id: deliverySnapshots.id }).from(deliverySnapshots).where(and(
      eq(deliverySnapshots.companyId, entry.companyId), eq(deliverySnapshots.projectId, entry.projectId),
      eq(deliverySnapshots.sourceOrigin, entry.sourceOrigin), eq(deliverySnapshots.demandNo, entry.demandNo),
    )).orderBy(desc(deliverySnapshots.collectedAt), desc(deliverySnapshots.createdAt), desc(deliverySnapshots.id)).limit(1);
    if (latest?.id !== input.snapshotId) throw conflict("来源版本已更新，请打开最新条目后重新生成计划");
    const plan: DeliveryAutomaticPlan = {
      ...built.plan,
      generatedAt: new Date().toISOString(),
      workflowScope: existing ? {
        id: existing.id,
        requestCount: Object.keys(existing.config.entryScope?.requests ?? {}).length,
      } : null,
    };
    const preview = { input, plan };
    const [saved] = await tx.insert(deliveryPlanPreviews).values({ ...entry, snapshotId: input.snapshotId, preview })
      .onConflictDoUpdate({
        target: [deliveryPlanPreviews.companyId, deliveryPlanPreviews.projectId, deliveryPlanPreviews.sourceOrigin, deliveryPlanPreviews.demandNo],
        set: { snapshotId: input.snapshotId, preview },
      }).returning({ id: deliveryPlanPreviews.id });
    await tx.insert(activityLog).values({
      companyId, actorType: "user", actorId, action: "delivery.plan.generated",
      entityType: "delivery_plan_preview", entityId: saved.id,
      details: { snapshotId: input.snapshotId, digest: plan.digest },
    });
    return preview;
  });
}
