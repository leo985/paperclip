import { HARNESS_VALIDATION_READY_STATUSES } from "./harness-validation-readiness.js";
import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { activityLog, agents, heartbeatRuns, issues, type Db } from "@paperclipai/db";
import { harnessValidationBindingSchema, harnessValidationGrantSchema, type HarnessValidationBinding } from "@paperclipai/shared";
import { z } from "zod";
import { conflict } from "../errors.js";
import { isSeatManagerUser, seatOwnerId } from "../routes/dsp7-seat-owners.js";
import { resolveHarnessObserverBinding } from "./harness-observer-binding.js";
import { assertSeatBudgetAdmission } from "./seat-budget-admission.js";
import { assertNewDomainMetering } from "./harness-execution-routing.js";
import { issueTreeControlService } from "./issue-tree-control.js";

const selectionSchema = z.array(z.object({
  companyId: z.string().uuid(), seatId: z.string().uuid(), taskId: z.string().uuid(),
  projectId: z.string().uuid().nullable(), bundleDigest: z.string().regex(/^[a-f0-9]{64}$/),
}).strict()).max(16);
const grantSchema = harnessValidationGrantSchema;
type Scope = { companyId: string; seatId: string; taskId: string };
const GRANTED = "harness.validation.authorized", REVOKED = "harness.validation.revoked";
const REQUESTED = "harness.validation.dispatch-requested";
const BOUND = "harness.validation.run-bound", ENTITY = "harness_validation";

function selected(scope: Scope) {
  if (process.env.DSP7_HARNESS_VALIDATION_ENABLED !== "true") throw conflict("隔离验证尚未启用");
  let selections: z.infer<typeof selectionSchema>;
  try {
    const raw = process.env.DSP7_HARNESS_VALIDATION_TASKS;
    if (!raw || raw.length > 16384) throw new Error();
    selections = selectionSchema.parse(JSON.parse(raw));
    if (new Set(selections.map(s => `${s.companyId}/${s.seatId}/${s.taskId}`)).size !== selections.length) throw new Error();
  } catch { throw conflict("隔离验证范围配置无效"); }
  const value = selections.find(s => s.companyId === scope.companyId && s.seatId === scope.seatId && s.taskId === scope.taskId);
  if (!value) throw conflict("任务不在专用隔离验证范围内");
  return value;
}

async function manager(db: Db, companyId: string, actor: string) {
  if (!(actor === "local-board" && process.env.PAPERCLIP_DEPLOYMENT_MODE === "local_trusted") &&
      !await isSeatManagerUser(db, companyId, actor)) throw conflict("隔离验证授权人的管理权限已失效");
}

async function current(db: Db, scope: Scope, runId: string) {
  const selection = selected(scope);
  const [seat] = await db.select().from(agents).where(and(eq(agents.id, scope.seatId), eq(agents.companyId, scope.companyId)));
  const [task] = await db.select().from(issues).where(and(eq(issues.id, scope.taskId), eq(issues.companyId, scope.companyId)));
  const machine = seat?.adapterConfig.dsp7Seat as { machineId?: string } | undefined;
  if (!seat || !task || !machine?.machineId || seat.adapterConfig.dsp7Transport !== "outbound" ||
      ["paused", "terminated", "pending_approval"].includes(seat.status) || task.assigneeAgentId !== seat.id ||
      task.projectId !== selection.projectId || !HARNESS_VALIDATION_READY_STATUSES.includes(task.status)) throw conflict("隔离验证任务、项目或席位已变化");
  const ownerUserId = seatOwnerId(seat.adapterConfig.dsp7Seat as Record<string, unknown>);
  if (!ownerUserId) throw conflict("隔离验证需要明确席位负责人");
  const observer = resolveHarnessObserverBinding(seat, { taskId: task.id, runId, machineId: machine.machineId, projectId: task.projectId });
  if (!observer || observer.bundle.bundleDigest !== selection.bundleDigest ||
      !observer.bundle.packages.some(p => p.layer === "L4" && p.skills.includes("harness-v2-history-pilot"))) throw conflict("隔离验证需要唯一锁定的历史方法候选包");
  if (await issueTreeControlService(db).getActivePauseHoldGate(scope.companyId, task.id)) throw conflict("隔离验证任务已暂停");
  await assertSeatBudgetAdmission(db, { ...scope, agentId: scope.seatId, projectId: task.projectId });
  await assertNewDomainMetering(db, scope.companyId, scope.seatId, task.projectId);
  return { seat, task, observer, ownerUserId };
}

