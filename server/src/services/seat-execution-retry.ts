import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { activityLog, agents, heartbeatRuns, issues, type Db } from "@paperclipai/db";
import { platformAuthorization, platformDispatchRecord } from "../routes/dsp7-jira-dispatch.js";
import { acknowledgeStoppedSeatConversation, hasSeatStopIntent } from "./seat-execution-stop.js";

export function isOutboundSeat(config: Record<string, unknown>) {
  return config.dsp7Transport === "outbound" && Boolean(config.dsp7Seat);
}
export function seatFailureCanRetry(run: typeof heartbeatRuns.$inferSelect) {
  return ["failed", "timed_out"].includes(run.status) &&
    run.contextSnapshot?.dsp7SeatAutoRetryV1 === true &&
    String(run.contextSnapshot?.wakeReason ?? "").startsWith("本地研发人员主动启动交互会话；") &&
    !run.resultJson?.dsp7StopIntent && run.resultJson?.cancelledByActorType !== "user" &&
    !run.resultJson?.dsp7_no_model_invocation &&
    ["adapter_failed", "dsp7_local_connection_lost", "process_lost", "timeout"].includes(run.errorCode ?? "");
}

/** Presence proves termination; an existing dispatch grants one fresh local start.
 * No model invocation/run is fabricated while waiting for this handshake.
 */
export async function retryStoppedSeatExecution(db: Db, agentId: string, companyId: string) {
  return db.transaction(async tx => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${agentId + ":seat-commands"},0))`);
    const [agent] = await tx.select().from(agents).where(and(eq(agents.id, agentId), eq(agents.companyId, companyId))).for("update");
    if (!agent || !isOutboundSeat(agent.adapterConfig) || ["paused", "terminated", "pending_approval"].includes(agent.status)) return null;
    const p = agent.adapterConfig.dsp7SeatPresence as { state?: string; runId?: string; activeTaskId?: string; acceptingWork?: boolean; lastSeenAt?: string; capabilities?: string[]; tasks?: Array<{ taskId: string; stoppedRunId?: string; stopRequestedRunId?: string }> } | undefined;
    const seen = Date.parse(p?.lastSeenAt ?? "");
    if (!p?.capabilities?.includes("seat-auto-retry-v1") || p.state !== "idle" || p.runId || p.activeTaskId || p.acceptingWork === false || !Number.isFinite(seen) || seen > Date.now()+5000 || Date.now()-seen >= 90000) return null;
    if ((agent.adapterConfig.dsp7JiraDispatch as { intakePaused?: boolean } | undefined)?.intakePaused) return null;
    const [active] = await tx.select({ id: heartbeatRuns.id }).from(heartbeatRuns).where(and(eq(heartbeatRuns.agentId, agent.id), inArray(heartbeatRuns.status, ["queued", "running", "scheduled_retry"]))).limit(1);
    if (active) return null;
    for (const item of p.tasks ?? []) {
      if (!item.stoppedRunId || item.stopRequestedRunId === item.stoppedRunId) continue;
      const [task] = await tx.select().from(issues).where(and(eq(issues.id, item.taskId), eq(issues.companyId, companyId), eq(issues.assigneeAgentId, agent.id))).for("update");
      if (!task || task.status !== "blocked" || !String(task.unblockDescriptor?.action ?? "").startsWith("执行已中断") || !String(task.unblockDescriptor?.action).includes(item.stoppedRunId)) continue;
      const [run] = await tx.select().from(heartbeatRuns).where(and(eq(heartbeatRuns.id, item.stoppedRunId), eq(heartbeatRuns.agentId, agent.id), eq(heartbeatRuns.companyId, companyId))).for("update");
      if (!run || !seatFailureCanRetry(run) || run.resultJson?.seatAutomaticRetry) continue;
      if (await hasSeatStopIntent(tx as unknown as Db, companyId, agent.id, run.id)) continue;
      const [latest] = await tx.select({ id: heartbeatRuns.id }).from(heartbeatRuns).where(and(
        eq(heartbeatRuns.companyId, companyId), eq(heartbeatRuns.agentId, agent.id),
        sql`(${heartbeatRuns.contextSnapshot}->>'issueId' = ${task.id} or ${heartbeatRuns.contextSnapshot}->>'taskId' = ${task.id})`,
        sql`${heartbeatRuns.contextSnapshot}->>'wakeReason' like ${'本地研发人员主动启动交互会话；%'}`,
      )).orderBy(desc(heartbeatRuns.createdAt)).limit(1);
      if (latest?.id !== run.id) continue;
      const prior = await platformDispatchRecord(tx as unknown as Db, agent, task.id);
      // Each explicit dispatch/resume owns one retry allowance. Historical failures
      // and changes to the original request must never acquire new authority.
      if (!prior || prior.createdAt > run.createdAt || prior.details?.automaticRetry) continue;
      await platformAuthorization(tx as unknown as Db, agent, task);
      await acknowledgeStoppedSeatConversation(tx as unknown as Db, { agent, task, runId: run.id, actorId: "seat-auto-retry", automatic: true });
      const commands = await tx.select().from(activityLog).where(and(eq(activityLog.companyId, companyId), eq(activityLog.agentId, agent.id), eq(activityLog.action, "dsp7.seat.command.requested"), sql`${activityLog.details}->>'taskId' = ${task.id}`));
      for (const command of commands) {
        const [last] = await tx.select().from(activityLog).where(and(eq(activityLog.companyId, companyId), eq(activityLog.entityId, command.entityId), eq(activityLog.action, "dsp7.seat.command.result"))).orderBy(sql`${activityLog.createdAt} desc`).limit(1);
        const status = String(last?.details?.status ?? "queued");
        if (["queued", "awaiting_local", "accepted", "running"].includes(status)) await tx.insert(activityLog).values({ companyId, agentId, actorType: "system", actorId: "seat-auto-retry", action: "dsp7.seat.command.result", entityType: "dsp7_seat_command", entityId: command.entityId, details: { commandId: command.entityId, status: ["accepted", "running"].includes(status) ? "failed" : "cancelled", sequence: Number(last?.details?.sequence ?? 0)+1, message: "旧进程已核验停止，关闭旧请求并准备一次本机自动重试" } });
      }
      const retry = { sourceRunId: run.id, attempt: 1, state: "awaiting_local_start" };
      const [acknowledged] = await tx.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, run.id));
      await tx.update(heartbeatRuns).set({ resultJson: { ...acknowledged.resultJson, seatAutomaticRetry: retry }, updatedAt: new Date() }).where(eq(heartbeatRuns.id, run.id));
      await tx.update(issues).set({ status: "backlog", unblockDescriptor: null, updatedAt: new Date() }).where(eq(issues.id, task.id));
      await tx.insert(activityLog).values({ companyId, agentId, actorType: "system", actorId: "seat-auto-retry", responsibleUserId: prior.responsibleUserId, action: "dsp7.platform.dispatch.changed", entityType: "issue", entityId: task.id, details: { ...prior.details, automaticRetry: retry } });
      await tx.insert(activityLog).values({ companyId, agentId, actorType: "system", actorId: "seat-auto-retry", action: "dsp7.seat.retry.authorized", entityType: "issue", entityId: task.id, details: { ...retry, previousAuthorizationId: prior.id, actionOutcome: "unknown" } });
      return retry;
    }
    return null;
  });
}
