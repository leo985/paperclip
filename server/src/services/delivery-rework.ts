import { randomUUID } from "node:crypto";
import { and, eq, inArray } from "drizzle-orm";
import { heartbeatRuns, issues, seatExecutionPermits, type Db } from "@paperclipai/db";
import type { DeliveryStageRecord, DeliveryWorkflow } from "@paperclipai/shared";
import { conflict } from "../errors.js";
import { deliveryAncestors } from "./delivery-graph.js";

/** Reopen only the explicitly reviewed work and its dependent closure, never unrelated branches. */
export function deliveryReworkScope(stages: DeliveryStageRecord[], review: DeliveryStageRecord) {
  const work = review.reviewWorkKeys
    ? stages.filter(s => !s.reviewWorkKeys && s.stage === review.stage && review.reviewWorkKeys!.includes(s.jiraKey ?? ""))
    : [review];
  if (!work.length || (review.reviewWorkKeys && work.length !== review.reviewWorkKeys.length) || work.some(s => s.stage === "analysis"))
    throw conflict("无法定位退回评审对应的原工作单，请核对工单绑定");
  const ids = new Set(work.map(s => s.taskId));
  return stages.filter(s => ids.has(s.taskId) || [...deliveryAncestors(stages, s.taskId)].some(id => ids.has(id)));
}

/** Caller holds the workflow row lock. Return false while old native processes are not proven stopped. */
export async function prepareDeliveryRework(db: Db, flow: Pick<DeliveryWorkflow, "companyId" | "stages">, review: DeliveryStageRecord) {
  if (review.review?.decision !== "reject") throw conflict("当前版本没有待处理的退回结论");
  const affected = deliveryReworkScope(flow.stages, review);
  const runs = affected.flatMap(s => s.runId ? [s.runId] : []);
  if (runs.length) {
    const live = await db.select().from(heartbeatRuns).where(and(eq(heartbeatRuns.companyId, flow.companyId), inArray(heartbeatRuns.id, runs)));
    const permits = await db.select().from(seatExecutionPermits).where(and(eq(seatExecutionPermits.companyId, flow.companyId), inArray(seatExecutionPermits.runId, runs)));
    if (affected.some(s => s.runId && (!live.some(r => r.id === s.runId && !["running", "queued", "scheduled_retry"].includes(r.status)) || !permits.some(p => p.runId === s.runId && p.agentId === s.seatId && p.taskId === s.taskId && p.treeStopVerifiedAt)))) return false;
  }
  const tasks = await db.select().from(issues).where(and(eq(issues.companyId, flow.companyId), inArray(issues.id, affected.map(s => s.taskId)))).for("update");
  for (const stage of affected) {
    const task = tasks.find(t => t.id === stage.taskId);
    if (!task || task.status === "cancelled" || (stage.executionMode === "human" ? task.assigneeUserId !== stage.reviewerUserId : task.assigneeAgentId !== stage.seatId))
      throw conflict("返工工单已取消或负责人已变化，请核对后处理");
    if (task.executionRunId && task.executionRunId !== stage.runId || task.checkoutRunId && task.checkoutRunId !== stage.runId)
      throw conflict("返工工单被其他运行占用，请等待释放");
  }
  const rejection = { ...review.review }, reviewTaskId = review.taskId;
  for (const stage of affected) {
    stage.reworkHistory ??= [];
    stage.reworkHistory.push({
      round: stage.reworkHistory.length + 1, reviewTaskId, rejection,
      previous: { state: stage.state, inputDigest: stage.inputDigest, dispatchId: stage.dispatchId, runId: stage.runId, receipt: stage.receipt, receiptDigest: stage.receiptDigest, manualDelivery: stage.manualDelivery, review: stage.review },
    });
    stage.dispatchId = randomUUID();
    stage.runId = null;
    stage.receipt = null;
    stage.receiptDigest = null;
    stage.review = null;
    stage.inputDigest = "";
    delete stage.manualDelivery;
    delete stage.question;
    delete stage.waitingSince;
    // Original start confirmation remains valid for the same work; execution never bypasses budget/native gates.
    stage.state = "pending";
    stage.message = "评审退回，等待原执行人修改后重新送审：" + rejection.note;
    await db.update(issues).set({status:"todo", completedAt:null, checkoutRunId:null, executionRunId:null, executionAgentNameKey:null, executionLockedAt:null, updatedAt:new Date()}).where(and(eq(issues.companyId, flow.companyId), eq(issues.id, stage.taskId)));
  }
  return true;
}
