import { and, desc, eq, sql } from "drizzle-orm";
import { activityLog, agents, agentWakeupRequests, analysisExecutions, heartbeatRuns, issues, type Db } from "@paperclipai/db";
import { conflict } from "../errors.js";
import { getExecutionBlocker } from "./execution-blocker.js";

const rejected = new Set(["skipped", "failed", "cancelled", "timed_out"]);
export async function analysisDispatchProblem(db: Db, task: { id: string; companyId: string; seatId: string; dispatchId: string | null; state: string; activeRunId: string | null; delivery: unknown }) {
  if (task.delivery || task.activeRunId || task.state !== "queued") return null;
  const blocker = await getExecutionBlocker(db, task.companyId, task.id);
  if (blocker) return "分析尚未启动：旧运行存在执行保护。请点击核验并恢复分析；系统将检查本机进程树退出回执，不会自动重复执行。";
  const [wake] = task.dispatchId ? await db.select({ status: agentWakeupRequests.status, error: agentWakeupRequests.error }).from(agentWakeupRequests).where(and(
    eq(agentWakeupRequests.companyId, task.companyId), eq(agentWakeupRequests.agentId, task.seatId), eq(agentWakeupRequests.idempotencyKey, "analysis-" + task.dispatchId),
  )).orderBy(desc(agentWakeupRequests.requestedAt)).limit(1) : [];
  return wake && rejected.has(wake.status) ? "分析启动未被接纳，请核对席位与执行保护后重新派发；当前没有运行在排队。" : null;
}

/** A null wake result is not proof of admission. Preserve real durable queued
 * wakes, and reconcile any already-created run before declaring rejection.
 */
export async function settleAnalysisDispatch(db: Db, input: { companyId: string; seatId: string; taskId: string; dispatchId: string; actorId: string }, reportedRun: typeof heartbeatRuns.$inferSelect | null, failure?: unknown) {
  const result = await db.transaction(async tx => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${input.seatId + ":seat-commands"},0))`);
    // Same lock order as dispatch: seat command lock, analysis row, then agent.
    const [current] = await tx.select().from(analysisExecutions).where(and(eq(analysisExecutions.id, input.taskId), eq(analysisExecutions.companyId, input.companyId))).for("update");
    if (!current || current.dispatchId !== input.dispatchId) return { run: reportedRun, rejected: false };
    await tx.select({ id: agents.id }).from(agents).where(eq(agents.id, input.seatId)).for("update");
    const [persisted] = await tx.select().from(heartbeatRuns).where(and(eq(heartbeatRuns.companyId, input.companyId), eq(heartbeatRuns.agentId, input.seatId),
      sql`${heartbeatRuns.contextSnapshot}->>'analysisExecutionId' = ${input.taskId}`, sql`${heartbeatRuns.contextSnapshot}->>'analysisDispatchId' = ${input.dispatchId}`,
    )).orderBy(desc(heartbeatRuns.createdAt)).limit(1);
    const run = persisted ?? reportedRun;
    if (run) {
      await tx.update(analysisExecutions).set({ activeRunId: run.id, updatedAt: new Date() }).where(eq(analysisExecutions.id, current.id));
      return { run, rejected: false };
    }
    const [wake] = await tx.select().from(agentWakeupRequests).where(and(eq(agentWakeupRequests.companyId, input.companyId), eq(agentWakeupRequests.agentId, input.seatId), eq(agentWakeupRequests.idempotencyKey, "analysis-" + input.dispatchId))).orderBy(desc(agentWakeupRequests.requestedAt)).limit(1);
    if (wake && !rejected.has(wake.status)) return { run: null, rejected: false };
    const message = "分析未启动：启动请求未被接纳，没有运行在排队。请核对席位及执行保护后重新派发。";
    await tx.update(analysisExecutions).set({ state: "interrupted", activeRunId: null, updatedAt: new Date() }).where(eq(analysisExecutions.id, current.id));
    await tx.update(issues).set({ status: "blocked", unblockDescriptor: { owner: "board", action: message }, updatedAt: new Date() }).where(and(eq(issues.id, current.id), eq(issues.companyId, input.companyId), eq(issues.assigneeAgentId, input.seatId), eq(issues.status, "todo")));
    await tx.insert(activityLog).values({ companyId: input.companyId, agentId: input.seatId, actorType: "user", actorId: input.actorId, action: "analysis.dispatch.rejected", entityType: "analysis_execution", entityId: current.id, details: { dispatchId: input.dispatchId, wakeStatus: wake?.status ?? null, reason: failure instanceof Error ? failure.message : wake?.reason ?? "not_admitted", runCreated: false } });
    return { run: null, rejected: true };
  });
  if (result.rejected) throw conflict("分析启动未被接纳，没有运行在排队。请刷新详情，核对席位和执行保护后重试。");
  if (failure) throw failure;
  return result.run;
}
