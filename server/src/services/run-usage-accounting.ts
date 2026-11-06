import { createHash } from "node:crypto";
import { conflict } from "../errors.js";
import { and, eq, sql } from "drizzle-orm";
import { agentRuntimeState, costEvents, heartbeatRuns, runUsageCheckpoints, type Db } from "@paperclipai/db";
import { costService } from "./costs.js";
import { budgetService, type BudgetServiceHooks } from "./budgets.js";

/** Final summaries are immutable. The receipt and runtime totals commit together;
 * enforcement is retried after commit, never cancelling remote work in a DB lock.
 * Streaming producers must not reuse this final-summary protocol. */
export async function accountFinalRunUsage(
  db: Db,
  companyId: string,
  data: Omit<typeof costEvents.$inferInsert, "companyId" | "idempotencyKey"> & { heartbeatRunId: string },
  hooks: BudgetServiceHooks = {},
) {
  const idempotencyKey = `heartbeat-final-${data.heartbeatRunId}`;
  const event = await db.transaction(async tx => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${idempotencyKey}, 0))`);
    const [existing] = await tx.select({ id: costEvents.id }).from(costEvents).where(and(
      eq(costEvents.companyId, companyId), eq(costEvents.agentId, data.agentId),
      eq(costEvents.idempotencyKey, idempotencyKey),
    ));
    const [checkpoint] = await tx.select().from(runUsageCheckpoints).where(eq(runUsageCheckpoints.runId, data.heartbeatRunId));
    const scope = checkpoint?.scope ?? data;
    const digest = createHash("sha256").update(JSON.stringify([companyId, data.agentId, data.heartbeatRunId,
      scope.issueId ?? null, scope.projectId ?? null, data.goalId ?? null, scope.billingCode ?? null,
      data.provider, data.biller ?? "unknown", data.billingType ?? "unknown", data.costStatus ?? "reported", data.model,
      data.inputTokens ?? 0, data.outputTokens ?? 0, data.cachedInputTokens ?? 0, data.costCents, data.occurredAt.toISOString()])).digest("hex");
    if (checkpoint?.finalDigest && checkpoint.finalDigest !== digest) throw conflict("Final usage receipt already exists with different content");
    const delta = checkpoint ? {
      inputTokens: (data.inputTokens ?? 0) - checkpoint.inputTokens,
      outputTokens: (data.outputTokens ?? 0) - checkpoint.outputTokens,
      cachedInputTokens: (data.cachedInputTokens ?? 0) - checkpoint.cachedInputTokens,
    } : {};
    if (Object.values(delta).some(value => value < 0)) throw conflict("最终用量小于已观测用量，请人工对账");
    const ledgerData = checkpoint ? { ...data, ...checkpoint.scope, ...delta } : data;
    // On a final replay use the persisted delta; full totals were checked above.
    const prior = existing && checkpoint?.finalDigest ? (await tx.select().from(costEvents).where(eq(costEvents.id, existing.id)))[0] : null;
    const event = prior ?? await costService(tx as unknown as Db).createEvent(companyId, { ...ledgerData, idempotencyKey });
    if (checkpoint && !checkpoint.finalDigest) await tx.update(runUsageCheckpoints).set({ inputTokens: data.inputTokens ?? 0, outputTokens: data.outputTokens ?? 0, cachedInputTokens: data.cachedInputTokens ?? 0, finalDigest: digest, updatedAt: new Date() }).where(eq(runUsageCheckpoints.runId, data.heartbeatRunId));
    if (checkpoint) await tx.update(heartbeatRuns).set({ usageJson: sql`coalesce(${heartbeatRuns.usageJson}, '{}'::jsonb) || ${JSON.stringify({ seatMetering: { protocolVersion: 1, status: "final_reported", inputTokens: data.inputTokens ?? 0, outputTokens: data.outputTokens ?? 0, cachedInputTokens: data.cachedInputTokens ?? 0, costStatus: data.costStatus ?? "reported", observedAt: data.occurredAt.toISOString() } })}::jsonb` }).where(eq(heartbeatRuns.id, data.heartbeatRunId));
    if (!existing) {
      const [state] = await tx.update(agentRuntimeState).set({
        totalInputTokens: sql`${agentRuntimeState.totalInputTokens} + ${ledgerData.inputTokens ?? 0}`,
        totalOutputTokens: sql`${agentRuntimeState.totalOutputTokens} + ${ledgerData.outputTokens ?? 0}`,
        totalCachedInputTokens: sql`${agentRuntimeState.totalCachedInputTokens} + ${ledgerData.cachedInputTokens ?? 0}`,
        totalCostCents: sql`${agentRuntimeState.totalCostCents} + ${data.costCents}`,
        updatedAt: new Date(),
      }).where(eq(agentRuntimeState.agentId, data.agentId)).returning({ id: agentRuntimeState.agentId });
      if (!state) throw new Error("Runtime state must exist before usage accounting");
    }
    return event;
  });
  await budgetService(db, hooks).evaluateCostEvent(event);
  return event;
}
