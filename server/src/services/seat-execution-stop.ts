import { and, eq, inArray, or, sql } from "drizzle-orm";
import { activityLog, agents, environmentLeases, heartbeatRuns, issues, nativeRunFinalizations, type Db } from "@paperclipai/db";
import { conflict } from "../errors.js";
import { CONVERSATION_CONTINUATION_POLICY, historicalAdapterType } from "./conversation-continuation.js";
import { getExecutionBlocker } from "./execution-blocker.js";

// The audit survives adapter result replacement while cancellation settles.
export async function hasSeatStopIntent(db: Db, companyId: string, agentId: string, runId: string) {
  const [intent] = await db.select({ id: activityLog.id }).from(activityLog).where(and(
    eq(activityLog.companyId, companyId), eq(activityLog.agentId, agentId),
    eq(activityLog.action, "dsp7.seat.stop.requested"), eq(activityLog.entityId, runId),
  )).limit(1);
  return Boolean(intent);
}

async function fencePendingSeatRetry(db: Db, run: typeof heartbeatRuns.$inferSelect) {
  const taskId = run.nativeIssueId ?? run.contextSnapshot?.issueId;
  if (typeof taskId !== "string") return;
  const [authorization] = await db.select().from(activityLog).where(and(
    eq(activityLog.companyId, run.companyId), eq(activityLog.agentId, run.agentId),
    eq(activityLog.action, "dsp7.platform.dispatch.changed"), eq(activityLog.entityId, taskId),
  )).orderBy(sql`${activityLog.createdAt} desc`).limit(1);
  if ((authorization?.details?.automaticRetry as { sourceRunId?: string } | undefined)?.sourceRunId !== run.id) return;
  // A late Stop must leave a visible, resumable interruption rather than an
  // indefinitely pending retry. A subsequent explicit resume is fresh authority.
  await db.update(issues).set({ status: "blocked", updatedAt: new Date(), unblockDescriptor: {
    owner: "board", action: `执行已中断：已记录用户停止指令，不自动重试；请在网页明确恢复执行。 运行编号：${run.id}`,
  } }).where(and(eq(issues.id, taskId), eq(issues.companyId, run.companyId),
    eq(issues.assigneeAgentId, run.agentId), inArray(issues.status, ["backlog", "todo"])));
}

