import { and, eq } from "drizzle-orm";
import { agents, deliveryWorkflows, type Db } from "@paperclipai/db";
import type { DeliveryStageRecord, DeliveryAutomaticRepairPolicy } from "@paperclipai/shared";
import { assertNewDomainMetering } from "./harness-execution-routing.js";
import { conflict } from "../errors.js";
import { deliverySeatCandidates } from "./delivery-seat-assignment.js";
import { assertSeatBudgetAdmission } from "./seat-budget-admission.js";
import { isSeatManagerUser } from "../routes/dsp7-seat-owners.js";
import { isHistoricalDelivery } from "./delivery-graph.js";
type Flow = typeof deliveryWorkflows.$inferSelect;
export function automaticRepairRoute(stage: DeliveryStageRecord, policy: DeliveryAutomaticRepairPolicy) {
  const result = stage.receipt?.testResults,
    report = stage.receipt?.failureReport;
  if (!result?.failed || !report || report.defects.length !== result.failed || report.defects.some(d => d.kind !== "product")) throw conflict("自动修复需要逐条产品缺陷报告；环境、用例问题或缺失记录须人工处理");
  const modules = new Set(report.defects.map(d => d.module));
  if (modules.size !== 1) throw conflict("本轮缺陷跨多个模块，请拆分测试范围后分别修复，避免误派负责人");
  const route = policy.routes.find(r => modules.has(r.module));
  if (!route) throw conflict("缺陷模块未配置原编码席位路由");
  if ((stage.repairHistory?.length ?? 0) >= policy.maxCycles) throw conflict("已达到项目自动修复轮数上限，请人工处理");
  if (!stage.parentKey) throw conflict("测试缺少真实主工单，无法核对原编码及评审节点");
  return route;
}

