import { seatDisplayName } from "../services/seat-presentation.js";
import { seatConcurrencyLimit } from "@paperclipai/shared";
import { publicSeatLaunchOptions } from "@paperclipai/shared";
import { assertSeatBudgetAdmission } from "../services/seat-budget-admission.js";
import { canConfigureSeat, seatOwnerId, canCreateSeatIntake } from "./dsp7-seat-owners.js";
import { dispatchAuthorization, publicRule, manualIntakeRule, platformDispatchRecord, platformAuthorization } from "./dsp7-jira-dispatch.js";
import { dsp7SeatControlRoutes, defaultSeatPolicy, isSeatOnline } from "./dsp7-seat-control.js";
import { createHash } from "node:crypto";
import { Router } from "express";
import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import { activityLog, agents, environments, heartbeatRuns, issueComments, issues, authUsers, type Db } from "@paperclipai/db";
import { z } from "zod";
import { assertBoard, assertCompanyAccess, hasCompanyAccess } from "./authz.js";
import { badRequest, conflict, forbidden, notFound } from "../errors.js";
import { withAgentStartLock } from "../services/agent-start-lock.js";


const identity = z.object({ seat_id: z.string().uuid(), machine_id: z.string().uuid(), machine_fingerprint: z.string().regex(/^[a-f0-9]{64}$/) });
function executorDigest(config: Record<string, unknown>, environment: { driver: string; config: Record<string, unknown>; envVars: Record<string, unknown> }) {
  return createHash("sha256").update(JSON.stringify({ command: config.command, extraArgs: config.extraArgs ?? [], env: config.env ?? {}, engine: config.engine, transport: environment })).digest("hex");
}
const absolutePath = z.string().min(1).max(2048).regex(/^(?:\/|[A-Za-z]:[\\/])/).refine(value => !/[\r\n\0]/.test(value));
const runtimeSchema = z.object({
  environmentId: z.string().uuid(), claudeCommand: absolutePath,
  claudeVersion: z.string().min(1).max(200), claudeSettingsFile: absolutePath.nullable(),
  configurationSource: z.enum(["local-default", "local-settings-file"]),
  harnessRoot: absolutePath, settingsDigest: z.string().regex(/^[a-f0-9]{64}$/).nullable(),
}).strict().refine(value => value.configurationSource === "local-settings-file" ? Boolean(value.claudeSettingsFile && value.settingsDigest) : value.claudeSettingsFile === null && value.settingsDigest === null);
const registerSchema = identity.extend({ runtime: runtimeSchema }).strict();

const intakeIdentitySchema = z.object({ jira_key: z.string().regex(/^[A-Z][A-Z0-9_]*-\d+$/), project_id: z.string().uuid(), workspace_id: z.string().uuid(), seat_id: z.string().uuid() });
const requestSchema = z.discriminatedUnion("version", [
  intakeIdentitySchema.extend({ version: z.literal(2), ready_status: z.string().trim().min(1).max(100) }).strict(),
  intakeIdentitySchema.extend({ version: z.literal(3), status_source: z.literal("seat_rule") }).strict(),
  intakeIdentitySchema.omit({ workspace_id: true }).extend({ version: z.literal(4), status_source: z.literal("seat_rule") }).strict(),
]);

/** Persistent reservations are immutable audit records, independent of editable issue descriptions.
 * Keep dsp7.jira.reserved records permanently. No timeout or terminal run steals a reservation.
 */
