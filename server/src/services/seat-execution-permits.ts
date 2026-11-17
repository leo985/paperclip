import { seatConcurrencyLimit } from "@paperclipai/shared";
import { assertDeliveryRun, stageKind } from "./delivery-workflows.js";
import { assertAnalysisRun } from "./analysis-executions.js";
import { createHash } from "node:crypto";
import { and, eq, isNull, ne, or, sql } from "drizzle-orm";
import { activityLog, agents, heartbeatRuns, issues, seatExecutionPermits, type Db } from "@paperclipai/db";
import { resolveHarnessRoute, sameHarnessRoute, assertNewDomainMetering } from "./harness-execution-routing.js";
import type { SeatExecutionPermit } from "@paperclipai/shared";
import { issueTreeControlService } from "./issue-tree-control.js";
import { budgetService } from "./budgets.js";
import { hasSeatStopIntent } from "./seat-execution-stop.js";
import { resolveHarnessObserverBinding, assertObserverNegotiation, sameObserverBinding } from "./harness-observer-binding.js";
import { conflict } from "../errors.js";
import { assertHarnessValidationRun, sameHarnessValidation } from "./harness-validation.js";

export type TreeStopProof = { protocolVersion: 1; runId: string; isolation: "posix-sessions" | "windows-job" | "not-started"; firstObservedAt: string; observedAt: string; observations: number; remaining: 0 };
const VALIDITY_MS = 60_000;
export type PermitIdentity = { companyId: string; agentId: string; runId: string; machineId: string; lease: string };
const hash = (value: string) => createHash("sha256").update(value).digest("hex");

