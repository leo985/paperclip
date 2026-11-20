import { and, eq, inArray, or, sql } from "drizzle-orm";
import { activityLog, environmentLeases, heartbeatRuns, nativeRunFinalizations, seatExecutionPermits, type agents, type issues, type Db } from "@paperclipai/db";
import { conflict } from "../errors.js";
import { CONVERSATION_CONTINUATION_POLICY, historicalAdapterType } from "./conversation-continuation.js";
import { getExecutionBlocker } from "./execution-blocker.js";

/** Explicit analysis dispatch only. A device's authenticated whole-tree receipt
 * ends execution ownership; it does not declare any earlier action successful.
 * Caller holds the seat/analysis locks and rolls back on any remaining hold.
 */
export async function acknowledgeStoppedAnalysisExecution(db: Db, input: {
  agent: typeof agents.$inferSelect;
  issue: typeof issues.$inferSelect;
  actorId: string;
}) {
  const { agent, issue, actorId } = input;
  const blocker = await getExecutionBlocker(db, issue.companyId, issue.id);
  if (!blocker) return;
  const blocked = () => conflict("分析启动被执行保护拦截：请先确认旧运行进程树已退出，并等待本机退出回执；本次未进入排队。", { executionBlocker: blocker });
  if (blocker.cause !== "legacy_execution_requires_reconciliation" || !blocker.runId ||
      issue.companyId !== agent.companyId || issue.assigneeAgentId !== agent.id ||
      agent.adapterConfig.dsp7Transport !== "outbound") throw blocked();
  const [run] = await db.select().from(heartbeatRuns).where(and(eq(heartbeatRuns.id, blocker.runId),
    eq(heartbeatRuns.companyId, issue.companyId), eq(heartbeatRuns.agentId, agent.id))).for("update");
  const [permit] = await db.select().from(seatExecutionPermits).where(and(
    eq(seatExecutionPermits.runId, blocker.runId), eq(seatExecutionPermits.companyId, issue.companyId),
    eq(seatExecutionPermits.agentId, agent.id), eq(seatExecutionPermits.taskId, issue.id),
    eq(seatExecutionPermits.machineId, String((agent.adapterConfig.dsp7Seat as Record<string, unknown> | undefined)?.machineId ?? "00000000-0000-0000-0000-000000000000")),
  )).for("update");
  if (!run || run.runtimeMode !== "legacy" || !["cancelled", "failed", "timed_out"].includes(run.status) || !run.finishedAt ||
      (run.nativeIssueId ?? run.contextSnapshot?.issueId) !== issue.id ||
      run.contextSnapshot?.analysisExecutionId !== issue.id ||
      !String(run.contextSnapshot?.wakeReason ?? "").startsWith("智研需求分析授权启动；") ||
      await historicalAdapterType(db, run) !== "claude_local" ||
      !permit?.treeStopVerifiedAt || !permit.processExitObservedAt || !permit.revokedAt ||
      run.processPid || run.processGroupId) throw blocked();
  const [active] = await db.select({ id: heartbeatRuns.id }).from(heartbeatRuns).where(and(
    eq(heartbeatRuns.companyId, issue.companyId),
    or(eq(heartbeatRuns.nativeIssueId, issue.id), sql`${heartbeatRuns.contextSnapshot}->>'issueId' = ${issue.id}`),
    inArray(heartbeatRuns.status, ["queued", "running", "scheduled_retry"]),
  )).limit(1);
  const leases = await db.select().from(environmentLeases).where(and(eq(environmentLeases.companyId, issue.companyId), eq(environmentLeases.heartbeatRunId, run.id)));
  const [coordinator] = await db.select({ id: nativeRunFinalizations.runId }).from(nativeRunFinalizations).where(and(eq(nativeRunFinalizations.companyId, issue.companyId), eq(nativeRunFinalizations.runId, run.id))).limit(1);
  if (active || coordinator || leases.some(l => !l.releasedAt || l.status === "pending_cleanup" || l.cleanupStatus === "failed")) throw blocked();
  const acknowledgedAt = new Date().toISOString();
  await db.update(heartbeatRuns).set({ resultJson: {
    ...run.resultJson, conversationContinuation: CONVERSATION_CONTINUATION_POLICY, localStopRequiresVerification: false,
    analysisStopVerification: { actorId, acknowledgedAt, permitId: permit.id, treeStopVerifiedAt: permit.treeStopVerifiedAt.toISOString(), proof: "authenticated_permit_tree_exit", actionOutcome: "unknown" },
    ...(run.status === "cancelled" ? { executionCancellation: { ...(run.resultJson?.executionCancellation as Record<string, unknown> | undefined), state: "acknowledged", acknowledgedAt, proof: "authenticated_permit_tree_exit" } } : {}),
  }, updatedAt: new Date() }).where(and(eq(heartbeatRuns.id, run.id), eq(heartbeatRuns.companyId, issue.companyId)));
  if (await getExecutionBlocker(db, issue.companyId, issue.id)) throw blocked();
  await db.insert(activityLog).values({ companyId: issue.companyId, agentId: agent.id, actorType: "user", actorId,
    action: "analysis.execution_stop.acknowledged", entityType: "issue", entityId: issue.id,
    details: { runId: run.id, permitId: permit.id, proof: "authenticated_permit_tree_exit", continuation: "explicit_analysis_dispatch", actionOutcome: "unknown" } });
}
