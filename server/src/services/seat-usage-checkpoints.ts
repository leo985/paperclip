import { createHash } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { agentRuntimeState, costEvents, heartbeatRuns, runUsageCheckpoints, runUsageObservations, seatExecutionPermits, type Db } from "@paperclipai/db";
import { conflict } from "../errors.js";
import { costService } from "./costs.js";
import { budgetService, type BudgetServiceHooks } from "./budgets.js";
import type { PermitIdentity } from "./seat-execution-permits.js";

export type UsageObservation = { sequence: number; model: string; observedAt: string; usage: { inputTokens: number; outputTokens: number; cachedInputTokens?: number } };
export async function acceptSeatUsageCheckpoint(db: Db, identity: PermitIdentity, input: UsageObservation, hooks: BudgetServiceHooks = {}) {
  const event = await db.transaction(async transaction => {
    const tx = transaction as unknown as Db;
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${"heartbeat-final-" + identity.runId}, 0))`);
    const [permit] = await tx.select().from(seatExecutionPermits).where(and(eq(seatExecutionPermits.runId, identity.runId), eq(seatExecutionPermits.companyId, identity.companyId), eq(seatExecutionPermits.agentId, identity.agentId), eq(seatExecutionPermits.machineId, identity.machineId), eq(seatExecutionPermits.leaseHash, createHash("sha256").update(identity.lease).digest("hex"))));
    if (!permit?.ledgerScope) throw conflict("运行计量绑定缺失或回执身份不匹配");
    const [run] = await tx.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, identity.runId));
    const occurredAt = new Date(input.observedAt);
    if (!run || !Number.isFinite(occurredAt.getTime()) || occurredAt.getTime() < run.createdAt.getTime() - 5000 || occurredAt.getTime() > Date.now() + 5000) throw conflict("用量观测时间不属于该运行");
    const digest = createHash("sha256").update(JSON.stringify([input.sequence,input.model,occurredAt.toISOString(),input.usage.inputTokens,input.usage.outputTokens,input.usage.cachedInputTokens ?? 0])).digest("hex");
    const [receipt] = await tx.select().from(runUsageObservations).where(and(eq(runUsageObservations.runId, run.id), eq(runUsageObservations.sequence, input.sequence)));
    if (receipt) {
      if (receipt.digest !== digest) throw conflict("相同用量序号的内容发生变化");
      return (await tx.select().from(costEvents).where(eq(costEvents.id, receipt.eventId)))[0]!;
    }
    const [state] = await tx.select().from(runUsageCheckpoints).where(eq(runUsageCheckpoints.runId, run.id));
    const [final] = await tx.select().from(costEvents).where(and(eq(costEvents.companyId, identity.companyId), eq(costEvents.agentId, identity.agentId), eq(costEvents.idempotencyKey, "heartbeat-final-" + run.id)));
    const values = { inputTokens: input.usage.inputTokens, outputTokens: input.usage.outputTokens, cachedInputTokens: input.usage.cachedInputTokens ?? 0 };
    if (final || state?.finalDigest) {
      // Final totals are immutable. Late observations may only confirm a subset.
      const ceiling = state ?? final!;
      if (Object.keys(values).some(k => values[k as keyof typeof values] > ceiling[k as keyof typeof values])) throw conflict("观测用量超过已结算汇总，请人工对账");
      return null;
    }
    if (state && input.sequence <= state.sequence) {
      if (input.sequence === state.sequence && (state.model !== input.model || state.observedAt.getTime() !== occurredAt.getTime() || Object.keys(values).some(k => state[k as keyof typeof values] !== values[k as keyof typeof values]))) throw conflict("相同用量序号的内容发生变化");
      return null;
    }
    const delta = { inputTokens: values.inputTokens - (state?.inputTokens ?? 0), outputTokens: values.outputTokens - (state?.outputTokens ?? 0), cachedInputTokens: values.cachedInputTokens - (state?.cachedInputTokens ?? 0) };
    if (Object.values(delta).some(v => v < 0) || state && occurredAt < state.observedAt) throw conflict("累计用量或观测时间不能倒退");
    const row = await costService(tx).createEvent(identity.companyId, { agentId: identity.agentId, heartbeatRunId: run.id, ...permit.ledgerScope,
      provider: "unknown", biller: "unknown", billingType: "unknown", costStatus: "unpriced", model: input.model, ...delta, costCents: 0, occurredAt,
      idempotencyKey: `heartbeat-observed-${run.id}-${input.sequence}` });
    await tx.insert(runUsageObservations).values({ runId: run.id, sequence: input.sequence, digest, eventId: row.id });
    await tx.insert(agentRuntimeState).values({ agentId: identity.agentId, companyId: identity.companyId, adapterType: "claude_local" }).onConflictDoNothing();
    await tx.update(agentRuntimeState).set({ totalInputTokens: sql`${agentRuntimeState.totalInputTokens} + ${delta.inputTokens}`, totalOutputTokens: sql`${agentRuntimeState.totalOutputTokens} + ${delta.outputTokens}`, totalCachedInputTokens: sql`${agentRuntimeState.totalCachedInputTokens} + ${delta.cachedInputTokens}`, updatedAt: new Date() }).where(eq(agentRuntimeState.agentId, identity.agentId));
    const next = { companyId: identity.companyId, agentId: identity.agentId, sequence: input.sequence, ...values, model: input.model, scope: permit.ledgerScope, observedAt: occurredAt, updatedAt: new Date() };
    await tx.insert(runUsageCheckpoints).values({ runId: run.id, ...next }).onConflictDoUpdate({ target: runUsageCheckpoints.runId, set: next });
    await tx.update(heartbeatRuns).set({ usageJson: sql`coalesce(${heartbeatRuns.usageJson}, '{}'::jsonb) || ${JSON.stringify({ seatMetering: { protocolVersion: 1, status: "partial_observation", ...values, costStatus: "unpriced", observedAt: input.observedAt, sequence: input.sequence } })}::jsonb` }).where(eq(heartbeatRuns.id, run.id));
    return row;
  });
  if (event) await budgetService(db, hooks).evaluateCostEvent(event);
  return { received: true, costStatus: "unpriced", usageStatus: "partial_observation", executionGranted: false };
}
