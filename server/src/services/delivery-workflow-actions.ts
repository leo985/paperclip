import { and, eq, inArray, sql } from "drizzle-orm";
import { deliveryWorkflows, type Db } from "@paperclipai/db";
import {
  deliveryRecordLabel,
  deliveryReviewDigest,
  type DeliveryWorkflowAction,
  type DeliveryWorkflowInbox,
} from "@paperclipai/shared";
import { conflict } from "../errors.js";
import { readyDeliveryStages, deliveryStageCanStart } from "./delivery-graph.js";

type Flow = typeof deliveryWorkflows.$inferSelect;

export function deliveryWorkflowHref(
  flow: Pick<Flow, "projectId" | "snapshotId">,
  taskId?: string,
) {
  const params = new URLSearchParams({
    projectId: flow.projectId,
    snapshotId: flow.snapshotId,
    ...(taskId ? { taskId } : {}),
  });
  return "/delivery?" + params + (taskId ? "#delivery-node-" + taskId : "#delivery-workflow");
}

export function deliveryWorkflowParticipant(flow: Flow, userId: string) {
  return flow.stages.some(s => s.ownerUserId === userId || s.reviewerUserId === userId);
}

/** Only activated, current instance actions count as todos; issue status is not authority. */
export function deliveryWorkflowActions(flow: Flow): DeliveryWorkflowAction[] {
  const actions: DeliveryWorkflowAction[] = [];
  function add(
    kind: DeliveryWorkflowAction["kind"],
    ownerUserId: string | undefined,
    reason: string,
    actionLabel: string,
    stage?: Flow["stages"][number],
  ) {
    if (!ownerUserId) return;
    actions.push({
      id: `delivery:${flow.id}:${stage?.taskId ?? "accept"}:${kind}`,
      workflowId: flow.id,
      projectId: flow.projectId,
      snapshotId: flow.snapshotId,
      taskId: stage?.taskId,
      ownerUserId,
      kind,
      title: flow.demandNo + " · " + (stage ? deliveryRecordLabel(stage) : kind === "recovery" ? "交付链恢复" : "正式验收"),
      reason,
      actionLabel,
      href: deliveryWorkflowHref(flow, stage?.taskId),
      createdAt: stage?.waitingSince ?? flow.updatedAt.toISOString(),
    });
  }
  // Acceptance and recovery retain the existing administrator permission boundary.
  if (flow.state === "acceptance") {
    add("accept", flow.createdBy, "各节点交付已核验，等待管理员登记正式验收结论", "办理正式验收");
    return actions;
  }
  if (flow.state === "blocked") {
    add("recovery", flow.createdBy, flow.message ?? "交付链阻塞，请核对恢复条件", "核对交付链阻塞");
    return actions;
  }
  if (flow.state !== "active") return actions;
  // A rejected result is being withdrawn/reworked: old-version decisions must disappear.
  const rejected = flow.stages.filter(stage => stage.review?.decision === "reject");
  if (!flow.config?.entryScope && rejected.length) return actions;
  for (const stage of flow.stages.filter(candidate => candidate.branchBlocked))
    add("recovery", flow.createdBy, stage.message ?? "主工单节点已暂停，请核对恢复条件", "核对节点恢复条件", stage);
  for (const stage of readyDeliveryStages(flow.stages)) {
    if (rejected.some(candidate => !candidate.branchBlocked && candidate.parentKey === stage.parentKey)) continue;
    // Analysis uses its existing publication/question inbox, avoiding duplicate actions.
    if (stage.stage === "analysis" || stage.priorCompletion || stage.state === "done") continue;
    if (stage.state === "interrupted") {
      add("recovery", flow.createdBy, stage.message ?? "节点执行中断，请核对恢复条件", "核对节点恢复条件", stage);
      continue;
    }
    if (!deliveryStageCanStart(stage) && !stage.runId) {
      if (!/^[a-f0-9]{64}$/.test(stage.inputDigest ?? "")) continue;
      add("confirm-start", stage.ownerUserId, "前置交付已完成，等待确认本节点启动", "确认节点启动", stage);
      continue;
    }
    if (stage.state === "waiting" && stage.question && !stage.question.answer) {
      add("answer", stage.ownerUserId, stage.question.text, "回答节点问题", stage);
      continue;
    }
    if (stage.state !== "review" || stage.review || !deliveryReviewDigest(stage)) continue;
    if (stage.historicalVerification) {
      add("review", stage.reviewerUserId, stage.message ?? "核对正式来源的交付结果", "核验历史交付", stage);
      continue;
    }
    if (stage.executionMode === "human") {
      add(
        stage.reviewWorkKeys ? "review" : "work",
        stage.reviewerUserId,
        stage.message ?? "前置交付已完成，请办理当前节点",
        stage.reviewWorkKeys ? "办理人工评审" : "提交人工交付",
        stage,
      );
    } else if ((stage.requiresReview ?? ["design", "test-cases"].includes(stage.stage))) {
      add("review", stage.reviewerUserId ?? stage.ownerUserId, "Agent 已提交当前版本成果，等待正式结论核验", "核验 Agent 交付", stage);
    }
  }
  return actions;
}

