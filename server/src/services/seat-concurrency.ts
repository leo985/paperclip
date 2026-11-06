import { and, eq, isNull, or } from "drizzle-orm";
import { agents, heartbeatRuns, seatExecutionPermits, type Db } from "@paperclipai/db";
import { seatConcurrencyLimit } from "@paperclipai/shared";

type Seat = typeof agents.$inferSelect;
/** Count distinct tasks, including terminal runs whose process exit is unproven.
 * Callers admitting work hold the seat-commands advisory lock. Queued runs do
 * not consume execution capacity; accepted terminal commands reserve a slot.
 */
export async function seatOccupancy(db: Db, seat: Seat, commands: Array<{ kind: string; status: string; taskId: string | null }> = [], excludeTaskId?: string) {
  const runs = await db.select().from(heartbeatRuns).where(and(eq(heartbeatRuns.companyId, seat.companyId), eq(heartbeatRuns.agentId, seat.id), eq(heartbeatRuns.status, "running")));
  const permits = await db.select().from(seatExecutionPermits).where(and(eq(seatExecutionPermits.companyId, seat.companyId), eq(seatExecutionPermits.agentId, seat.id), or(and(eq(seatExecutionPermits.treeProofRequired, true), isNull(seatExecutionPermits.treeStopVerifiedAt)), and(eq(seatExecutionPermits.treeProofRequired, false), isNull(seatExecutionPermits.processExitObservedAt)))));
  const taskIds = new Set<string>();
  for (const run of runs) taskIds.add(String(run.nativeIssueId ?? run.contextSnapshot?.issueId ?? run.contextSnapshot?.taskId ?? run.id));
  for (const permit of permits) taskIds.add(permit.taskId);
  for (const command of commands) if (command.kind === "start" && ["awaiting_local", "accepted"].includes(command.status) && command.taskId) taskIds.add(command.taskId);
  // Local presence also covers legacy sessions not owned by this controller.
  const presence = seat.adapterConfig.dsp7SeatPresence as { activeTaskId?: string; activeRuns?: Array<{ taskId: string }> } | undefined;
  for (const run of presence?.activeRuns ?? []) taskIds.add(run.taskId);
  if (!presence?.activeRuns && presence?.activeTaskId) taskIds.add(presence.activeTaskId);
  if (excludeTaskId) taskIds.delete(excludeTaskId);
  return { occupied: taskIds.size, limit: seatConcurrencyLimit(seat), taskIds };
}