function event(db: Db, scope: Scope, dispatchId: string, action: string) {
  return db.select().from(activityLog).where(and(eq(activityLog.companyId, scope.companyId),
    eq(activityLog.agentId, scope.seatId), eq(activityLog.entityType, ENTITY),
    eq(activityLog.entityId, dispatchId), eq(activityLog.action, action)));
}

/** A bounded pilot authorization in the native audit store; not an execution
 * permit, scheduler or grant to invoke arbitrary code from issue metadata. */
export function harnessValidationService(db: Db, now: () => number = Date.now) {
  return {
    authorize: (scope: Scope, dispatchId: string, expectedBundleDigest: string, actor: string) => db.transaction(async tx => {
      const store = tx as unknown as Db;
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${scope.seatId + ":seat-commands"},0))`);
      await manager(store, scope.companyId, actor);
      const { observer, ownerUserId } = await current(store, scope, randomUUID());
      if (observer.bundle.bundleDigest !== expectedBundleDigest) throw conflict("候选组合已变化");
      const [prior] = await event(store, scope, dispatchId, GRANTED);
      if (prior) {
        const value = grantSchema.parse(prior.details);
        if (value.taskId !== scope.taskId || value.bundle.bundleDigest !== expectedBundleDigest || value.grantedBy !== actor ||
            value.ownerUserId !== ownerUserId || Date.parse(value.expiresAt) <= now() ||
            (await event(store, scope, dispatchId, REVOKED)).length) throw conflict("授权编号已使用或失效，不能重放");
        return value;
      }
      const { schema: _schema, purpose: _purpose, executionReady: _ready, loadState: _load, runId: _run, ...pin } = observer;
      const value = grantSchema.parse({ ...pin, schema: "harness.validation-authorization/1", purpose: "synthetic-history",
        dispatchId, fixtureVersion: 1, expiresAt: new Date(now() + 15 * 60_000).toISOString(), ownerUserId, grantedBy: actor });
      await tx.insert(activityLog).values({ companyId: scope.companyId, agentId: scope.seatId, actorType: "user", actorId: actor,
        action: GRANTED, entityType: ENTITY, entityId: dispatchId, details: value });
      return value;
    }),
    dispatch: async (scope: Scope, dispatchId: string, actor: string,
      wakeup: ReturnType<typeof import("./heartbeat.js").heartbeatService>["wakeup"]) => {
      // Reserve before wakeup. An uncertain response is not permission to retry.
      await db.transaction(async tx => {
        const store = tx as unknown as Db;
        await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${scope.seatId + ":seat-commands"},0))`);
        await manager(store, scope.companyId, actor);
        const [record] = await event(store, scope, dispatchId, GRANTED);
        const grant = grantSchema.safeParse(record?.details);
        if (!grant.success || grant.data.taskId !== scope.taskId || grant.data.grantedBy !== actor ||
            record?.actorType !== "user" || record.actorId !== actor || Date.parse(grant.data.expiresAt) <= now() ||
            (await event(store, scope, dispatchId, REVOKED)).length) throw conflict("隔离验证授权缺失、撤销或到期");
        const { observer, ownerUserId, task } = await current(store, scope, randomUUID());
        if (!HARNESS_VALIDATION_READY_STATUSES.includes(task.status)) throw conflict("隔离验证任务未就绪");
        if (grant.data.machineId !== observer.machineId || grant.data.ownerUserId !== ownerUserId ||
            grant.data.registryRevision !== observer.registryRevision || JSON.stringify(grant.data.bundle) !== JSON.stringify(observer.bundle))
          throw conflict("隔离验证冻结范围已变化");
        if ((await event(store, scope, dispatchId, REQUESTED)).length || (await event(store, scope, dispatchId, BOUND)).length)
          throw conflict("隔离验证已请求派发；核对原运行，不自动重放");
        await tx.insert(activityLog).values({ companyId: scope.companyId, agentId: scope.seatId,
          actorType: "user", actorId: actor, action: REQUESTED, entityType: ENTITY, entityId: dispatchId,
          details: { taskId: scope.taskId, executionStarted: false } });
      });
      const run = await wakeup(scope.seatId, {
        source: "automation", triggerDetail: "callback", reason: "Harness 隔离验证授权启动；" + dispatchId,
        idempotencyKey: "harness-validation-" + dispatchId, requestedByActorType: "user", requestedByActorId: actor,
        allowRunCoalescing: false, payload: { issueId: scope.taskId, taskId: scope.taskId },
        contextSnapshot: { issueId: scope.taskId, taskId: scope.taskId, harnessValidationDispatchId: dispatchId,
          forceFreshSession: true },
        issueStateGuard: { statuses: [...HARNESS_VALIDATION_READY_STATUSES], assigneeAgentId: scope.seatId },
      });
      if (!run) throw conflict("平台未建立运行；派发请求已留证，不能盲目重试");
      return { runId: run.id, dispatched: true as const, executionStarted: false as const };
    },
    revoke: (scope: Scope, dispatchId: string, actor: string) => db.transaction(async tx => {
      const store = tx as unknown as Db;
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${scope.seatId + ":seat-commands"},0))`);
      await manager(store, scope.companyId, actor);
      const [grant] = await event(store, scope, dispatchId, GRANTED);
      if (!grant || grant.details?.taskId !== scope.taskId) throw conflict("隔离验证授权不存在");
      if (!(await event(store, scope, dispatchId, REVOKED)).length) await tx.insert(activityLog).values({
        companyId: scope.companyId, agentId: scope.seatId, actorType: "user", actorId: actor,
        action: REVOKED, entityType: ENTITY, entityId: dispatchId, details: { taskId: scope.taskId } });
      return { revoked: true as const };
    }),
  };
}

/** Caller holds the native seat-command transaction lock. A dispatch binds to
 * one native running run; a replay cannot create a second executor. */
export async function assertHarnessValidationRun(db: Db, scope: Scope, runId: string, now: () => number = Date.now, bind = true): Promise<HarnessValidationBinding> {
  const [run] = await db.select().from(heartbeatRuns).where(and(eq(heartbeatRuns.id, runId),
    eq(heartbeatRuns.companyId, scope.companyId), eq(heartbeatRuns.agentId, scope.seatId)));
  const dispatchId = run?.contextSnapshot?.harnessValidationDispatchId;
  if (!run || run.status !== "running" || (run.nativeIssueId ?? run.contextSnapshot?.issueId) !== scope.taskId ||
      run.contextSnapshot?.issueId !== scope.taskId || typeof dispatchId !== "string" ||
      !z.string().uuid().safeParse(dispatchId).success || run.contextSnapshot?.analysisExecutionId ||
      run.contextSnapshot?.deliveryWorkflowId) throw conflict("隔离验证运行身份或领域不匹配");
  if (!bind && !(await event(db, scope, dispatchId, REQUESTED)).length) throw conflict("隔离验证尚未请求原生派发");
  const [record] = await event(db, scope, dispatchId, GRANTED);
  const grant = grantSchema.safeParse(record?.details);
  if (!grant.success || record?.actorType !== "user" || record.actorId !== grant.data.grantedBy || grant.data.taskId !== scope.taskId || Date.parse(grant.data.expiresAt) <= now() ||
      (await event(db, scope, dispatchId, REVOKED)).length) throw conflict("隔离验证授权缺失、撤销或到期");
  await manager(db, scope.companyId, grant.data.grantedBy);
  const { observer, ownerUserId } = await current(db, scope, runId);
  const { ownerUserId: _owner, grantedBy: _actor, ...raw } = grant.data;
  const binding = harnessValidationBindingSchema.parse({ ...raw, schema: "harness.validation-binding/1", runId });
  if (ownerUserId !== grant.data.ownerUserId || binding.machineId !== observer.machineId ||
      binding.registryRevision !== observer.registryRevision || JSON.stringify(binding.bundle) !== JSON.stringify(observer.bundle) ||
      binding.projectId !== observer.projectId) throw conflict("隔离验证冻结范围或候选组合已变化");
  const [bound] = await event(db, scope, dispatchId, BOUND);
  if (bound && bound.details?.runId !== runId) throw conflict("隔离验证授权已绑定其他运行");
  if (bind && !bound) await db.insert(activityLog).values({ companyId: scope.companyId, agentId: scope.seatId,
    actorType: "system", actorId: "harness-validation", action: BOUND, entityType: ENTITY,
    entityId: dispatchId, runId, details: { taskId: scope.taskId, runId } });
  return binding;
}

export function sameHarnessValidation(a: unknown, b: unknown) {
  if (a == null || b == null) return a == null && b == null;
  const left = harnessValidationBindingSchema.safeParse(a), right = harnessValidationBindingSchema.safeParse(b);
  return left.success && right.success && JSON.stringify(left.data) === JSON.stringify(right.data);
}