export function seatPermitService(db: Db, now: () => number = Date.now) {
  async function transaction<T>(identity: PermitIdentity, fn: (tx: Db) => Promise<T>) {
    return db.transaction(async tx => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${identity.agentId + ":seat-commands"}, 0))`);
      return fn(tx as unknown as Db);
    });
  }
  async function eligible(tx: Db, identity: PermitIdentity, starting = false, kind: "development" | "analysis" | "qa" | "validation" = "development", routeRequired = true) {
    const [agent] = await tx.select().from(agents).where(and(eq(agents.id, identity.agentId), eq(agents.companyId, identity.companyId)));
    const [run] = await tx.select().from(heartbeatRuns).where(and(eq(heartbeatRuns.id, identity.runId), eq(heartbeatRuns.agentId, identity.agentId), eq(heartbeatRuns.companyId, identity.companyId)));
    const seat = agent?.adapterConfig.dsp7Seat as { machineId?: string } | undefined;
    if (!agent || !seat || seat.machineId !== identity.machineId || agent.adapterConfig.dsp7Transport !== "outbound" || !run || run.status !== "running") return { reason: "run_unavailable" };
    const taskId = run.nativeIssueId ?? run.contextSnapshot?.issueId;
    if (typeof taskId !== "string") return { reason: "task_unavailable" };
    const [task] = await tx.select().from(issues).where(and(eq(issues.id, taskId), eq(issues.companyId, identity.companyId), eq(issues.assigneeAgentId, identity.agentId)));
    if (!task || task.status === "cancelled" || starting && task.status === "done") return { reason: "task_unavailable" };
    if (await issueTreeControlService(tx).getActivePauseHoldGate(identity.companyId, task.id)) return { reason: "task_paused" };
    if (["terminated", "pending_approval"].includes(agent.status)) return { reason: "agent_unavailable" };
    if (await hasSeatStopIntent(tx, identity.companyId, identity.agentId, identity.runId)) return { reason: "stop_requested" };
    const block = await budgetService(tx).getInvocationBlock(identity.companyId, identity.agentId, { issueId: task.id, projectId: task.projectId });
    if (block) return { reason: "scope_paused" };
    if ((run.contextSnapshot?.harnessValidationDispatchId !== undefined) !== (kind === "validation")) throw conflict("隔离验证不得借用其他领域许可");
    const harnessValidation = kind === "validation" ? await assertHarnessValidationRun(tx, { companyId: identity.companyId, seatId: identity.agentId, taskId: task.id }, run.id, now) : undefined;
    if(run.contextSnapshot?.deliveryWorkflowId){const scope=await assertDeliveryRun(tx,identity.companyId,identity.agentId,identity.runId);if(kind!==stageKind(scope.stage.stage))throw conflict("领域执行许可与阶段不匹配");}
    if(kind==="analysis"){const scope=await assertAnalysisRun(tx,identity.companyId,identity.agentId,identity.runId);const route=resolveHarnessRoute(agent,{runId:run.id,taskId:task.id,kind,required:true});if(route?.capabilityId!==scope.task.capabilityId||route?.registryRevision!==scope.task.registryRevision)throw conflict("分析授权的 Harness 路由已变化");}
    if (kind !== "development") await assertNewDomainMetering(tx, identity.companyId, identity.agentId, task.projectId);
    const executionRoute = routeRequired && kind !== "validation" ? resolveHarnessRoute(agent, { runId: run.id, taskId: task.id, kind, required: kind !== "development" }) : null;
    const harnessObserver = resolveHarnessObserverBinding(agent, { taskId: task.id, runId: run.id, machineId: identity.machineId, projectId: task.projectId });
    // New analysis/QA metering is checked above; legacy Jira development
    // intentionally retains its enrolled observation mode.
    return { executionRoute, taskId: task.id, ledgerScope: { issueId: task.id, projectId: task.projectId, billingCode: task.billingCode, ...(harnessObserver ? { harnessObserver } : {}), ...(harnessValidation ? { harnessValidation } : {}) } };
  }
  function response(permit: typeof seatExecutionPermits.$inferSelect): SeatExecutionPermit {
    return { protocolVersion: 1, permitId: permit.id, validForMs: Math.max(0, Math.min(VALIDITY_MS, permit.expiresAt.getTime() - now())), expiresAt: permit.expiresAt.toISOString(), mode: "observed_cost", ...(permit.ledgerScope?.harnessObserver ? { harnessObserver: permit.ledgerScope.harnessObserver } : {}), ...(permit.ledgerScope?.harnessValidation ? { harnessValidation: permit.ledgerScope.harnessValidation } : {}) };
  }
  function expiresAt(validation?: { expiresAt: string }) {
    return new Date(Math.min(now() + VALIDITY_MS, validation ? Date.parse(validation.expiresAt) : Infinity));
  }
  async function revoke(tx: Db, permit: typeof seatExecutionPermits.$inferSelect, reason: string) {
    if (permit.revokedAt) return;
    await tx.update(seatExecutionPermits).set({ revokedAt: new Date(now()), stopReason: reason }).where(eq(seatExecutionPermits.id, permit.id));
    await tx.insert(activityLog).values({ companyId: permit.companyId, agentId: permit.agentId, actorType: "system", actorId: "seat_permit", action: "seat.permit.revoked", entityType: "heartbeat_run", entityId: permit.runId, details: { permitId: permit.id, reason, processExitVerified: false } });
  }
  return {
    issue: (identity: PermitIdentity, options: { kind: "development" | "analysis" | "qa" | "validation"; supervisionProtocol?: 1 | 2; observerProtocol?: 1; validationProtocol?: 1 } = { kind: "development", supervisionProtocol: 2 }) => transaction(identity, async tx => {
      if (options.kind === "validation" && (options.validationProtocol !== 1 || options.supervisionProtocol !== 2 || options.observerProtocol !== 1)) throw conflict("隔离验证需要独立协商及进程树监督协议");
      const eligibility = await eligible(tx, identity, true, options.kind);
      if (!eligibility.taskId) throw conflict("执行许可未获准，请核对任务、暂停及预算状态");
      assertObserverNegotiation(eligibility.ledgerScope.harnessObserver ?? null, options.observerProtocol, options.supervisionProtocol ?? 2);
      const treeProofRequired = options.supervisionProtocol !== 1;
      if (eligibility.executionRoute && !treeProofRequired) throw conflict("此领域路由需要新版进程树监督协议，请更新客户端");
      const unresolved = await tx.select({ id: seatExecutionPermits.id, taskId: seatExecutionPermits.taskId }).from(seatExecutionPermits).where(and(
        eq(seatExecutionPermits.companyId, identity.companyId), eq(seatExecutionPermits.agentId, identity.agentId),
        ne(seatExecutionPermits.runId, identity.runId), or(and(eq(seatExecutionPermits.treeProofRequired,true),isNull(seatExecutionPermits.treeStopVerifiedAt)),and(eq(seatExecutionPermits.treeProofRequired,false),isNull(seatExecutionPermits.processExitObservedAt))),
      ));
      const [seat] = await tx.select().from(agents).where(and(eq(agents.id, identity.agentId), eq(agents.companyId, identity.companyId)));
      if (!seat || unresolved.length >= seatConcurrencyLimit(seat) || unresolved.some(p => p.taskId === eligibility.taskId)) throw conflict("旧运行尚未回报进程退出，不能签发新许可：席位容量已满或同工单仍在执行");
      const [prior] = await tx.select().from(seatExecutionPermits).where(eq(seatExecutionPermits.runId, identity.runId));
      // A lost claim response must never produce a second executor.
      if (prior) throw conflict("运行已经签发过执行许可，不能重新领取");
      const [permit] = await tx.insert(seatExecutionPermits).values({ companyId: identity.companyId, agentId: identity.agentId, runId: identity.runId, machineId: identity.machineId, taskId: eligibility.taskId, treeProofRequired, ledgerScope: eligibility.ledgerScope, executionRoute: eligibility.executionRoute, leaseHash: hash(identity.lease), expiresAt: expiresAt(eligibility.ledgerScope.harnessValidation), issuedAt: new Date(now()), renewedAt: new Date(now()) }).returning();
      await tx.insert(activityLog).values({ companyId: identity.companyId, agentId: identity.agentId, actorType: "agent", actorId: identity.agentId, action: "seat.permit.issued", entityType: "heartbeat_run", entityId: identity.runId, details: { permitId: permit!.id, mode: "observed_cost", machineId: identity.machineId } });
      return { ...response(permit!), executionRoute: permit!.executionRoute, treeProofRequired: permit!.treeProofRequired };
    }),
    renew: (identity: PermitIdentity) => transaction(identity, async tx => {
      const [permit] = await tx.select().from(seatExecutionPermits).where(and(eq(seatExecutionPermits.runId, identity.runId), eq(seatExecutionPermits.companyId, identity.companyId), eq(seatExecutionPermits.agentId, identity.agentId), eq(seatExecutionPermits.machineId, identity.machineId), eq(seatExecutionPermits.leaseHash, hash(identity.lease)))).for("update");
      if (!permit) throw conflict("执行许可身份不匹配");
      if (permit.revokedAt || permit.processExitObservedAt) return { alive: false as const, reason: permit.stopReason ?? "process_exited" };
      if (permit.expiresAt.getTime() <= now()) { await revoke(tx, permit, "permit_expired"); return { alive: false as const, reason: "permit_expired" }; }
      let eligibility: Awaited<ReturnType<typeof eligible>>;
      try { eligibility = await eligible(tx, identity, false, permit.ledgerScope?.harnessValidation ? "validation" : permit.executionRoute?.capability.kind ?? "development", Boolean(permit.executionRoute)); }
      catch { await revoke(tx,permit,"execution_configuration_changed");return {alive:false as const,reason:"execution_configuration_changed"}; }
      if (!eligibility.taskId) { await revoke(tx, permit, eligibility.reason!); return { alive: false as const, reason: eligibility.reason! }; }
      if (!sameHarnessValidation(permit.ledgerScope?.harnessValidation, eligibility.ledgerScope.harnessValidation)) { await revoke(tx, permit, "harness_validation_changed"); return { alive: false as const, reason: "harness_validation_changed" }; }
      if (permit.taskId !== eligibility.taskId || !sameObserverBinding(permit.ledgerScope?.harnessObserver, eligibility.ledgerScope.harnessObserver)) { await revoke(tx, permit, "harness_observer_changed"); return { alive: false as const, reason: "harness_observer_changed" }; }
      if (!sameHarnessRoute(permit.executionRoute, eligibility.executionRoute ?? null)) { await revoke(tx,permit,"harness_route_changed");return {alive:false as const,reason:"harness_route_changed"}; }
      const [updated] = await tx.update(seatExecutionPermits).set({ renewedAt: new Date(now()), expiresAt: expiresAt(eligibility.ledgerScope.harnessValidation) }).where(eq(seatExecutionPermits.id, permit.id)).returning();
      return { alive: true as const, permit: response(updated!) };
    }),
    observeExit: (identity: PermitIdentity, proof?: TreeStopProof) => transaction(identity, async tx => {
      const [permit] = await tx.select().from(seatExecutionPermits).where(and(eq(seatExecutionPermits.runId, identity.runId), eq(seatExecutionPermits.companyId, identity.companyId), eq(seatExecutionPermits.agentId, identity.agentId), eq(seatExecutionPermits.machineId, identity.machineId), eq(seatExecutionPermits.leaseHash, hash(identity.lease)))).for("update");
      if (!permit) throw conflict("退出回执与许可不匹配");
      if (proof) {
        const first = Date.parse(proof.firstObservedAt), last = Date.parse(proof.observedAt);
        if (proof.protocolVersion !== 1 || proof.runId !== identity.runId || !["posix-sessions", "windows-job", "not-started"].includes(proof.isolation) || proof.remaining !== 0 || proof.observations < 2 || !Number.isFinite(first) || !Number.isFinite(last) || last - first < 250 || first < permit.issuedAt.getTime() - 5000 || last > now() + 5000) throw conflict("进程树停止证明无效或不属于该运行");
        if (!permit.treeStopVerifiedAt) {
          await tx.update(seatExecutionPermits).set({ treeStopVerifiedAt: new Date(now()), treeStopProof: proof }).where(eq(seatExecutionPermits.id, permit.id));
          await tx.insert(activityLog).values({ companyId: identity.companyId, agentId: identity.agentId, actorType: "agent", actorId: identity.agentId, action: "seat.permit.tree_stop_verified", entityType: "heartbeat_run", entityId: identity.runId, details: { permitId: permit.id, proof, clearsExecutionBlocker: false } });
        }
      }
      if (!permit.processExitObservedAt) {
        await tx.update(seatExecutionPermits).set({ processExitObservedAt: new Date(now()), revokedAt: permit.revokedAt ?? new Date(now()), stopReason: permit.stopReason ?? "process_exited" }).where(eq(seatExecutionPermits.id, permit.id));
        await tx.insert(activityLog).values({ companyId: identity.companyId, agentId: identity.agentId, actorType: "agent", actorId: identity.agentId, action: "seat.permit.exit_observed", entityType: "heartbeat_run", entityId: identity.runId, details: { permitId: permit.id, proof: "supervisor_child_exit", clearsExecutionBlocker: false } });
      }
      return { received: true, processExitObserved: true, executionStopVerified: Boolean(proof || permit.treeStopVerifiedAt) };
    }),
  };
}
