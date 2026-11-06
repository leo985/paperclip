import { createHash } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { agentRuntimeState, heartbeatRuns, seatExecutionPermits, type Db } from "@paperclipai/db";
import { conflict } from "../errors.js";
import type { BudgetServiceHooks } from "./budgets.js";
import { accountFinalRunUsage } from "./run-usage-accounting.js";
import { resolveLedgerScopeForRun } from "./heartbeat.js";
import type { PermitIdentity } from "./seat-execution-permits.js";

/** Late final usage is control-plane reporting, not renewed execution authority.
 * It shares the native final-summary receipt, so live and deferred delivery
 * cannot charge the same run twice. No client-reported prices are accepted. */
export async function acceptSeatFinalUsage(db: Db, identity: PermitIdentity, input: {
  model: string; usage: { inputTokens: number; outputTokens: number; cachedInputTokens?: number };
}, hooks: BudgetServiceHooks = {}) {
  const [permit] = await db.select().from(seatExecutionPermits).where(and(
    eq(seatExecutionPermits.companyId, identity.companyId), eq(seatExecutionPermits.agentId, identity.agentId),
    eq(seatExecutionPermits.runId, identity.runId), eq(seatExecutionPermits.machineId, identity.machineId),
    eq(seatExecutionPermits.leaseHash, createHash("sha256").update(identity.lease).digest("hex")),
  ));
  if (!permit) throw conflict("用量回执与执行许可不匹配");
  const [run] = await db.select().from(heartbeatRuns).where(and(eq(heartbeatRuns.id, identity.runId), eq(heartbeatRuns.companyId, identity.companyId), eq(heartbeatRuns.agentId, identity.agentId)));
  if (!run || !run.finishedAt || !["succeeded", "failed", "cancelled", "timed_out"].includes(run.status)) throw conflict("运行尚未结算，请稍后补传最终用量");
  const scope = permit.ledgerScope ?? await resolveLedgerScopeForRun(db, identity.companyId, run);
  await db.insert(agentRuntimeState).values({ agentId: identity.agentId, companyId: identity.companyId, adapterType: "claude_local" }).onConflictDoNothing({ target: agentRuntimeState.agentId });
  const event = await accountFinalRunUsage(db, identity.companyId, {
    heartbeatRunId: run.id, agentId: identity.agentId, ...scope, provider: "unknown", biller: "unknown",
    billingType: "unknown", costStatus: "unpriced", model: input.model,
    ...input.usage, costCents: 0, occurredAt: run.finishedAt,
  }, hooks);
  return { received: true, eventId: event.id, costStatus: event.costStatus, executionGranted: false };
}
