import { dispatchAuthorization, publicRule } from "./dsp7-jira-dispatch.js";
import { dsp7SeatControlRoutes, defaultSeatPolicy, isSeatOnline } from "./dsp7-seat-control.js";
import { createHash } from "node:crypto";
import { Router } from "express";
import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import { activityLog, agents, environments, heartbeatRuns, issueComments, issues, type Db } from "@paperclipai/db";
import { z } from "zod";
import { assertBoard, assertCompanyAccess } from "./authz.js";
import { badRequest, conflict, forbidden, notFound } from "../errors.js";

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

const requestSchema = z.object({ version: z.literal(2), jira_key: z.string().regex(/^[A-Z][A-Z0-9_]*-\d+$/), project_id: z.string().uuid(), workspace_id: z.string().uuid(), seat_id: z.string().uuid(), ready_status: z.string().trim().min(1).max(100) }).strict();

/** Persistent reservations are immutable audit records, independent of editable issue descriptions.
 * Keep dsp7.jira.reserved records permanently. No timeout or terminal run steals a reservation.
 */
export function dsp7SeatRoutes(db: Db) {
  const router = Router();
  router.use(dsp7SeatControlRoutes(db));
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
      return { ...body.runtime, revision, checkedAt: runtime.checkedAt };
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
    res.json({ revision: runtime.revision });
  });
  router.get("/companies/:companyId/dsp7-seats", async (req, res) => {
    const companyId = String(req.params.companyId);
    assertBoard(req); assertCompanyAccess(req, companyId);
    const rows = await db.select().from(agents).where(eq(agents.companyId, companyId));
    const envs = await db.select().from(environments);
    const allowed = rows.filter(agent => {
      const seat = agent.adapterConfig.dsp7Seat as Record<string, unknown> | undefined;
      return agent.adapterConfig.dsp7WebJiraIntake === true && seat && (req.actor.isInstanceAdmin || req.actor.source === "local_implicit" || (Array.isArray(seat.intakeUserIds) && seat.intakeUserIds.includes(req.actor.userId)));
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
      return { presence: presence ?? null, online: isSeatOnline(presence), policy: agent.adapterConfig.dsp7SeatPolicy ?? defaultSeatPolicy, dispatch:publicRule(agent), isMine:Array.isArray(seat.intakeUserIds)&&seat.intakeUserIds.includes(req.actor.userId), agentId: agent.id, name: seat.name ?? agent.name, agentName: agent.name, environmentName: agent.adapterConfig.dsp7Transport === "outbound" ? "本机主动连接（无需 SSH）" : environment?.name ?? "未关联环境", runtime, usable, message: usable ? "登记有效；启动时仍将检查本机配置" : "未登记、检查已超过 24 小时或环境／执行配置已变化，请在本机执行 harness seat register/check" };
    }));
  });
  router.post("/companies/:companyId/dsp7-seats/:id/verify", async (req, res) => {
    const companyId = String(req.params.companyId); assertBoard(req); assertCompanyAccess(req, companyId);
    const [agent] = await db.select().from(agents).where(and(eq(agents.id, String(req.params.id)), eq(agents.companyId, companyId)));
    const seat = agent?.adapterConfig.dsp7Seat as Record<string, unknown> | undefined;
    if (!agent || !seat) throw notFound("席位不存在");
    if (!req.actor.isInstanceAdmin && req.actor.source !== "local_implicit" && !(Array.isArray(seat.intakeUserIds) && seat.intakeUserIds.includes(req.actor.userId))) throw forbidden("未获该席位授权");
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
    if (!task) throw notFound("Task not found");
    assertCompanyAccess(req, task.companyId);
    const [agent] = await db.select().from(agents).where(and(eq(agents.id, local.seat_id), eq(agents.companyId, task.companyId)));
    const config = agent?.adapterConfig as Record<string, unknown> | undefined;
    const seat = config?.dsp7Seat as Record<string, unknown> | undefined;
    if (!seat || config?.dsp7WebJiraIntake !== true || seat.machineId !== local.machine_id || seat.machineFingerprint !== local.machine_fingerprint || agent?.status === "terminated" || agent?.status === "paused") throw forbidden("席位未启用或本机身份与登记不一致");
    const raw = task.description?.match(/<!-- DSP7-JIRA-INTAKE (.*?) -->/)?.[1];
    let intake: z.infer<typeof requestSchema>;
    try { intake = requestSchema.parse(JSON.parse(raw ?? "")); } catch { throw badRequest("需要有效的第二版网页接入申请"); }
    if (intake.seat_id !== local.seat_id || task.projectId !== intake.project_id || (!task.createdByUserId && task.createdByAgentId !== agent.id) || (task.createdByAgentId && task.createdByAgentId !== agent.id)) throw forbidden("申请的席位或创建人不匹配");
    const users = Array.isArray(seat.intakeUserIds) ? seat.intakeUserIds : [];
    const autoRule=task.createdByAgentId===agent.id?await dispatchAuthorization(db,agent,task):null;
    const ownerUserId=autoRule?.ownerUserId??task.createdByUserId;
    if (!users.includes(ownerUserId)) throw forbidden("申请人未获该席位授权");
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
      if((freshAgent.adapterConfig.dsp7JiraDispatch as {intakePaused?:boolean})?.intakePaused)throw conflict("席位已暂停接单");
      const [current] = await tx.select().from(issues).where(eq(issues.id, id)).for("update");
      if (!current || current.status !== "backlog" || current.assigneeAgentId || current.assigneeUserId || current.projectId !== intake.project_id || current.description?.match(/<!-- DSP7-JIRA-INTAKE (.*?) -->/)?.[1] !== raw) throw conflict("申请已变化，停止登记");
      const comments = await tx.select().from(issueComments).where(and(eq(issueComments.issueId, id), eq(issueComments.companyId, task.companyId), eq(issueComments.authorUserId, task.createdByUserId!), isNull(issueComments.authorAgentId), isNull(issueComments.deletedAt)));
      if (!autoRule && !comments.some(c => c.body.includes(`<!-- DSP7-JIRA-INTAKE-AUTH ${raw} -->`))) throw forbidden("缺少真实申请人的接入授权评论");
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
    const raw = task?.description?.match(/<!-- DSP7-JIRA-INTAKE (.*?) -->/)?.[1];
    if (!raw) { next(); return; }
    let intake: z.infer<typeof requestSchema>;
    try { intake = requestSchema.parse(JSON.parse(raw)); } catch { throw conflict("旧版或无效的网页申请不能领取执行权，请迁移到席位接入"); }
    assertCompanyAccess(req, task!.companyId);
    if (req.actor.type !== "agent" || req.actor.agentId !== intake.seat_id || req.body.agentId !== intake.seat_id) throw forbidden("只有所选席位可领取执行权");
    const [claim] = await db.select().from(activityLog).where(and(eq(activityLog.companyId, task!.companyId), eq(activityLog.action, "dsp7.jira.reserved"), eq(activityLog.entityType, "dsp7_jira_claim"), eq(activityLog.entityId, intake.jira_key))).limit(1);
    if (claim?.details?.taskId !== task!.id || claim.details.seatId !== intake.seat_id || claim.details.request !== raw) throw conflict("该任务未取得 Jira 独占登记");
    next();
  });
  return router;
}
