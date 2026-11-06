import { and, eq } from "drizzle-orm";
import { agents, costEvents, heartbeatRuns, runUsageCheckpoints, seatExecutionPermits, type Db } from "@paperclipai/db";
import type { SeatRunControl } from "@paperclipai/shared";
import { notFound } from "../errors.js";
export async function seatRunControl(db: Db, companyId: string, runId: string): Promise<SeatRunControl> {
  const [run] = await db.select({ id: heartbeatRuns.id, agentId: heartbeatRuns.agentId, status: heartbeatRuns.status }).from(heartbeatRuns).where(and(eq(heartbeatRuns.id, runId), eq(heartbeatRuns.companyId, companyId)));
  if (!run) throw notFound("运行不存在");
  const [agent] = await db.select({ config: agents.adapterConfig }).from(agents).where(and(eq(agents.id,run.agentId),eq(agents.companyId,companyId)));
  const [permit] = await db.select().from(seatExecutionPermits).where(and(eq(seatExecutionPermits.runId, runId), eq(seatExecutionPermits.companyId, companyId)));
  const [checkpoint] = await db.select().from(runUsageCheckpoints).where(and(eq(runUsageCheckpoints.runId, runId), eq(runUsageCheckpoints.companyId, companyId)));
  const [final] = await db.select().from(costEvents).where(and(eq(costEvents.heartbeatRunId, runId), eq(costEvents.companyId, companyId), eq(costEvents.idempotencyKey, "heartbeat-final-" + runId)));
  const source = checkpoint ?? final;
  const capability = permit?.executionRoute?.capability;
  return { runId, mode: permit ? "observed_cost" : agent?.config.dsp7Transport === "outbound" ? "legacy" : "not_applicable", stopStatus: permit?.treeStopVerifiedAt ? "verified" : ["running", "queued", "scheduled_retry"].includes(run.status) ? "running" : "pending",
    meteringStatus: final ? "final_reported" : source ? "partial_observation" : "unknown",
    tokens: source ? { inputTokens: source.inputTokens, outputTokens: source.outputTokens, cachedInputTokens: source.cachedInputTokens } : null,
    costStatus: final?.costStatus === "reported" ? "reported" : "unpriced", observedAt: (final?.occurredAt ?? checkpoint?.observedAt)?.toISOString() ?? null,
    route: capability ? { kind: capability.kind, repository: capability.repository, profile: capability.profile, commit: capability.commit } : null };
}