export async function readDeliveryWorkflowInbox(
  db: Db,
  companyId: string,
  userId: string,
  companyScope = false,
  manager = false,
): Promise<DeliveryWorkflowInbox> {
  const flows = await db.select().from(deliveryWorkflows).where(and(
    eq(deliveryWorkflows.companyId, companyId),
    inArray(deliveryWorkflows.state, ["active", "blocked", "acceptance"]),
  ));
  const visible = flows.filter(flow => companyScope || deliveryWorkflowParticipant(flow, userId) || (manager && flow.createdBy === userId));
  return {
    managedTaskIds: visible.flatMap(flow => flow.stages.map(stage => stage.taskId)),
    actions: visible.flatMap(deliveryWorkflowActions).filter(action =>
      (companyScope || action.ownerUserId === userId) &&
      (manager || !["accept", "recovery"].includes(action.kind)),
    ),
  };
}

export async function deliveryWorkflowForTask(db: Db, companyId: string, taskId: string) {
  const [flow] = await db.select().from(deliveryWorkflows).where(and(
    eq(deliveryWorkflows.companyId, companyId),
    sql`exists(select 1 from jsonb_array_elements(${deliveryWorkflows.stages}) s where s->>'taskId'=${taskId})`,
  )).limit(1);
  return flow ?? null;
}

export async function assertDeliveryTaskMutation(
  db: Db,
  issue: { id: string; companyId: string; status: string; assigneeAgentId: string | null; assigneeUserId: string | null },
  patch: Record<string, unknown>,
) {
  const fields = ["status", "assigneeAgentId", "assigneeUserId"] as const;
  if (!fields.some(key => patch[key] !== undefined && patch[key] !== issue[key])) return;
  if (await deliveryWorkflowForTask(db, issue.companyId, issue.id)) {
    throw conflict("交付链节点的状态与执行人由实例管理，请从交付链办理、评审或恢复；不能通过普通任务操作修改");
  }
}

export async function assertDeliveryTaskCheckout(db: Db, companyId: string, taskId: string, agentId: string) {
  const flow = await deliveryWorkflowForTask(db, companyId, taskId);
  if (!flow) return;
  const stage = flow.stages.find(stage => stage.taskId === taskId)!;
  if (
    flow.state !== "active" || stage.executionMode === "human" || stage.priorCompletion ||
    stage.seatId !== agentId || !["queued", "running"].includes(stage.state) ||
    !deliveryStageCanStart(stage) || !readyDeliveryStages(flow.stages).some(node => node.taskId === taskId)
  ) {
    throw conflict("交付链节点尚未授权执行，请等待实例满足前置并派发");
  }
}

export async function assertNoDeliveryTaskLifecycle(db: Db, companyId: string, taskId: string) {
  if (await deliveryWorkflowForTask(db, companyId, taskId)) {
    throw conflict("交付链节点由实例管理，请在交付链中办理取消或恢复，不能单独删除或释放节点任务");
  }
}