export async function recordBoardSeatStopIntent(db: Db, run: typeof heartbeatRuns.$inferSelect, actorId: string) {
  await db.transaction(async tx => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${run.agentId + ":seat-commands"},0))`);
    const [agent] = await tx.select().from(agents).where(and(eq(agents.id, run.agentId), eq(agents.companyId, run.companyId))).for("update");
    if (!agent || agent.adapterConfig.dsp7Transport !== "outbound" || !agent.adapterConfig.dsp7Seat) return;
    if (await hasSeatStopIntent(tx as unknown as Db, run.companyId, run.agentId, run.id)) return;
    const intent = { source: "board_stop", requestedAt: new Date().toISOString(), actorId };
    await tx.update(heartbeatRuns).set({ resultJson: sql`coalesce(${heartbeatRuns.resultJson}, '{}'::jsonb) || ${JSON.stringify({ dsp7StopIntent: intent })}::jsonb`, updatedAt: new Date() }).where(eq(heartbeatRuns.id, run.id));
    await tx.insert(activityLog).values({ companyId: run.companyId, agentId: run.agentId, actorType: "user", actorId, action: "dsp7.seat.stop.requested", entityType: "heartbeat_run", entityId: run.id, details: intent });
    await fencePendingSeatRetry(tx as unknown as Db, run);
  });
}

/** Called under the seat/task locks, after explicit resume or bounded retry authorization.
 * The authenticated machine's stoppedRunId is termination evidence, never evidence
 * that earlier external actions succeeded or did not happen.
 */
export async function acknowledgeStoppedSeatConversation(db: Db, input: {
  agent: typeof agents.$inferSelect;
  task: typeof issues.$inferSelect;
  runId: string;
  actorId: string;
  automatic?: boolean;
}) {
  const { agent, task, runId, actorId } = input;
  const presence = agent.adapterConfig.dsp7SeatPresence as {
    lastSeenAt?: string; state?: string; runId?: string | null;
    activeTaskId?: string | null; capabilities?: string[];
    tasks?: Array<{ taskId: string; stoppedRunId?: string }>;
  } | undefined;
  const seen = Date.parse(presence?.lastSeenAt ?? "");
  if (presence?.state === "config_error") throw conflict("本机 Claude 配置或版本与登记不一致，请在席位的设备与诊断中刷新登记，等待检查通过后再恢复");
  if (presence?.state && presence.state !== "idle") throw conflict("席位当前不是空闲状态，请先处理本机执行或配置检查后再恢复");
  if (task.companyId !== agent.companyId || task.assigneeAgentId !== agent.id ||
      agent.adapterConfig.dsp7Transport !== "outbound" || !agent.adapterConfig.dsp7Seat ||
      !presence?.capabilities?.includes("execution-recovery-v1") ||
      !Number.isFinite(seen) || seen > Date.now() + 5000 || Date.now() - seen >= 90000 ||
      presence.state !== "idle" || presence.runId || presence.activeTaskId ||
      presence.tasks?.find(t => t.taskId === task.id)?.stoppedRunId !== runId) {
    throw conflict("席位身份、负责人或停止证明已变化，请等待本机重新核验");
  }
  const [run] = await db.select().from(heartbeatRuns).where(and(
    eq(heartbeatRuns.companyId, agent.companyId), eq(heartbeatRuns.agentId, agent.id),
    eq(heartbeatRuns.id, runId),
  )).for("update");
  if (!run || run.runtimeMode !== "legacy" || !["cancelled", "failed", "timed_out"].includes(run.status) ||
      !run.finishedAt || (run.nativeIssueId ?? run.contextSnapshot?.issueId) !== task.id ||
      !String(run.contextSnapshot?.wakeReason ?? "").startsWith("本地研发人员主动启动交互会话；") ||
      await historicalAdapterType(db, run) !== "claude_local") {
    throw conflict("旧运行不是已停止的本机 Claude 会话，不能通过席位恢复解除执行保护");
  }
  const [active] = await db.select({ id: heartbeatRuns.id }).from(heartbeatRuns).where(and(
    eq(heartbeatRuns.companyId, agent.companyId),
    or(eq(heartbeatRuns.agentId, agent.id), eq(heartbeatRuns.nativeIssueId, task.id),
      sql`${heartbeatRuns.contextSnapshot}->>'issueId' = ${task.id}`),
    inArray(heartbeatRuns.status, ["queued", "running", "scheduled_retry"]),
  )).limit(1);
  const leases = await db.select().from(environmentLeases).where(and(
    eq(environmentLeases.companyId, agent.companyId), eq(environmentLeases.heartbeatRunId, run.id),
  ));
  const [coordinator] = await db.select().from(nativeRunFinalizations).where(and(
    eq(nativeRunFinalizations.companyId, agent.companyId), eq(nativeRunFinalizations.runId, run.id),
  ));
  if (active || run.processPid || run.processGroupId || coordinator ||
      leases.some(lease => !lease.releasedAt || lease.status === "pending_cleanup" || lease.cleanupStatus === "failed")) {
    throw conflict("旧执行仍有控制器、进程或未释放的环境，请等待清理完成");
  }
  const acknowledgedAt = new Date().toISOString();
  const cancellation = run.resultJson?.executionCancellation as Record<string, unknown> | undefined;
  await db.update(heartbeatRuns).set({
    resultJson: {
      ...run.resultJson,
      conversationContinuation: CONVERSATION_CONTINUATION_POLICY,
      localStopRequiresVerification: false,
      seatStopVerification: { taskId: task.id, machineId: (agent.adapterConfig.dsp7Seat as Record<string, unknown>).machineId,
        actorId, acknowledgedAt, heartbeatAt: presence.lastSeenAt, proof: "authenticated_machine_process_absence" },
      ...(run.status === "cancelled" ? { executionCancellation: { ...cancellation,
        state: "acknowledged", acknowledgedAt, proof: "authenticated_machine_process_absence" } } : {}),
    }, updatedAt: new Date(),
  }).where(and(eq(heartbeatRuns.companyId, agent.companyId), eq(heartbeatRuns.id, run.id)));
  // Keep unrelated recovery holds effective. A rejection rolls back the proof
  // together with the surrounding dispatch transaction.
  if (await getExecutionBlocker(db, agent.companyId, task.id)) {
    throw conflict("任务仍有其他执行保护，请检查关联运行后恢复");
  }
  await db.insert(activityLog).values({ companyId: agent.companyId, agentId: agent.id,
    actorType: input.automatic ? "system" : "user", actorId, action: "dsp7.seat.execution_stop.acknowledged",
    entityType: "issue", entityId: task.id,
    details: { runId, proof: "authenticated_machine_process_absence", heartbeatAt: presence.lastSeenAt,
      continuation: input.automatic ? "bounded_seat_retry" : "explicit_platform_resume", actionOutcome: "unknown" },
  });
}

/** Durable intent precedes any signal/cancel, including a later failed exit. */
export async function recordSeatStopIntent(db: Db, agent: typeof agents.$inferSelect, runId: string, taskId?: string) {
  const [run] = await db.select().from(heartbeatRuns).where(and(eq(heartbeatRuns.id, runId), eq(heartbeatRuns.companyId, agent.companyId), eq(heartbeatRuns.agentId, agent.id))).for("update");
  const issueId = run?.nativeIssueId ?? run?.contextSnapshot?.issueId;
  const [task] = typeof issueId === "string" ? await db.select().from(issues).where(and(eq(issues.id, issueId), eq(issues.companyId, agent.companyId), eq(issues.assigneeAgentId, agent.id))).limit(1) : [];
  if (!run || !task || (taskId && task.id !== taskId) || agent.adapterConfig.dsp7Transport !== "outbound" || !agent.adapterConfig.dsp7Seat) throw conflict("停止请求与本席位运行不匹配");
  if (run.resultJson?.dsp7StopIntent) return run;
  const intent = { source: "harness_stop", requestedAt: new Date().toISOString(), agentId: agent.id, taskId: task.id };
  const [updated] = await db.update(heartbeatRuns).set({ resultJson: { ...run.resultJson, dsp7StopIntent: intent }, updatedAt: new Date() }).where(eq(heartbeatRuns.id, run.id)).returning();
  await db.insert(activityLog).values({ companyId: agent.companyId, agentId: agent.id, actorType: "agent", actorId: agent.id, action: "dsp7.seat.stop.requested", entityType: "heartbeat_run", entityId: run.id, details: intent });
  await fencePendingSeatRetry(db, run);
  return updated;
}

/** Budget enforcement must leave durable intent before in-memory cancellation.
 * The machine's later stoppedRunId is still required as exit evidence. */
export async function recordBudgetSeatStopIntent(db: Db, run: typeof heartbeatRuns.$inferSelect) {
  await db.transaction(async tx => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${run.agentId + ":seat-commands"},0))`);
    const [agent] = await tx.select().from(agents).where(and(eq(agents.id, run.agentId), eq(agents.companyId, run.companyId))).for("update");
    if (!agent || agent.adapterConfig.dsp7Transport !== "outbound" || !agent.adapterConfig.dsp7Seat) return;
    if (await hasSeatStopIntent(tx as unknown as Db, run.companyId, run.agentId, run.id)) return;
    const intent = { source: "budget", requestedAt: new Date().toISOString(), actorId: "budget_service", stopRequiresVerification: true };
    await tx.update(heartbeatRuns).set({ resultJson: sql`coalesce(${heartbeatRuns.resultJson}, '{}'::jsonb) || ${JSON.stringify({ dsp7StopIntent: intent })}::jsonb`, updatedAt: new Date() }).where(and(eq(heartbeatRuns.id, run.id),eq(heartbeatRuns.companyId,run.companyId)));
    await tx.insert(activityLog).values({ companyId: run.companyId, agentId: run.agentId, actorType: "system", actorId: "budget_service", action: "dsp7.seat.stop.requested", entityType: "heartbeat_run", entityId: run.id, details: intent });
  });
}