export function dsp7SeatRoutes(db: Db) {
  const router = Router();
  // Keep the existing bootstrap graph intact; initialize private conversation routes on demand.
  let managedRouter: Promise<ReturnType<typeof Router>> | undefined;
  router.use(async (req, res, next) => {
    if (!/^\/(?:agents\/[^/]+\/managed-|companies\/[^/]+\/(?:managed-|issues\/[^/]+\/managed-sessions))/.test(req.path)) return next();
    try {
      const routes = await (managedRouter ??= import("./managed-sessions.js").then(module => module.managedSessionRoutes(db)));
      routes(req, res, next);
    } catch (error) {
      managedRouter = undefined;
      next(error);
    }
  });
  router.use(dsp7SeatControlRoutes(db));
  // A machine may migrate only its existing administrator-bound seat. The
  // server holds dispatch paused until the updated local service is installed.
  router.post("/agents/:id/dsp7-outbound-migration", async (req, res) => {
    const parsed = identity.extend({
      action: z.enum(["inspect", "prepare", "finish", "rollback", "restore"]),
      migration_id: z.string().uuid().optional(), runtime: runtimeSchema.optional(),
    }).strict().safeParse(req.body);
    if (!parsed.success) throw badRequest("迁移参数无效");
    const body = parsed.data, id = String(req.params.id);
    if (req.actor.type !== "agent" || req.actor.source !== "agent_key" || (req.actor.keyScope && req.actor.keyScope.kind !== "standard") || req.actor.agentId !== id || body.seat_id !== id) throw forbidden("迁移需要原席位独立凭证");
    assertCompanyAccess(req, req.actor.companyId!);
    const result = await withAgentStartLock(id, () => db.transaction(async tx => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${id + ":seat-commands"},0))`);
      const [agent] = await tx.select().from(agents).where(and(eq(agents.id, id), eq(agents.companyId, req.actor.companyId!))).for("update");
      const config = agent?.adapterConfig;
      const seat = config?.dsp7Seat as Record<string, unknown> | undefined;
      if (!agent || agent.adapterType !== "claude_local" || !seat || config?.dsp7WebJiraIntake !== true || seat.machineId !== body.machine_id || seat.machineFingerprint !== body.machine_fingerprint) throw forbidden("仅原管理员登记的电脑可以迁移本席位；不会接管或重新绑定电脑");
      type Migration = { id: string; state: "prepared" | "completed" | "rolled_back" | "restored"; environmentId: string; revision: number; previous: { environmentId: string | null; transport: unknown; runtime: unknown; runtimeConfig: typeof agent.runtimeConfig } };
      const migration = config.dsp7OutboundMigration as Migration | undefined;
      const reply = (state: string, runtime = config.dsp7SeatRuntime) => ({ state, transport: config.dsp7Transport === "outbound" ? "outbound" : "ssh", migrationId: migration?.id ?? null, runtime: runtime && typeof runtime === "object" ? Object.fromEntries(["environmentId", "claudeCommand", "claudeVersion", "claudeSettingsFile", "configurationSource", "harnessRoot", "settingsDigest", "revision", "checkedAt"].map(key => [key, (runtime as Record<string, unknown>)[key]])) : null });
      if (body.action === "inspect") {
        if (body.migration_id && migration?.id !== body.migration_id) return reply("absent");
        return reply(migration?.state ?? "absent");
      }
      if (!body.migration_id) throw badRequest("缺少迁移编号");
      if (body.action === "restore" && migration?.id === body.migration_id && migration.state === "rolled_back") {
        if (agent.status !== "paused" || agent.defaultEnvironmentId !== migration.previous.environmentId || config.dsp7Transport === "outbound") throw conflict("回退后的配置已变化，请管理员核对");
        const [run] = await tx.select({ id: heartbeatRuns.id }).from(heartbeatRuns).where(and(eq(heartbeatRuns.agentId, id), inArray(heartbeatRuns.status, ["queued", "running", "scheduled_retry"])));
        if (run) throw conflict("席位有未结束运行，不能恢复派工");
        await tx.update(agents).set({ status: "idle", adapterConfig: { ...config, dsp7OutboundMigration: { ...migration, state: "restored" } }, updatedAt: new Date() }).where(eq(agents.id, id));
        await tx.insert(activityLog).values({ companyId: agent.companyId, actorType: "agent", actorId: id, agentId: id, action: "dsp7.seat.migration.restored", entityType: "agent", entityId: id, details: { migrationId: body.migration_id } });
        return reply("restored");
      }
      if (migration?.id === body.migration_id && (body.action === "prepare" || migration.state !== "prepared")) return reply(migration.state);
      if (body.action === "prepare" && migration && ["prepared", "rolled_back"].includes(migration.state)) throw conflict("另一轮迁移尚未结束，请在原电脑重试原更新命令");
      const [run] = await tx.select({ id: heartbeatRuns.id }).from(heartbeatRuns).where(and(eq(heartbeatRuns.agentId, id), inArray(heartbeatRuns.status, ["queued", "running", "scheduled_retry"])));
      const presence = config.dsp7SeatPresence as { lastSeenAt?: string; state?: string; activeTaskId?: string } | undefined;
      const recent = presence?.lastSeenAt && Date.now() - Date.parse(presence.lastSeenAt) < 90000;
      if (run || (recent && (presence?.activeTaskId || ["busy", "waiting_decision", "awaiting_local"].includes(presence?.state ?? "")))) throw conflict("席位仍有运行或待决策任务，请结束后重试；不会终止 Claude");
      let next: Record<string, unknown>, environmentId: string | null, runtimeConfig = agent.runtimeConfig;
      let state: "prepared" | "completed" | "rolled_back" | "restored";
      if (body.action === "prepare") {
        if (agent.status !== "idle") throw conflict("请先将原席位置为空闲状态后迁移");
        if (config.dsp7Transport === "outbound") return reply("already_outbound");
        if (config.dsp7Transport && config.dsp7Transport !== "ssh") throw conflict("不支持自动迁移此执行方式");
        if (!body.runtime || body.runtime.environmentId !== agent.defaultEnvironmentId) throw conflict("本机登记与原执行环境不一致，请先刷新原登记");
        const [oldEnvironment] = agent.defaultEnvironmentId ? await tx.select().from(environments).where(eq(environments.id, agent.defaultEnvironmentId)) : [];
        if (!oldEnvironment || !["ssh", "local"].includes(oldEnvironment.driver)) throw conflict("原执行环境不支持自动迁移");
        const [environment] = await tx.select().from(environments).where(and(eq(environments.driver, "local"), eq(environments.status, "active"))).orderBy(environments.id).limit(1);
        if (!environment) throw conflict("服务器缺少可用的本机主动连接控制环境，请联系管理员");
        next = { ...config, dsp7Transport: "outbound" };
        const runtime = { ...body.runtime, environmentId: environment.id, revision: Number((config.dsp7SeatRuntime as { revision?: number } | undefined)?.revision ?? 0) + 1, checkedAt: new Date().toISOString(), executorDigest: executorDigest(next, { driver: environment.driver, config: environment.config, envVars: environment.envVars }) };
        next.dsp7SeatRuntime = runtime;
        next.dsp7OutboundMigration = { id: body.migration_id, state: "prepared", environmentId: environment.id, revision: runtime.revision, previous: { environmentId: agent.defaultEnvironmentId, transport: config.dsp7Transport ?? null, runtime: config.dsp7SeatRuntime ?? null, runtimeConfig: agent.runtimeConfig } } satisfies Migration;
        environmentId = environment.id; state = "prepared";
        runtimeConfig = { ...agent.runtimeConfig, heartbeat: { ...(agent.runtimeConfig.heartbeat as Record<string, unknown> | undefined), intervalEnabled: false, wakeOnDemand: true, maxConcurrentRuns: 1 } };
      } else {
        if (!["finish", "rollback"].includes(body.action)) throw conflict("迁移当前状态不接受此操作");
        if (!migration || migration.id !== body.migration_id || migration.state !== "prepared") throw conflict("没有匹配的待完成迁移");
        if (agent.status !== "paused" || config.dsp7Transport !== "outbound" || agent.defaultEnvironmentId !== migration.environmentId || (config.dsp7SeatRuntime as { revision?: number } | undefined)?.revision !== migration.revision) throw conflict("迁移期间配置已被其他操作修改，请管理员核对；不会覆盖");
        const [environment] = await tx.select().from(environments).where(eq(environments.id, migration.environmentId));
        if (!environment || environment.status !== "active") throw conflict("迁移期间执行环境已变化，保持暂停，请管理员核对");
        const canonicalDigest = executorDigest(config, { driver: environment.driver, config: environment.config, envVars: environment.envVars });
        const registeredRuntime = config.dsp7SeatRuntime as Record<string, unknown>;
        // Resume already prepared migrations from the previous installer too.
        // That release included extra environment row fields in the digest.
        if (![canonicalDigest, executorDigest(config, environment)].includes(String(registeredRuntime.executorDigest))) throw conflict("迁移期间执行配置已变化，保持暂停，请管理员核对");
        next = { ...config, dsp7SeatRuntime: { ...registeredRuntime, executorDigest: canonicalDigest } }; environmentId = agent.defaultEnvironmentId;
        state = body.action === "finish" ? "completed" : "rolled_back";
        if (state === "rolled_back") {
          environmentId = migration.previous.environmentId; runtimeConfig = migration.previous.runtimeConfig;
          if (migration.previous.transport === null) delete next.dsp7Transport; else next.dsp7Transport = migration.previous.transport;
          if (migration.previous.runtime === null) delete next.dsp7SeatRuntime; else next.dsp7SeatRuntime = migration.previous.runtime;
        }
        next.dsp7OutboundMigration = { ...migration, state };
      }
      await tx.update(agents).set({ adapterConfig: next, defaultEnvironmentId: environmentId, runtimeConfig, status: state === "completed" ? "idle" : "paused", updatedAt: new Date() }).where(eq(agents.id, id));
      await tx.insert(activityLog).values({ companyId: agent.companyId, actorType: "agent", actorId: id, agentId: id, action: "dsp7.seat.migration." + state, entityType: "agent", entityId: id, details: { migrationId: body.migration_id, environmentId } });
      return { ...reply(state, next.dsp7SeatRuntime), transport: next.dsp7Transport === "outbound" ? "outbound" : "ssh", migrationId: body.migration_id };
    }));
    res.json(result);
  });
  // A pre-enrolled machine can publish its own nonsecret metadata. It cannot
  // create an Agent, change SSH transport, credentials, or execution settings.
  router.post("/agents/:id/dsp7-seat-registration", async (req, res) => {
    const parsed = registerSchema.safeParse(req.body);
    if (!parsed.success) throw badRequest("登记字段无效，请检查绝对路径、环境和配置来源");
    const body = parsed.data;
    const id = String(req.params.id);
    if (req.actor.type !== "agent" || req.actor.source !== "agent_key" || (req.actor.keyScope && req.actor.keyScope.kind !== "standard") || req.actor.agentId !== id || body.seat_id !== id) throw forbidden("请使用本席位 Agent 凭证登记");
    assertCompanyAccess(req, req.actor.companyId!);
    const result = await db.transaction(async tx => {
      const [agent] = await tx.select().from(agents).where(and(eq(agents.id, id), eq(agents.companyId, req.actor.companyId!))).for("update");
      const config = agent?.adapterConfig as Record<string, unknown> | undefined;
      const seat = config?.dsp7Seat as Record<string, unknown> | undefined;
      if (!agent || agent.adapterType !== "claude_local" || !seat || config?.dsp7WebJiraIntake !== true || seat.machineId !== body.machine_id || seat.machineFingerprint !== body.machine_fingerprint || ["paused", "terminated", "pending_approval"].includes(agent.status)) throw forbidden("请先由管理员授权本机席位与执行环境");
      if (body.runtime.environmentId !== agent.defaultEnvironmentId) throw conflict("登记环境必须匹配管理员配置的席位环境");
      const [environment] = await tx.select().from(environments).where(eq(environments.id, body.runtime.environmentId));
      if (!environment || environment.status !== "active" || !["ssh", "local"].includes(environment.driver)) throw conflict("席位执行环境不可用");
      const previous = config!.dsp7SeatRuntime as Record<string, unknown> | undefined;
      const unchanged = previous && Object.entries(body.runtime).every(([key, value]) => previous[key] === value) && previous.executorDigest === executorDigest(config!, { driver: environment.driver, config: environment.config, envVars: environment.envVars });
      if (!unchanged) {
        const [run] = await tx.select({ id: heartbeatRuns.id }).from(heartbeatRuns).where(and(eq(heartbeatRuns.agentId, id), inArray(heartbeatRuns.status, ["queued", "running"])));
        if (run) throw conflict("席位有排队或运行中的任务，请结束后刷新执行配置");
      }
      // Revision changes only on profile or executor configuration changes.
      const revision = unchanged ? Number(previous.revision) : Number(previous?.revision ?? 0) + 1;
      const runtime = { ...body.runtime, revision, checkedAt: new Date().toISOString(), executorDigest: executorDigest(config!, { driver: environment.driver, config: environment.config, envVars: environment.envVars }) };
      await tx.update(agents).set({ adapterConfig: { ...config, dsp7SeatRuntime: runtime }, updatedAt: new Date() }).where(eq(agents.id, id));
      await tx.insert(activityLog).values({ companyId: agent.companyId, actorType: "agent", actorId: id, agentId: id, action: "dsp7.seat.registered", entityType: "agent", entityId: id, details: { revision, environmentId: runtime.environmentId, configurationSource: runtime.configurationSource } });
      // Do not return executor env values to the client.
      return { ...body.runtime, revision, checkedAt: runtime.checkedAt, executionTransport: config!.dsp7Transport === "outbound" ? "outbound" : "ssh" };
    });
    res.json(result);
  });
  router.get("/agents/:id/dsp7-seat-registration", async (req, res) => {
    const id = String(req.params.id);
    if (req.actor.type !== "agent" || req.actor.agentId !== id) throw forbidden("只能检查本席位登记");
    assertCompanyAccess(req, req.actor.companyId!);
    const [agent] = await db.select().from(agents).where(and(eq(agents.id, id), eq(agents.companyId, req.actor.companyId!)));
    const runtime = agent?.adapterConfig.dsp7SeatRuntime as Record<string, unknown> | undefined;
    const [environment] = agent?.defaultEnvironmentId ? await db.select().from(environments).where(eq(environments.id, agent.defaultEnvironmentId)) : [];
    if (!agent || !runtime || runtime.environmentId !== agent.defaultEnvironmentId || environment?.status !== "active" || ["paused", "terminated", "pending_approval"].includes(agent.status) || runtime.executorDigest !== executorDigest(agent.adapterConfig, { driver: environment.driver, config: environment.config, envVars: environment.envVars })) throw conflict("席位环境或执行配置已变化，请重新登记");
    res.json({ revision: runtime.revision, executionTransport: agent.adapterConfig.dsp7Transport === "outbound" ? "outbound" : "ssh" });
  });
  router.get("/companies/:companyId/dsp7-seats", async (req, res) => {
    const companyId = String(req.params.companyId);
    assertBoard(req); assertCompanyAccess(req, companyId);
    const rows = await db.select().from(agents).where(eq(agents.companyId, companyId));
    const envs = await db.select().from(environments);
    const owners = await db.select({ id: authUsers.id, name: authUsers.name, email: authUsers.email }).from(authUsers).where(inArray(authUsers.id, rows.map(agent => seatOwnerId(agent.adapterConfig.dsp7Seat as Record<string, unknown> | undefined)).filter((id): id is string => Boolean(id))));
    const allowed = rows.filter(agent => {
      const seat = agent.adapterConfig.dsp7Seat as Record<string, unknown> | undefined;
      return agent.adapterConfig.dsp7WebJiraIntake === true && seat && canConfigureSeat(req, companyId, seat);
    });
    res.json(allowed.map(agent => {
      const seat = agent.adapterConfig.dsp7Seat as Record<string, unknown>;
      const stored = agent.adapterConfig.dsp7SeatRuntime as Record<string, unknown> | undefined;
      // Explicit allowlist prevents accidentally returning credentials or executor env.
      const runtime = stored ? Object.fromEntries(["environmentId", "claudeCommand", "claudeVersion", "claudeSettingsFile", "configurationSource", "harnessRoot", "settingsDigest", "revision", "checkedAt"].map(key => [key, stored[key]])) : null;
      const environment = envs.find(env => env.id === agent.defaultEnvironmentId);
      const fresh = stored && Number.isFinite(Date.parse(String(stored.checkedAt))) && Date.now() - Date.parse(String(stored.checkedAt)) < 86400000;
      const digest = environment ? executorDigest(agent.adapterConfig, { driver: environment.driver, config: environment.config, envVars: environment.envVars }) : null;
      const usable = Boolean(runtime && fresh && environment?.status === "active" && stored?.environmentId === agent.defaultEnvironmentId && stored?.executorDigest === digest && !["paused", "terminated", "pending_approval"].includes(agent.status));
      const presence = agent.adapterConfig.dsp7SeatPresence as Record<string, unknown> | undefined;
      return { maxConcurrentRuns: seatConcurrencyLimit(agent), launchOptions: publicSeatLaunchOptions(agent.adapterConfig), executionTransport: agent.adapterConfig.dsp7Transport === "outbound" ? "outbound" : "ssh", migrationState: (agent.adapterConfig.dsp7OutboundMigration as { state?: string } | undefined)?.state ?? null, presence: presence ?? null, online: isSeatOnline(presence), policy: agent.adapterConfig.dsp7SeatPolicy ?? defaultSeatPolicy, dispatch:publicRule(agent), isMine:seatOwnerId(seat)===req.actor.userId, owner:owners.find(owner=>owner.id===seatOwnerId(seat))??null, canConfigure:canConfigureSeat(req, companyId, seat), agentId: agent.id, name: seatDisplayName(agent.name, seat), agentName: agent.name, environmentName: agent.adapterConfig.dsp7Transport === "outbound" ? "本机主动连接（无需 SSH）" : environment?.name ?? "未关联环境", runtime, usable, message: usable ? "登记有效；启动时仍将检查本机配置" : "未登记、检查已超过 24 小时或环境／执行配置已变化，请在本机执行 harness seat register/check" };
    }));
  });
  router.post("/companies/:companyId/dsp7-seats/:id/verify", async (req, res) => {
    const companyId = String(req.params.companyId); assertBoard(req); assertCompanyAccess(req, companyId);
    const [agent] = await db.select().from(agents).where(and(eq(agents.id, String(req.params.id)), eq(agents.companyId, companyId)));
    const seat = agent?.adapterConfig.dsp7Seat as Record<string, unknown> | undefined;
    if (!agent || !seat) throw notFound("席位不存在");
    if (!canConfigureSeat(req, companyId, seat)) throw forbidden("未获该席位授权");
    const runtime = agent.adapterConfig.dsp7SeatRuntime as Record<string, unknown> | undefined;
    const [environment] = agent.defaultEnvironmentId ? await db.select().from(environments).where(eq(environments.id, agent.defaultEnvironmentId)) : [];
    const digest = environment ? executorDigest(agent.adapterConfig, { driver: environment.driver, config: environment.config, envVars: environment.envVars }) : null;
    if (!runtime || runtime.revision !== req.body.revision || runtime.environmentId !== agent.defaultEnvironmentId || !Number.isFinite(Date.parse(String(runtime.checkedAt))) || Date.now() - Date.parse(String(runtime.checkedAt)) >= 86400000 || runtime.executorDigest !== digest || environment?.status !== "active" || ["paused", "terminated", "pending_approval"].includes(agent.status)) throw conflict("席位登记已变化或需要刷新，请运行 harness seat check 后重新选择");
    res.json({ agentId: agent.id, revision: runtime.revision });
  });
  router.post("/issues/:id/dsp7-reservation", async (req, res) => {
    const id = String(req.params.id);
    const parsed = identity.safeParse(req.body);
    if (!parsed.success) throw badRequest("席位身份无效");
    const local = parsed.data;
    if (req.actor.type !== "agent" || req.actor.agentId !== local.seat_id) throw forbidden("必须使用所选席位自己的 Agent 凭证");
    const [task] = await db.select().from(issues).where(eq(issues.id, id));
    if (!task || !hasCompanyAccess(req, task.companyId)) throw notFound("Task not found");
    assertCompanyAccess(req, task.companyId);
    const [agent] = await db.select().from(agents).where(and(eq(agents.id, local.seat_id), eq(agents.companyId, task.companyId)));
    const config = agent?.adapterConfig as Record<string, unknown> | undefined;
    const seat = config?.dsp7Seat as Record<string, unknown> | undefined;
    if (!seat || config?.dsp7WebJiraIntake !== true || seat.machineId !== local.machine_id || seat.machineFingerprint !== local.machine_fingerprint || agent?.status === "terminated" || agent?.status === "paused") throw forbidden("席位未启用或本机身份与登记不一致");
    const raw = task.description?.match(/<!-- DSP7-JIRA-INTAKE (.*?) -->/)?.[1];
    let intake: z.infer<typeof requestSchema>;
    try { intake = requestSchema.parse(JSON.parse(raw ?? "")); } catch { throw badRequest("需要有效的网页接入申请"); }
    if (intake.seat_id !== local.seat_id || task.projectId !== intake.project_id || (!task.createdByUserId && task.createdByAgentId !== agent.id) || (task.createdByAgentId && task.createdByAgentId !== agent.id)) throw forbidden("申请的席位或创建人不匹配");
    const platformRecord=task.createdByUserId?await platformDispatchRecord(db,agent,task.id):null;
    const autoRule=task.createdByAgentId===agent.id?await dispatchAuthorization(db,agent,task):platformRecord?await platformAuthorization(db,agent,task):null;
    if(intake.version!==2)manualIntakeRule(agent,intake);
    const ownerUserId=autoRule?.ownerUserId??task.createdByUserId;
    if (!autoRule&&!await canCreateSeatIntake(db,agent,task.createdByUserId)) throw forbidden("申请人未获该席位授权");
    const result = await db.transaction(async (tx) => {
      // Serialize all registrations of the same company/Jira, across projects and machines.
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${task.companyId + ":dsp7:" + intake.jira_key}, 0))`);
      const [previous] = await tx.select().from(activityLog).where(and(eq(activityLog.companyId, task.companyId), eq(activityLog.action, "dsp7.jira.reserved"), eq(activityLog.entityType, "dsp7_jira_claim"), eq(activityLog.entityId, intake.jira_key))).limit(1);
      if (previous) {
        const details = previous.details ?? {};
        if (details.taskId !== id || details.seatId !== local.seat_id || details.machineId !== local.machine_id || details.machineFingerprint !== local.machine_fingerprint || details.request !== raw) throw conflict("该 Jira 已由另一任务或席位独占登记；请联系管理员核对，不能自动接管");
        return details;
      }
      const [freshAgent]=await tx.select().from(agents).where(eq(agents.id,agent.id)).for("update");
      if(intake.version!==2)manualIntakeRule(freshAgent,intake);
      if((freshAgent.adapterConfig.dsp7JiraDispatch as {intakePaused?:boolean})?.intakePaused)throw conflict("席位已暂停接单");
      const [current] = await tx.select().from(issues).where(eq(issues.id, id)).for("update");
      if (!current || current.status !== "backlog" || current.assigneeAgentId || current.assigneeUserId || current.projectId !== intake.project_id || current.description?.match(/<!-- DSP7-JIRA-INTAKE (.*?) -->/)?.[1] !== raw) throw conflict("申请已变化，停止登记");
      const comments = await tx.select().from(issueComments).where(and(eq(issueComments.issueId, id), eq(issueComments.companyId, task.companyId), eq(issueComments.authorUserId, task.createdByUserId!), isNull(issueComments.authorAgentId), isNull(issueComments.deletedAt)));
      if (!autoRule && !comments.some(c => c.body.includes(`<!-- DSP7-JIRA-INTAKE-AUTH ${raw} -->`))) throw forbidden("缺少真实申请人的接入授权评论");
      const [workflowTask]=await tx.select({id:issues.id}).from(issues).where(and(eq(issues.companyId,task.companyId),sql`${issues.description} like ${'%<!-- DELIVERY-WORKFLOW {"jira_key":"'+intake.jira_key+'"%'}`)).limit(1);
      if(workflowTask&&workflowTask.id!==id)throw conflict("该 Jira 已纳入条目自动交付流程，请从条目页面管理，不能另行接管");
      // Also fence pre-existing/legacy formal registrations, which have no new reservation record.
      const legacy = await tx.select({ id: issues.id, description: issues.description }).from(issues).where(and(eq(issues.companyId, task.companyId), sql`${issues.description} like ${"%DSP7-PILOT:" + intake.jira_key + "%"}`));
      if (legacy.some(item => item.id !== id && item.description?.split(/\s/).includes("DSP7-PILOT:" + intake.jira_key))) throw conflict("该 Jira 已存在旧版登记，请先人工核对执行归属");
      const details = { taskId: id, jiraKey: intake.jira_key, seatId: local.seat_id, machineId: local.machine_id, machineFingerprint: local.machine_fingerprint, ownerUserId, request: raw };
      await tx.insert(activityLog).values({ companyId: task.companyId, actorType: "agent", actorId: local.seat_id, agentId: local.seat_id, action: "dsp7.jira.reserved", entityType: "dsp7_jira_claim", entityId: intake.jira_key, responsibleUserId: ownerUserId, details });
      return details;
    });
    res.json(result);
  });
  router.post("/issues/:id/checkout", async (req, _res, next) => {
    const [task] = await db.select().from(issues).where(eq(issues.id, String(req.params.id)));
    if (!task) { next(); return; }
    if (!hasCompanyAccess(req, task.companyId)) throw notFound("Issue not found");
    const raw = task.description?.match(/<!-- DSP7-JIRA-INTAKE (.*?) -->/)?.[1];
    if (!raw) { next(); return; }
    let intake: z.infer<typeof requestSchema>;
    try { intake = requestSchema.parse(JSON.parse(raw)); } catch { throw conflict("旧版或无效的网页申请不能领取执行权，请迁移到席位接入"); }
    assertCompanyAccess(req, task.companyId);
    if (req.actor.type !== "agent" || req.actor.agentId !== intake.seat_id || req.body.agentId !== intake.seat_id) throw forbidden("只有所选席位可领取执行权");
    const [claim] = await db.select().from(activityLog).where(and(eq(activityLog.companyId, task!.companyId), eq(activityLog.action, "dsp7.jira.reserved"), eq(activityLog.entityType, "dsp7_jira_claim"), eq(activityLog.entityId, intake.jira_key))).limit(1);
    if (claim?.details?.taskId !== task!.id || claim.details.seatId !== intake.seat_id || claim.details.request !== raw) throw conflict("该任务未取得 Jira 独占登记");
    if(intake.version!==2){
      const [currentAgent]=await db.select().from(agents).where(and(eq(agents.id,intake.seat_id),eq(agents.companyId,task!.companyId)));
      if(!currentAgent)throw forbidden("席位不存在");
      manualIntakeRule(currentAgent,intake);
    }
    await assertSeatBudgetAdmission(db,{companyId:task!.companyId,agentId:intake.seat_id,projectId:task!.projectId,taskId:task!.id});
    next();
  });
  return router;
}
