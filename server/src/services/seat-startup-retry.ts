import { and, desc, eq, inArray, or, sql } from "drizzle-orm";
import { activityLog, agents, heartbeatRuns, issues, type Db } from "@paperclipai/db";
import { hasSeatStopIntent } from "./seat-execution-stop.js";

/** A failed command is not proof that its model process has stopped. */
export async function startupRetryBlockedReason(db: Db, agent: typeof agents.$inferSelect, task: typeof issues.$inferSelect) {
  if (!["backlog", "todo", "in_progress"].includes(task.status)) return "请在任务页处理当前阻塞或结束状态";
  if (task.assigneeAgentId && task.assigneeAgentId !== agent.id) return "任务已分派给其他席位";
  const [authorization] = await db.select().from(activityLog).where(and(eq(activityLog.companyId, agent.companyId), eq(activityLog.agentId, agent.id), eq(activityLog.entityId, task.id), eq(activityLog.action, "dsp7.platform.dispatch.changed"))).orderBy(desc(activityLog.createdAt)).limit(1);
  const [command] = await db.select().from(activityLog).where(and(eq(activityLog.companyId, agent.companyId), eq(activityLog.agentId, agent.id), eq(activityLog.action, "dsp7.seat.command.requested"), sql`${activityLog.details}->>'taskId' = ${task.id}`)).orderBy(desc(activityLog.createdAt)).limit(1);
  if (authorization?.details?.state !== "authorized" || !command || command.createdAt < authorization.createdAt) return "没有当前派单的失败启动请求，请刷新任务";
  const [receipt] = await db.select().from(activityLog).where(and(eq(activityLog.companyId, agent.companyId), eq(activityLog.agentId, agent.id), eq(activityLog.action, "dsp7.seat.command.result"), eq(activityLog.entityId, command.entityId))).orderBy(sql`(${activityLog.details}->>'sequence')::int desc`).limit(1);
  if (!["failed", "denied", "expired", "cancelled"].includes(String(receipt?.details?.status))) return "启动请求尚未确认失败，请等待本机回执或到任务页处理";
  const p = agent.adapterConfig.dsp7SeatPresence as { state?: string; capabilities?: string[]; lastSeenAt?: string; activeTaskId?: string; runId?: string; activeRuns?: Array<{ taskId: string }>; tasks?: Array<{ taskId: string; stoppedRunId?: string; stopRequestedRunId?: string }> } | undefined;
  const seen = Date.parse(p?.lastSeenAt ?? "");
  if (!Number.isFinite(seen) || seen > Date.now() + 5000 || Date.now() - seen >= 90000) return "请等待席位上线并核验旧进程已停止";
  if ((p?.activeTaskId === task.id && p.runId) || p?.activeRuns?.some(run => run.taskId === task.id)) return "本机仍有活动执行，请在任务页处理";
  const scope = and(eq(heartbeatRuns.companyId, agent.companyId), or(eq(heartbeatRuns.nativeIssueId, task.id), sql`(${heartbeatRuns.contextSnapshot}->>'issueId' = ${task.id} or ${heartbeatRuns.contextSnapshot}->>'taskId' = ${task.id})`));
  const [active] = await db.select().from(heartbeatRuns).where(and(scope, inArray(heartbeatRuns.status, ["queued", "running", "scheduled_retry"]))).limit(1);
  if (active) return "工单仍有活动运行，不能重复启动";
  // Comment/poll wakes can record a no-model failure after the real session.
  // The machine proves termination of its latest interactive session, not those wakes.
  const [latest] = await db.select().from(heartbeatRuns).where(and(scope,
    sql`${heartbeatRuns.contextSnapshot}->>'wakeReason' like ${"本地研发人员主动启动交互会话；%"}`,
  )).orderBy(desc(heartbeatRuns.createdAt)).limit(1);
  if (latest) {
    if (agent.adapterConfig.dsp7Transport !== "outbound" || p?.state !== "idle" || p.runId || p.activeTaskId || !p.capabilities?.includes("execution-recovery-v1")) return "请等待支持中断恢复的席位空闲后重新核验";
    const proof = p?.tasks?.find(item => item.taskId === task.id);
    if (latest.agentId !== agent.id || !["failed", "timed_out", "cancelled"].includes(latest.status) || proof?.stoppedRunId !== latest.id) return "尚未确认本机旧执行已经停止，请稍后刷新或在任务页处理";
    if (proof.stopRequestedRunId === latest.id || latest.resultJson?.dsp7StopIntent || latest.resultJson?.cancelledByActorType === "user" || await hasSeatStopIntent(db, agent.companyId, agent.id, latest.id)) return "旧执行已明确停止，请在任务页恢复执行";
  } else if (task.status === "in_progress") {
    return "任务已标记执行中但缺少运行记录，请在任务页核对";
  }
  return null;
}