/** Resolve only identities already present in this workflow. Never create tickets or tasks. */
export function existingRepairNodes(flow: Pick<Flow, "stages">, failed: DeliveryStageRecord, route: DeliveryAutomaticRepairPolicy["routes"][number]) {
  const work = flow.stages.filter(s => s.stage === "coding" && !s.intent && !s.reviewWorkKeys && s.parentKey === failed.parentKey && s.seatId === route.developmentSeatId);
  if (work.length !== 1) throw conflict("无法唯一定位该模块的原编码单，请核对原编码席位与工单；不会另建修复单");
  const reviews = flow.stages.filter(s => s.stage === "coding" && s.intent === "code-review" && s.parentKey === failed.parentKey && s.reviewWorkKeys?.includes(work[0].jiraKey ?? ""));
  if (reviews.length !== 1) throw conflict("无法唯一定位原代码评审单，请核对条目拆分结果；不会另建评审单");
  const review = reviews[0];
  if (failed.seatId !== route.qaSeatId || review.seatId !== route.reviewSeatId) throw conflict("修复路由须使用原编码、原代码评审及原功能测试节点的执行席位");
  if (work[0].seatId === review.seatId && review.executionMode !== "human") throw conflict("原代码评审须使用独立席位");
  const tests = flow.stages.filter(s => s.stage === "functional-test" && s.parentKey === failed.parentKey);
  if ([work[0], review, ...tests].some(s => isHistoricalDelivery(s) || !s.jiraKey)) throw conflict("原节点缺少有效工单或属于接入前已有交付，请先核对正式来源，不能自动重开");
  if (work[0].executionMode === "human" || failed.executionMode === "human") throw conflict("自动修复需要原编码及功能测试由 Agent 执行");
  return {
    work: work[0],
    review,
    test: failed,
    tests
  };
}
export async function automaticRepairOrigin(db: Db, companyId: string, policy: DeliveryAutomaticRepairPolicy) {
  const [seat] = await db.select().from(agents).where(and(eq(agents.companyId, companyId), eq(agents.id, policy.routes[0].developmentSeatId)));
  try {
    return new URL((seat?.adapterConfig.dsp7JiraDispatch as {
      jiraBaseUrl?: string;
    })?.jiraBaseUrl ?? "").origin;
  } catch {
    throw conflict("原编码席位缺少有效的 Jira 来源");
  }
}
export async function assertAutomaticRepairSeats(db: Db, flow: Pick<Flow, "companyId" | "projectId">, policy: DeliveryAutomaticRepairPolicy, origin: string) {
  const seats = await db.select().from(agents).where(eq(agents.companyId, flow.companyId));
  for (const route of policy.routes) for (const [id, kind, role] of [[route.developmentSeatId, "development", "coding"], [route.reviewSeatId, "development", "code-review"], [route.qaSeatId, "qa", "functional-test"]] as const) {
    const seat = seats.find(s => s.id === id);
    const account = (seat?.adapterConfig.dsp7JiraDispatch as {
      jiraAssignee?: string;
    } | undefined)?.jiraAssignee;
    if (!seat || !account || !deliverySeatCandidates(seats, flow.projectId, {
      account,
      displayName: "",
      origin
    }, kind, role).some(s => s.id === id)) throw conflict("原执行席位、项目 Jira 账号或原生能力无效");
    const presence = seat.adapterConfig.dsp7SeatPresence as {
      capabilities?: string[];
    } | undefined;
    if (!presence?.capabilities?.includes("delivery-reuse-repair-v1")) throw conflict("请更新原执行席位客户端以支持复用原编码、代码评审和测试任务返工");
    await assertNewDomainMetering(db, flow.companyId, id, flow.projectId);
    await assertSeatBudgetAdmission(db, {
      companyId: flow.companyId,
      projectId: flow.projectId,
      agentId: id,
      taskId: id
    });
  }
  return seats;
}
export async function reconcileAutomaticRepair(db: Db, flow: Flow, start: (config: {
  expectedReceiptDigest: string;
  defectKey: string;
  reviewKey: string;
  retestKey: string;
  developmentSeatId: string;
  reviewSeatId: string;
  qaSeatId: string;
}) => Promise<unknown>, assertSource: () => Promise<void>, target?: DeliveryStageRecord) {
  const policy = flow.config.template?.definition.automaticRepair;
  const failed = target ?? flow.stages.find(s => s.state !== "done");
  if (!policy || !flow.config.automaticRepairAuthorized || flow.state !== (flow.config.entryScope ? "active" : "blocked") || failed?.stage !== "functional-test" || !failed.receipt?.testResults?.failed || failed.automaticRepair?.status === "blocked") return;
  try {
    if (!(flow.createdBy === "local-board" && process.env.PAPERCLIP_DEPLOYMENT_MODE === "local_trusted") && !(await isSeatManagerUser(db, flow.companyId, flow.createdBy))) throw conflict("自动修复启动人的组织管理权限已失效");
    await assertSource();
    const route = automaticRepairRoute(failed, policy),
      nodes = existingRepairNodes(flow, failed, route);
    await start({
      expectedReceiptDigest: failed.receiptDigest!,
      defectKey: nodes.work.jiraKey!,
      reviewKey: nodes.review.jiraKey!,
      retestKey: nodes.test.jiraKey!,
      ...route
    });
  } catch (error) {
    await db.transaction(async tx => {
      const [fresh] = await tx.select().from(deliveryWorkflows).where(and(eq(deliveryWorkflows.id, flow.id), eq(deliveryWorkflows.companyId, flow.companyId))).for("update");
      if (!fresh || fresh.state !== (fresh.config.entryScope ? "active" : "blocked")) return;
      const stage = fresh.stages.find(s => s.taskId === failed.taskId);
      if (!stage || stage.receiptDigest !== failed.receiptDigest) return;
      const message = error instanceof Error ? error.message : "原任务返工失败，请核对";
      stage.automaticRepair = {
        status: "blocked",
        route: policy.routes[0],
        operations: [],
        message
      };
      await tx.update(deliveryWorkflows).set({
        stages: fresh.stages,
        message: "原任务返工待处理：" + message,
        updatedAt: new Date()
      }).where(eq(deliveryWorkflows.id, fresh.id));
    });
  }
}
