import { and, eq, inArray } from "drizzle-orm";
import {
  analysisExecutions,
  analysisDecisions,
  agents,
  heartbeatRuns,
  issues,
  type Db,
} from "@paperclipai/db";
import { conflict } from "../errors.js";
import { seatOwnerId, isSeatManagerUser } from "../routes/dsp7-seat-owners.js";
import type { AnalysisDelivery, AnalysisSnapshot } from "@paperclipai/shared";
export function validateAnalysisSnapshot(
  v: AnalysisSnapshot,
  task: typeof analysisExecutions.$inferSelect,
) {
  const phases = ["P0", "P1", "P2", "P3", "P4"],
    expected =
      v.nativeStatus === "completed"
        ? phases
        : phases.slice(0, phases.indexOf(v.phase));
  if (
    v.binding.companyId !== task.companyId ||
    v.binding.taskId !== task.id ||
    v.binding.revision !== task.revision ||
    v.binding.nativeId !== `pc-${task.id}-r${task.revision}` ||
    JSON.stringify(expected) !== JSON.stringify(v.completedPhases) ||
    (v.nativeStatus === "completed" && v.phase !== "P4") ||
    v.localCompleted !==
      (v.nativeStatus === "completed" && !v.gateErrors.length)
  )
    throw conflict("分析状态身份、修订或阶段门禁不匹配");
}
export function validateAnalysisDelivery(
  v: AnalysisDelivery,
  task: typeof analysisExecutions.$inferSelect,
) {
  validateAnalysisSnapshot(v, task);
  if (
    !v.localCompleted ||
    new Set(v.artifacts.map((a) => a.path)).size !== 7 ||
    v.artifacts.find((a) => a.path === "handoff.md")?.sha256 !== v.handoffDigest
  )
    throw conflict("分析交付门禁或产物清单不完整");
}
export async function assertAnalysisRun(
  db: Db,
  companyId: string,
  agentId: string,
  runId: string,
) {
  const [run] = await db
    .select()
    .from(heartbeatRuns)
    .where(
      and(
        eq(heartbeatRuns.id, runId),
        eq(heartbeatRuns.companyId, companyId),
        eq(heartbeatRuns.agentId, agentId),
      ),
    );
  const [task] = run
    ? await db
        .select()
        .from(analysisExecutions)
        .where(
          and(
            eq(
              analysisExecutions.id,
              String(run.contextSnapshot?.analysisExecutionId ?? ""),
            ),
            eq(analysisExecutions.companyId, companyId),
          ),
        )
    : [];
  const [agent] = await db
    .select()
    .from(agents)
    .where(and(eq(agents.id, agentId), eq(agents.companyId, companyId)));
  const [issue] = task
    ? await db
        .select()
        .from(issues)
        .where(and(eq(issues.id, task.id), eq(issues.companyId, companyId)))
    : [];
  if (
    !task ||
    !run ||
    !agent ||
    !issue ||
    task.seatId !== agentId ||
    task.activeRunId !== runId ||
    task.dispatchId !== run.contextSnapshot?.analysisDispatchId ||
    !["queued", "running", "waiting", "local_completed", "published"].includes(
      task.state,
    ) ||
    issue.assigneeAgentId !== agentId ||
    issue.status === "cancelled" ||
    task.ownerUserId !==
      seatOwnerId(agent.adapterConfig.dsp7Seat as Record<string, unknown>)
  )
    throw conflict("分析执行授权、负责人或运行已变化");
  const grantedBy =
    typeof run.contextSnapshot?.analysisGrantedBy === "string"
      ? run.contextSnapshot.analysisGrantedBy
      : "";
  if (
    !(
      grantedBy === "local-board" &&
      process.env.PAPERCLIP_DEPLOYMENT_MODE === "local_trusted"
    ) &&
    !(await isSeatManagerUser(db, companyId, grantedBy))
  )
    throw conflict("分析授权人的管理权限已失效");
  return { task, run, agent };
}

/** Notifications require a live authorized analysis and an actual undelivered decision. */
export async function analysisWaitScope(
  db: Db,
  companyId: string,
  agentId: string,
  taskId: string,
  alertId: string,
) {
  const [task] = await db
    .select()
    .from(analysisExecutions)
    .where(
      and(
        eq(analysisExecutions.id, taskId),
        eq(analysisExecutions.companyId, companyId),
        eq(analysisExecutions.seatId, agentId),
      ),
    );
  if (
    !task?.activeRunId ||
    !alertId.startsWith(`analysis:${task.activeRunId}:`)
  )
    return null;
  try {
    const scope = await assertAnalysisRun(
      db,
      companyId,
      agentId,
      task.activeRunId,
    );
    if (scope.task.state !== "waiting" || scope.run.status !== "running")
      return null;
    const [decision] = await db
      .select({ id: analysisDecisions.id })
      .from(analysisDecisions)
      .where(
        and(
          eq(analysisDecisions.executionId, taskId),
          eq(analysisDecisions.runId, task.activeRunId),
          inArray(analysisDecisions.status, ["open", "answered"]),
        ),
      );
    return decision ? scope : null;
  } catch {
    return null;
  }
}
