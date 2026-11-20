import { isSeatOnline } from "../services/seat-presentation.js";
import { seatQingzhouRoutes } from "./dsp7-seat-qingzhou.js";
import { seatConcurrencySchema, seatConcurrencyLimit, seatCanAcceptWork, SEAT_CONCURRENCY_CAPABILITY } from "@paperclipai/shared";
import { seatOccupancy } from "../services/seat-concurrency.js";
import { seatUpgradeRoutes, seatUpgradeState } from "./dsp7-seat-upgrades.js";
import { deliveryTemplateRoutes } from "./delivery-templates.js";
import { seatLaunchOptionsSchema, publicSeatLaunchOptions } from "@paperclipai/shared";
import { seatGroupRoutes } from "./dsp7-seat-groups.js";
import { seatDingtalkTargetSchema, harnessRepositorySchema } from "@paperclipai/shared";
import { deliveryWorkflowRoutes } from "./delivery-workflows.js";
import { managementFollowUpRoutes } from "./management-follow-ups.js";
import { analysisExecutionRoutes } from "./analysis-executions.js";
import { harnessCapabilityRoutes } from "./harness-capabilities.js";
import { assertSeatBudgetAdmission } from "../services/seat-budget-admission.js";
import { deliveryIntakeRoutes } from "./delivery-intake.js";
import { deliveryInsightsRoutes } from "./delivery-insights.js";
import { dsp7SeatOwnerRoutes, canConfigureSeat, requireSeatOwner, isSeatManager, seatOwnerId } from "./dsp7-seat-owners.js";
import { logger } from "../middleware/logger.js";
import { seatBotRoutes, notifySeatBot, validateSeatBotTarget, validateSeatGroupTarget } from "./dsp7-seat-bots.js";
import { dsp7JiraDispatchRoutes, dispatchRule, dispatchAuthorization, platformAuthorization, publicRule } from "./dsp7-jira-dispatch.js";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { dsp7QuickSeatRoutes } from "./dsp7-quick-seats.js";
import { Router, type Request } from "express";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { activityLog, agentApiKeys, agents, environments, heartbeatRuns, issues, personnelPeople, personnelSources, personnelDepartments, type Db } from "@paperclipai/db";
import { z } from "zod";
import { assertBoard, assertCompanyAccess, assertInstanceAdmin } from "./authz.js";
import { badRequest, conflict, forbidden, notFound } from "../errors.js";
import { heartbeatService } from "../services/heartbeat.js";
import { recordSeatStopIntent } from "../services/seat-execution-stop.js";
import { retryStoppedSeatExecution } from "../services/seat-execution-retry.js";

const uuid = z.string().uuid();
const machine = z.object({ seat_id: uuid, machine_id: uuid, machine_fingerprint: z.string().regex(/^[a-f0-9]{64}$/) });
const check = z.object({ id: z.string().max(80), label: z.string().max(100), status: z.enum(["pass", "fail", "warn"]), message: z.string().max(500) });
const alert = z.object({ id: z.string().max(160), taskId: uuid.nullable(), jiraKey: z.string().max(80), level: z.enum(["info", "warning", "urgent"]), message: z.string().max(500), elapsedMinutes: z.number().min(0).max(525600) });
const presenceSchema = machine.extend({ repositories: z.array(harnessRepositorySchema).max(100).optional(), acceptingWork:z.boolean().optional(), bridgeVersion:z.string().regex(/^[a-f0-9]{64}$/).nullable().optional(), capabilities:z.array(z.string().max(80)).max(40).optional(), revision: z.number().int().positive().nullable(), state: z.enum(["idle", "busy", "waiting_decision", "awaiting_local", "config_error", "error"]), activeTaskId: uuid.nullable(), runId: uuid.nullable(), activeRuns: z.array(z.object({ taskId: uuid, runId: uuid, state: z.enum(["busy", "waiting_decision"]) })).max(50).optional(), checkedAt: z.string().datetime({ offset: true }), checks: z.array(check).max(12), alerts: z.array(alert).max(20), tasks: z.array(z.object({ taskId: uuid, jiraKey: z.string().regex(/^[A-Z][A-Z0-9_]*-\d+$/), status: z.string().max(50), mode: z.enum(["replay", "formal"]), automatic:z.boolean().optional(), stoppedRunId:uuid.optional(), stopRequestedRunId:uuid.optional(), ready: z.boolean() })).max(50), autoPermit: z.object({ until: z.string().datetime({ offset: true }), jiraKeys: z.array(z.string().max(80)).max(50) }).nullable() }).strict();
const commandSchema = z.object({ requestId: uuid, kind: z.enum(["check", "refresh", "start"]), taskId: uuid.optional(), revision: z.number().int().positive(), confirmNoOtherExecutor: z.boolean().optional() }).strict();
export const seatPolicySchema = z.object({ mode: z.enum(["manual", "notify", "auto"]), jiraKeys: z.array(z.string().regex(/^[A-Z][A-Z0-9_]*-\d+$/)).max(50), reminderMinutes: z.number().int().min(1).max(1440), escalationMinutes: z.number().int().min(2).max(10080), dingtalk: seatDingtalkTargetSchema.nullable().optional() }).strict().refine(v => v.escalationMinutes > v.reminderMinutes);
export const defaultSeatPolicy = { mode: "manual", jiraKeys: [], reminderMinutes: 10, escalationMinutes: 30 };
export { isSeatOnline } from "../services/seat-presentation.js";
export function commandState(request: Record<string, unknown>, events: Array<{ details: Record<string, unknown> | null }>, now = Date.now()) {
  const last = events.filter(e => e.details?.commandId === request.commandId).sort((a,b) => Number(b.details?.sequence ?? 0)-Number(a.details?.sequence ?? 0))[0]?.details;
  const status = String(last?.status ?? "queued");
  const expiresAt = String(last?.expiresAt ?? request.expiresAt);
  if ((status === "queued" ? request.kind !== "start" : ["awaiting_local", "accepted"].includes(status)) && Date.parse(expiresAt) <= now) return { status: "expired", message: "请求已过期，请核对本机后重试", sequence: Number(last?.sequence ?? 0), runId: null };
  return { status, expiresAt, message: String(last?.message ?? "等待本机接收"), sequence: Number(last?.sequence ?? 0), runId: last?.runId ?? null };
}
const terminal = ["succeeded", "failed", "denied", "cancelled", "expired"];
const transitions: Record<string,string[]> = { queued: ["awaiting_local", "accepted", "failed", "denied", "cancelled", "expired"], awaiting_local: ["accepted", "failed", "denied", "cancelled", "expired"], accepted: ["running", "succeeded", "failed", "denied", "expired"], running: ["succeeded", "failed"] };
const path = z.string().regex(/^\//).max(2048).refine(v => !/[\r\n\0]/.test(v));
const invitationSchema = z.object({ agentId: uuid, environmentId: uuid, name: z.string().trim().min(1).max(100), harnessRoot: path, bridgeRoot: path, claudeCommand: path, settingsFile: path.nullable(), intakeUserIds: z.array(z.string().min(1).max(200)).min(1).max(50) }).strict();
export function dsp7SeatControlRoutes(db: Db) {
  const router = Router();
  router.use(seatQingzhouRoutes(db));
  router.use(harnessCapabilityRoutes(db));
  router.use(analysisExecutionRoutes(db));
  router.use(deliveryIntakeRoutes(db));
  router.use(deliveryTemplateRoutes(db));
  router.use(deliveryWorkflowRoutes(db));
  router.use(managementFollowUpRoutes(db));
  router.use(deliveryInsightsRoutes(db));
  router.use(dsp7SeatOwnerRoutes(db));
  router.use(dsp7QuickSeatRoutes(db));
  router.use(seatBotRoutes(db));
  router.use(seatGroupRoutes(db));
  async function own(req: Request) {
    if (req.actor.type !== "agent" || req.actor.source !== "agent_key" || (req.actor.keyScope && req.actor.keyScope.kind !== "standard") || req.actor.agentId !== String(req.params.id)) throw forbidden("需要本席位独立凭证");
    assertCompanyAccess(req, req.actor.companyId!);
    const id = machine.safeParse(req.body); // Body has extra fields; identity itself is allowlisted.
    if (!id.success) throw badRequest("本机身份无效");
    const [agent] = await db.select().from(agents).where(and(eq(agents.id, String(req.params.id)), eq(agents.companyId, req.actor.companyId!)));
    const seat = agent?.adapterConfig.dsp7Seat as Record<string,unknown> | undefined;
    if (!agent || !seat || agent.adapterConfig.dsp7WebJiraIntake !== true || id.data.seat_id !== agent.id || seat.machineId !== id.data.machine_id || seat.machineFingerprint !== id.data.machine_fingerprint) throw forbidden("本机与登记身份不一致");
    return agent;
  }
  async function board(req: Request) {
    const company = String(req.params.companyId); assertBoard(req); assertCompanyAccess(req, company);
    const [agent] = await db.select().from(agents).where(and(eq(agents.id, String(req.params.id)), eq(agents.companyId, company)));
    const seat = agent?.adapterConfig.dsp7Seat as Record<string,unknown> | undefined;
    if (!agent || !seat) throw notFound("席位不存在");
    if (!canConfigureSeat(req, agent.companyId, seat)) throw forbidden("未获席位授权");
    return agent;
  }
  router.use(seatUpgradeRoutes(db,own,board));
  router.use(dsp7JiraDispatchRoutes(db,own,board,async(tx,agent,task,actorId,authorizationId)=>{
    const runtime=agent.adapterConfig.dsp7SeatRuntime as Record<string,unknown>|undefined;
    const presence=agent.adapterConfig.dsp7SeatPresence as Record<string,unknown>|undefined;
    // Unprepared or offline work remains durably authorized for the watcher.
    // Prepared starts queue durably; receipt admission reserves capacity.
    if(!task.description?.includes("DSP7-PILOT:")||!runtime||!isSeatOnline(presence)||!seatCanAcceptWork(presence)||presence?.acceptingWork===false||dispatchRule(agent)?.intakePaused||["paused","terminated","pending_approval"].includes(agent.status)||Date.now()-Date.parse(String(runtime.checkedAt))>=86400000||!Number.isFinite(Date.parse(String(runtime.checkedAt))))return null;
    if((await history(agent,tx)).some(c=>c.kind==="start"&&c.taskId===task.id&&!terminal.includes(c.status)))return null;
    return createCommand(agent,{requestId:authorizationId,kind:"start",taskId:task.id,revision:Number(runtime.revision),confirmNoOtherExecutor:true},{type:"user",id:actorId,manager:true},tx);
  }));
  router.put("/companies/:companyId/dsp7-seats/:id/concurrency", async (req, res) => {
    const agent = await board(req);
    const parsed = seatConcurrencySchema.safeParse(req.body);
    if (!parsed.success) throw badRequest("并发数须为 1–50 的整数");
    const result = await db.transaction(async tx => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${agent.id + ":seat-commands"},0))`);
      const [current] = await tx.select().from(agents).where(and(eq(agents.id, agent.id), eq(agents.companyId, agent.companyId))).for("update");
      if (!current || !canConfigureSeat(req, current.companyId, current.adapterConfig.dsp7Seat as Record<string, unknown>)) throw forbidden("未获席位授权");
      const presence = current.adapterConfig.dsp7SeatPresence as { capabilities?: string[] } | undefined;
      if (parsed.data.maxConcurrentRuns > 1 && (current.adapterConfig.dsp7Transport !== "outbound" || !presence?.capabilities?.includes(SEAT_CONCURRENCY_CAPABILITY))) throw conflict("请先更新本机主动连接客户端并等待上线，再启用并发执行");
      const previous = seatConcurrencyLimit(current);
      await tx.update(agents).set({ runtimeConfig: { ...current.runtimeConfig, heartbeat: { ...(current.runtimeConfig.heartbeat as Record<string, unknown> | undefined), maxConcurrentRuns: parsed.data.maxConcurrentRuns } }, updatedAt: new Date() }).where(eq(agents.id, current.id));
      await tx.insert(activityLog).values({ companyId: current.companyId, actorType: "user", actorId: req.actor.userId ?? "local-board", agentId: current.id, action: "dsp7.seat.concurrency.updated", entityType: "agent", entityId: current.id, details: { previous, ...parsed.data } });
      return parsed.data;
    });
    res.json(result);
  });
  router.post("/agents/:id/dsp7-seat-launch-options", async (req, res) => {
    const agent = await own(req);
    res.json(publicSeatLaunchOptions(agent.adapterConfig));
  });
  router.put("/companies/:companyId/dsp7-seats/:id/launch-options", async (req, res) => {
    const agent = await board(req);
    const parsed = seatLaunchOptionsSchema.safeParse(req.body);
    if (!parsed.success) throw badRequest("启动参数无效、重复或冲突；请检查支持的参数和取值");
    const result = await db.transaction(async tx => {
      const [current] = await tx.select().from(agents).where(and(eq(agents.id, agent.id), eq(agents.companyId, agent.companyId))).for("update");
      const seat = current?.adapterConfig.dsp7Seat as Record<string, unknown> | undefined;
      if (!current || !seat) throw notFound("席位不存在");
      if (!canConfigureSeat(req, current.companyId, seat)) throw forbidden("未获席位授权");
      const presence = current.adapterConfig.dsp7SeatPresence as { capabilities?: string[] } | undefined;
      if (!presence?.capabilities?.includes("seat-launch-options-v1")) throw conflict("请先更新本机接入桥并等待上线，再配置 Claude 启动参数");
      const previous = publicSeatLaunchOptions(current.adapterConfig);
      const value = { ...parsed.data, revision: previous.revision + 1 };
      await tx.update(agents).set({ adapterConfig: { ...current.adapterConfig, dsp7SeatLaunchOptions: value }, updatedAt: new Date() }).where(eq(agents.id, current.id));
      await tx.insert(activityLog).values({ companyId: current.companyId, actorType: "user", actorId: req.actor.userId ?? "local-board", agentId: current.id, action: "dsp7.seat.launch_options.updated", entityType: "agent", entityId: current.id, details: { previous, ...value } });
      return { configured: true, ...value };
    });
    res.json(result);
  });
  router.patch("/companies/:companyId/dsp7-seats/:id/name", async (req, res) => {
    const agent = await board(req);
    const parsed = z.object({ name: z.string().trim().min(1).max(100).refine(value => !/[\u0000-\u001f\u007f]/.test(value)) }).strict().safeParse(req.body);
    if (!parsed.success) throw badRequest("席位名称须为 1–100 个字符，不能包含换行或控制字符");
    const result = await db.transaction(async tx => {
      const [current] = await tx.select().from(agents).where(and(eq(agents.id, agent.id), eq(agents.companyId, agent.companyId))).for("update");
      const seat = current?.adapterConfig.dsp7Seat as Record<string, unknown> | undefined;
      if (!current || !seat) throw notFound("席位不存在");
      if (!canConfigureSeat(req, current.companyId, seat)) throw forbidden("未获席位授权");
      const previousName = String(seat.name ?? current.name);
      if (previousName !== parsed.data.name) {
        await tx.update(agents).set({ adapterConfig: { ...current.adapterConfig, dsp7Seat: { ...seat, name: parsed.data.name } }, updatedAt: new Date() }).where(eq(agents.id, current.id));
        await tx.insert(activityLog).values({ companyId: current.companyId, actorType: "user", actorId: req.actor.userId ?? "local-board", agentId: current.id, action: "dsp7.seat.renamed", entityType: "agent", entityId: current.id, details: { previousName, name: parsed.data.name } });
      }
      return { agentId: current.id, name: parsed.data.name };
    });
    res.json(result);
  });
  async function history(agent: typeof agents.$inferSelect, tx: Db = db) {
    const events = await tx.select().from(activityLog).where(and(eq(activityLog.companyId, agent.companyId), eq(activityLog.agentId, agent.id), eq(activityLog.entityType,"dsp7_seat_command"))).orderBy(desc(activityLog.createdAt)).limit(500);
    return events.filter(e => e.action === "dsp7.seat.command.requested").map(e => ({ ...(e.details as { commandId: string; kind: string; taskId: string | null; revision: number; requestedBy: string; expiresAt: string }), ...commandState(e.details!,events), createdAt:e.createdAt.toISOString() }));
  }
  async function taskFor(agent: typeof agents.$inferSelect, id: string, tx:Db=db) {
    const [task] = await tx.select().from(issues).where(and(eq(issues.id,id),eq(issues.companyId,agent.companyId)));
    if (!task || ["done","cancelled"].includes(task.status) || task.assigneeUserId || (task.assigneeAgentId && task.assigneeAgentId !== agent.id) || !task.description?.includes("DSP7-PILOT:")) throw conflict("请选择本席位已登记、未结束的 Harness 工单");
    const raw = task.description.match(/<!-- DSP7-JIRA-INTAKE (.*?) -->/)?.[1];
    if (raw) {
      let intake;try { intake=JSON.parse(raw); } catch { throw badRequest("工单登记无效"); }
      if (intake.seat_id !== agent.id) throw forbidden("工单属于其他席位");
      const [claim]=await tx.select().from(activityLog).where(and(eq(activityLog.companyId,agent.companyId),eq(activityLog.action,"dsp7.jira.reserved"),eq(activityLog.entityId,intake.jira_key))).limit(1);
      if (claim?.details?.taskId !== task.id || claim.details.seatId !== agent.id) throw conflict("工单缺少独占登记");
    } else if (task.assigneeAgentId !== agent.id) {
      const presence=agent.adapterConfig.dsp7SeatPresence as {tasks?:Array<{taskId:string;mode:string}>}|undefined;
      if(!task.description.includes("明确模式：replay")||!presence?.tasks?.some(item=>item.taskId===task.id&&item.mode==="replay"))throw forbidden("模拟工单尚未由本机确认登记");
    }
    return task;
  }
  async function createCommand(agent: typeof agents.$inferSelect, data:z.infer<typeof commandSchema>, actor:{type:string;id:string;manager?:boolean}, transaction?:Db) {
    const execute=async(tx:Db)=>{
    if(!transaction)await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${agent.id+":seat-commands"},0))`);
    const [locked]=await tx.select().from(agents).where(and(eq(agents.id,agent.id),eq(agents.companyId,agent.companyId))).for("update");
    const initialAgent=agent;agent=locked;
    const repeated=(await history(agent,tx)).find(c=>c.commandId===data.requestId);
    if(repeated){if(repeated.kind!==data.kind||repeated.taskId!==(data.taskId??null)||repeated.revision!==data.revision||repeated.requestedBy!==actor.id)throw conflict("请求编号已用于其他操作");return repeated;}
    const runtime=agent.adapterConfig.dsp7SeatRuntime as Record<string,unknown>|undefined;
    const presence=agent.adapterConfig.dsp7SeatPresence as Record<string,unknown>|undefined;
    if (!runtime || runtime.revision !== data.revision || ["paused","terminated","pending_approval"].includes(agent.status)) throw conflict("席位登记或状态已变化");
    if (!isSeatOnline(presence)) throw conflict("席位离线，无法接收请求");
    if (data.kind === "start") {
      if (!Number.isFinite(Date.parse(String(runtime.checkedAt))) || Date.now()-Date.parse(String(runtime.checkedAt))>=86400000) throw conflict("登记检查已过期，请刷新登记");
      if (!data.taskId || data.confirmNoOtherExecutor !== true) throw badRequest("请确认没有其他执行者");
      if (presence?.acceptingWork === false) throw conflict("本机已暂停接单，请负责人在电脑执行 harness online");
      if (!seatCanAcceptWork(presence)) throw conflict("席位配置异常，不能启动新执行者");
      const startTask=await taskFor(agent,data.taskId,tx);
      await assertSeatBudgetAdmission(tx,{companyId:agent.companyId,agentId:agent.id,projectId:startTask.projectId,taskId:startTask.id});
      if(startTask.status==="blocked")throw conflict("请先处理任务阻塞再启动");
      const dispatchRecords=await tx.select().from(activityLog).where(and(eq(activityLog.companyId,agent.companyId),eq(activityLog.action,"dsp7.platform.dispatch.changed"),eq(activityLog.entityId,startTask.id))).limit(1);
      if(dispatchRecords.length)await platformAuthorization(tx,agent,startTask);
      const live = await tx.select().from(heartbeatRuns).where(and(eq(heartbeatRuns.agentId,agent.id),inArray(heartbeatRuns.status,["queued","running"])));
      if (live.some(run => (run.contextSnapshot?.issueId ?? run.contextSnapshot?.taskId) === data.taskId)) throw conflict("工单已有活动运行");
    }

      const [fresh]=await tx.select().from(agents).where(eq(agents.id,agent.id)).for("update");
      if(actor.type==="user"&&!actor.manager&&seatOwnerId(fresh.adapterConfig.dsp7Seat as Record<string,unknown>)!==actor.id)throw forbidden("席位负责人已变化，请刷新页面");
      if(actor.type==="agent"&&seatOwnerId(fresh.adapterConfig.dsp7Seat as Record<string,unknown>)!==seatOwnerId(initialAgent.adapterConfig.dsp7Seat as Record<string,unknown>))throw conflict("席位负责人已变化，请重新读取接单规则");
      if(data.kind==="start"&&dispatchRule(fresh)?.intakePaused)throw conflict("已暂停接单，当前运行继续；恢复接单后再启动工单");
      const commands=await history(agent,tx as unknown as Db); const old=commands.find(c=>c.commandId===data.requestId);
      if (old) { if (old.kind !== data.kind || old.taskId !== (data.taskId??null) || old.revision !== data.revision || old.requestedBy !== actor.id) throw conflict("请求编号已用于其他操作"); return old; }
      const active=commands.filter(c=>!terminal.includes(c.status));
      if (active.length>=100 || active.some(c=>c.kind===data.kind&&(data.kind!=="start"||c.taskId===data.taskId))) throw conflict("已有相同操作等待处理，请查看请求状态");
      const command={commandId:data.requestId,agentId:agent.id,kind:data.kind,taskId:data.taskId??null,revision:data.revision,requestedBy:actor.id,expiresAt:new Date(Date.now()+15*60000).toISOString()};
      await tx.insert(activityLog).values({companyId:agent.companyId,actorType:actor.type,actorId:actor.id,agentId:agent.id,responsibleUserId:actor.type==="user"?actor.id:null,action:"dsp7.seat.command.requested",entityType:"dsp7_seat_command",entityId:command.commandId,details:command});
      return {...command,status:"queued",message:"等待本机接收"};
    };
    return transaction?execute(transaction):db.transaction(tx=>execute(tx as unknown as Db));
  }
  router.post("/agents/:id/dsp7-seat-stop",async(req,res)=>{
    const agent=await own(req);const parsed=z.object({runId:uuid}).safeParse(req.body);
    if(!parsed.success)throw badRequest("请选择本席位运行");
    // Commit intent before cancellation. Unknown network outcomes remain stopped.
    await db.transaction(async tx=>{
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${agent.id+":seat-commands"},0))`);
      await recordSeatStopIntent(tx as unknown as Db,agent,parsed.data.runId);
    });
    await heartbeatService(db).cancelRun(parsed.data.runId,"Stopped explicitly with harness stop",{resultJson:{cancelledByActorType:"user",dsp7StopOrigin:"harness_stop"}});
    res.json({runId:parsed.data.runId,stopRequested:true});
  });
  async function deliverableCommands(agent: typeof agents.$inferSelect) {
    const all = (await history(agent)).reverse();
    const capacity = await seatOccupancy(db, agent, all);
    let slots = Math.max(0, capacity.limit - capacity.occupied);
    const presence = agent.adapterConfig.dsp7SeatPresence as Record<string, unknown> | undefined;
    return all.filter(command => {
      if (!["queued", "awaiting_local"].includes(command.status)) return false;
      if (command.kind !== "start" || command.status === "awaiting_local") return true;
      if (!seatCanAcceptWork(presence) || slots <= 0) return false;
      slots--; return true;
    });
  }
  router.post("/agents/:id/dsp7-seat-heartbeat",async(req,res)=>{
    const parsed=presenceSchema.safeParse(req.body);if(!parsed.success)throw badRequest("心跳字段无效");const agent=await own(req);const body=parsed.data;
    await db.transaction(async tx=>{
      const [current]=await tx.select().from(agents).where(eq(agents.id,agent.id)).for("update");
      const {seat_id:_seat,machine_id:_machine,machine_fingerprint:_fp,...fields}=body;
      for (const task of body.tasks) if(task.stopRequestedRunId) await recordSeatStopIntent(tx as unknown as Db,current,task.stopRequestedRunId,task.taskId);
      const presence={...fields,lastSeenAt:new Date().toISOString()};const old=current.adapterConfig.dsp7SeatPresence as Record<string,unknown>|undefined;
      const upgrade = seatUpgradeState({ adapterConfig: { ...current.adapterConfig, dsp7SeatPresence: presence } });
      const upgradeCompleted = upgrade?.status === "succeeded" && (current.adapterConfig.dsp7SeatUpgrade as { status?: string } | undefined)?.status !== "succeeded";
      await tx.update(agents).set({adapterConfig:{...current.adapterConfig,dsp7SeatPresence:presence,...(upgradeCompleted ? { dsp7SeatUpgrade: { ...upgrade, updatedAt: new Date().toISOString() } } : {})}}).where(eq(agents.id,agent.id));
      if (upgradeCompleted && upgrade) await tx.insert(activityLog).values({ companyId: agent.companyId, agentId: agent.id, actorType: "agent", actorId: agent.id, action: "dsp7.seat.upgrade.succeeded", entityType: "dsp7_seat_upgrade", entityId: upgrade.requestId, details: { targetSha256: upgrade.targetSha256, status: "succeeded" } });
      const { recordSeatSample } = await import("../services/managed-seat-samples.js");
      await recordSeatSample(tx as unknown as Db,current,body.state,body.activeTaskId);
      if (body.repositories && JSON.stringify(old?.repositories ?? []) !== JSON.stringify(body.repositories)) await tx.insert(activityLog).values({ companyId:agent.companyId, actorType:"agent", actorId:agent.id, agentId:agent.id, action:"dsp7.seat.repositories.changed", entityType:"agent", entityId:agent.id, details:{repositoryCount:body.repositories.length} });
      const oldIds=new Set(((old?.alerts as Array<Record<string,unknown>>)||[]).map(a=>a.id+":"+a.level));const changed=body.alerts.filter(a=>!oldIds.has(a.id+":"+a.level));
      if(old?.state!==body.state||changed.length)await tx.insert(activityLog).values({companyId:agent.companyId,actorType:"agent",actorId:agent.id,agentId:agent.id,action:"dsp7.seat.presence.changed",entityType:"agent",entityId:agent.id,details:{state:body.state,alerts:changed}});
    });
    try { await retryStoppedSeatExecution(db,agent.id,agent.companyId); } catch { logger.warn({agentId:agent.id},"Seat retry remains gated; no replacement started"); }
    const policy=seatPolicySchema.safeParse(agent.adapterConfig.dsp7SeatPolicy);
    if(policy.success)try{await notifySeatBot(db,agent,policy.data,body.alerts);}catch{logger.warn({agentId:agent.id},"Seat bot notification failed; heartbeat continues");}
    // Old bridges must not interpret a robot selection as a personal DWS sender.
    res.json({serverTime:new Date().toISOString(),dispatch:publicRule(agent),policy:policy.success?{...policy.data,...(policy.data.dingtalk?.botId?{dingtalk:null}:{})}:defaultSeatPolicy,maxConcurrentRuns:seatConcurrencyLimit(agent),commands:await deliverableCommands({...agent,adapterConfig:{...agent.adapterConfig,dsp7SeatPresence:{...body,lastSeenAt:new Date().toISOString()}}})});
  });
  const commandWaiters=new Map<string,number>();
  router.post("/agents/:id/dsp7-seat-commands/wait",async(req,res)=>{
    const agent=await own(req);
    const parsed=z.object({knownCommandIds:z.array(uuid).max(100).default([])}).safeParse(req.body);
    if(!parsed.success)throw badRequest("指令游标无效");
    const count=commandWaiters.get(agent.id)??0;
    if(count>=2)throw conflict("已有指令连接，请勿重复启动接入桥");
    commandWaiters.set(agent.id,count+1);res.setHeader("Cache-Control","no-store");
    const known=new Set(parsed.data.knownCommandIds);const deadline=Date.now()+18000;
    let closed=false;const close=()=>{closed=true;};res.on("close",close);
    try{
      while(!closed){
        const current=await own(req);
        const commands=(await deliverableCommands(current)).filter(c=>!known.has(c.commandId));
        if(commands.length||Date.now()>=deadline){
          const policy=seatPolicySchema.safeParse(current.adapterConfig.dsp7SeatPolicy);
          if(!closed)res.json({commands,dispatch:publicRule(current),policy:policy.success?{...policy.data,...(policy.data.dingtalk?.botId?{dingtalk:null}:{})}:defaultSeatPolicy});
          return;
        }
        await new Promise<void>(resolve=>{
          const done=()=>{clearTimeout(timer);res.off("close",done);resolve();};
          const timer=setTimeout(done,1000);res.once("close",done);
        });
      }
    }finally{res.off("close",close);const remaining=(commandWaiters.get(agent.id)??1)-1;if(remaining)commandWaiters.set(agent.id,remaining);else commandWaiters.delete(agent.id);}
  });
  router.get("/companies/:companyId/dsp7-seats/:id/notification-contacts",async(req,res)=>{
    await board(req);
    const people=await db.select({externalId:personnelPeople.externalId,name:personnelPeople.name,departmentIds:personnelPeople.departmentIds,userId:personnelPeople.userId,sourceId:personnelSources.id,corpId:personnelSources.corpId,organization:personnelSources.name}).from(personnelPeople).innerJoin(personnelSources,eq(personnelPeople.sourceId,personnelSources.id)).where(and(eq(personnelSources.type,"DingTalk"),eq(personnelSources.enabled,true),eq(personnelPeople.active,true)));
    const departments=await db.select().from(personnelDepartments).where(eq(personnelDepartments.active,true));
    const contacts=people.map(({departmentIds,sourceId,...person})=>({...person,departments:departmentIds.map(id=>departments.find(d=>d.sourceId===sourceId&&d.externalId===id)?.name).filter(Boolean)}));
    res.json([...new Map(contacts.map(person=>[person.corpId+":"+person.externalId,person])).values()]);
  });
  router.get("/companies/:companyId/dsp7-seats/:id/commands",async(req,res)=>res.json(await history(await board(req))));
  router.post("/companies/:companyId/dsp7-seats/:id/commands",async(req,res)=>{
    const agent=await board(req);const parsed=commandSchema.safeParse(req.body);if(!parsed.success)throw badRequest("请求字段无效");res.status(201).json(await createCommand(agent,parsed.data,{type:"user",id:req.actor.userId??"local-board",manager:isSeatManager(req,agent.companyId)}));
  });
  router.post("/agents/:id/dsp7-seat-command-result",async(req,res)=>{
    const agent=await own(req);const parsed=z.object({commandId:uuid,status:z.enum(["awaiting_local","accepted","running","succeeded","failed","denied","expired"]),message:z.string().max(500),runId:uuid.nullable().optional(),stage:z.enum(["runtime_verified","jira_verified","run_requested"]).optional(),elapsedMs:z.number().int().min(0).max(600000).optional()}).safeParse(req.body);if(!parsed.success||parsed.data.stage&&parsed.data.status!=="accepted")throw badRequest("回执无效");
    const result=await db.transaction(async tx=>{
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${agent.id+":seat-commands"},0))`);
      const [fresh]=await tx.select().from(agents).where(eq(agents.id,agent.id)).for("update");
      const command=(await history(agent,tx as unknown as Db)).find(c=>c.commandId===parsed.data.commandId);
      if (command?.kind === "start" && command.taskId && ["queued", "awaiting_local"].includes(command.status) && ["awaiting_local", "accepted"].includes(parsed.data.status)) {
        const all = await history(fresh, tx as unknown as Db);
        const capacity = await seatOccupancy(tx as unknown as Db, fresh, all, command.taskId);
        if (!seatCanAcceptWork(fresh.adapterConfig.dsp7SeatPresence as Record<string, unknown>) || capacity.occupied >= capacity.limit) throw conflict("席位并发已满，工单继续排队");
      }
      if(command?.kind==="start"&&parsed.data.status==="accepted"&&command.taskId){
        const task=await taskFor(fresh,command.taskId,tx as unknown as Db);
        await assertSeatBudgetAdmission(tx as unknown as Db,{companyId:fresh.companyId,agentId:fresh.id,projectId:task.projectId,taskId:task.id});
        const records=await tx.select().from(activityLog).where(and(eq(activityLog.companyId,fresh.companyId),eq(activityLog.action,"dsp7.platform.dispatch.changed"),eq(activityLog.entityId,task.id))).limit(1);
        if(records.length)await platformAuthorization(tx as unknown as Db,fresh,task);
      }
      if(command?.kind==="start"&&["queued","awaiting_local"].includes(command.status)&&parsed.data.status==="accepted"&&dispatchRule(fresh)?.intakePaused)throw conflict("已暂停接单，请恢复后再启动");if(!command)throw notFound("请求不存在");
      if(command.status===parsed.data.status&&!parsed.data.stage)return command;
      if(terminal.includes(command.status)||!(transitions[command.status]?.includes(parsed.data.status)||(command.status===parsed.data.status&&parsed.data.stage)))throw conflict("请求已变化，不能重复执行");
      const details={...parsed.data,expiresAt:command.status==="queued"&&["awaiting_local","accepted"].includes(parsed.data.status)?new Date(Date.now()+15*60000).toISOString():command.expiresAt,sequence:command.sequence+1};
      await tx.insert(activityLog).values({companyId:agent.companyId,actorType:"agent",actorId:agent.id,agentId:agent.id,action:"dsp7.seat.command.result",entityType:"dsp7_seat_command",entityId:parsed.data.commandId,details});return {...command,...details};
    });res.json(result);
  });
  router.post("/companies/:companyId/dsp7-seats/:id/commands/:commandId/cancel",async(req,res)=>{
    const agent=await board(req);await db.transaction(async tx=>{
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${agent.id+":seat-commands"},0))`);
      const command=(await history(agent,tx as unknown as Db)).find(c=>c.commandId===String(req.params.commandId));
      if(!command||!["queued","awaiting_local"].includes(command.status))throw conflict("请求已领取或结束，请在任务页处理活动运行");
      await tx.insert(activityLog).values({companyId:agent.companyId,actorType:"user",actorId:req.actor.userId??"local-board",agentId:agent.id,action:"dsp7.seat.command.result",entityType:"dsp7_seat_command",entityId:String(req.params.commandId),details:{commandId:command.commandId,status:"cancelled",message:"网页已取消",sequence:command.sequence+1}});
    });res.json({status:"cancelled"});
  });
  router.post("/companies/:companyId/dsp7-seats/:id/policy",async(req,res)=>{
    const agent=await board(req);const parsed=seatPolicySchema.safeParse(req.body);if(!parsed.success)throw badRequest("策略或提醒时间无效");if(parsed.data.dingtalk?.botId)await validateSeatBotTarget(db,agent.companyId,parsed.data.dingtalk);if(parsed.data.mode!=="manual"&&!parsed.data.jiraKeys.length)throw badRequest("主动推进需限定工单号");
    await db.transaction(async tx=>{const[current]=await tx.select().from(agents).where(eq(agents.id,agent.id)).for("update");if(!canConfigureSeat(req,current.companyId,current.adapterConfig.dsp7Seat as Record<string,unknown>))throw forbidden("席位负责人已变化，请刷新页面");if(parsed.data.dingtalk?.groupId){const bot=await validateSeatBotTarget(tx as unknown as Db,current.companyId,parsed.data.dingtalk);await validateSeatGroupTarget(tx as unknown as Db,current,parsed.data.dingtalk,bot);}await tx.update(agents).set({adapterConfig:{...current.adapterConfig,dsp7SeatPolicy:parsed.data},updatedAt:new Date()}).where(eq(agents.id,agent.id));await tx.insert(activityLog).values({companyId:agent.companyId,actorType:"user",actorId:req.actor.userId??"local-board",agentId:agent.id,action:"dsp7.seat.policy.updated",entityType:"agent",entityId:agent.id,details:parsed.data});});res.json(parsed.data);
  });
  router.post("/agents/:id/dsp7-seat-auto-request",async(req,res)=>{
    const agent=await own(req);const parsed=commandSchema.safeParse(req.body.command);if(!parsed.success||parsed.data.kind!=="start"||!parsed.data.taskId)throw badRequest("自动请求无效");
    const policy=seatPolicySchema.safeParse(agent.adapterConfig.dsp7SeatPolicy);const task=await taskFor(agent,parsed.data.taskId);const key=task.description?.match(/DSP7-PILOT:([A-Z][A-Z0-9_]*-\d+)/)?.[1];
    const dispatch=dispatchRule(agent);
    if(task.createdByAgentId===agent.id)throw forbidden("Jira 指派不再触发启动，请在智研平台派单");
    if(task.createdByUserId&&task.description?.includes('"status_source":"seat_rule"'))await platformAuthorization(db,agent,task);
    else if(!policy.success||policy.data.mode==="manual"||!key||!policy.data.jiraKeys.includes(key))throw forbidden("工单不在主动推进范围");res.status(201).json(await createCommand(agent,parsed.data,{type:"agent",id:agent.id}));
  });
  router.post("/companies/:companyId/dsp7-seat-enrollments",async(req,res)=>{
    assertInstanceAdmin(req);assertCompanyAccess(req,String(req.params.companyId));const parsed=invitationSchema.safeParse({...req.body,intakeUserIds: req.body.intakeUserIds?.length ? req.body.intakeUserIds : [req.actor.userId]});if(!parsed.success)throw badRequest("接入资料无效");const data=parsed.data;
    if(data.intakeUserIds.length!==1)throw badRequest("每个席位只能指定一位负责人");
    await requireSeatOwner(db,String(req.params.companyId),data.intakeUserIds[0]!);
    const[agent]=await db.select().from(agents).where(and(eq(agents.id,data.agentId),eq(agents.companyId,String(req.params.companyId))));const[env]=await db.select().from(environments).where(eq(environments.id,data.environmentId));
    if(!agent||!env||env.status!=="active"||!["ssh","local"].includes(env.driver)||["paused","terminated","pending_approval"].includes(agent.status)||agent.adapterConfig.dsp7Seat)throw conflict("请选择尚未绑定席位的可用 Agent 和环境");
    const token=randomBytes(32).toString("hex"),invitationId=randomUUID(),expiresAt=new Date(Date.now()+15*60000).toISOString();
    await db.insert(activityLog).values({companyId:agent.companyId,actorType:"user",actorId:req.actor.userId??"local-board",agentId:agent.id,action:"dsp7.seat.enrollment.invited",entityType:"dsp7_seat_enrollment",entityId:invitationId,details:{...data,tokenHash:createHash("sha256").update(token).digest("hex"),expiresAt,responsibleUserId:data.intakeUserIds[0]}});
    res.setHeader("Cache-Control","no-store");res.status(201).json({invitationId,token,companyId:agent.companyId,...data,expiresAt});
  });
  router.post("/dsp7-seat-enroll",async(req,res)=>{
    const parsed=machine.extend({invitationId:uuid,token:z.string().regex(/^[a-f0-9]{64}$/)}).strict().safeParse(req.body);if(!parsed.success)throw badRequest("接入邀请无效");const body=parsed.data;
    const result=await db.transaction(async tx=>{
      const[invite]=await tx.select().from(activityLog).where(and(eq(activityLog.entityType,"dsp7_seat_enrollment"),eq(activityLog.entityId,body.invitationId),eq(activityLog.action,"dsp7.seat.enrollment.invited"))).limit(1);const data=invite?.details;
      if(!data||data.agentId!==body.seat_id||data.tokenHash!==createHash("sha256").update(body.token).digest("hex")||Date.parse(String(data.expiresAt))<=Date.now()||!data.responsibleUserId)throw forbidden("邀请无效或过期");
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${invite.companyId+":seat-enrollment"},0))`);
      const[used]=await tx.select().from(activityLog).where(and(eq(activityLog.entityId,body.invitationId),eq(activityLog.action,"dsp7.seat.enrollment.completed"))).limit(1);if(used)throw conflict("邀请已使用，不能重复领取");
      const peers=await tx.select().from(agents).where(eq(agents.companyId,invite.companyId));if(peers.some(p=>(p.adapterConfig.dsp7Seat as Record<string,unknown>|undefined)?.machineFingerprint===body.machine_fingerprint))throw conflict("这台电脑已有席位，请复用原 Agent");
      const[agent]=await tx.select().from(agents).where(and(eq(agents.id,body.seat_id),eq(agents.companyId,invite.companyId))).for("update");const[env]=await tx.select().from(environments).where(eq(environments.id,String(data.environmentId)));const[run]=await tx.select().from(heartbeatRuns).where(and(eq(heartbeatRuns.agentId,body.seat_id),inArray(heartbeatRuns.status,["queued","running"])));
      if(!agent||agent.adapterConfig.dsp7Seat||run||!env||env.status!=="active"||["paused","terminated","pending_approval"].includes(agent.status))throw conflict("Agent 或环境已变化");
      await requireSeatOwner(tx as unknown as Db,agent.companyId,String(data.responsibleUserId));
      const token="pcp_"+randomBytes(32).toString("hex");await tx.insert(agentApiKeys).values({companyId:agent.companyId,agentId:agent.id,name:"DSP7 machine seat",keyHash:createHash("sha256").update(token).digest("hex"),responsibleUserId:String(data.responsibleUserId),scopeConfig:null});
      const { aiConnection: _connection, ...localConfig } = agent.adapterConfig;
      const localEnv = Object.fromEntries(Object.entries((localConfig.env as Record<string,unknown>)??{}).filter(([key])=>!/^ANTHROPIC_|^CLAUDE_CODE_OAUTH/.test(key)));
      await tx.update(agents).set({adapterType:"claude_local",defaultEnvironmentId:String(data.environmentId),adapterConfig:{...localConfig,env:localEnv,engine:"cli",command:String(data.bridgeRoot)+"/claude-interactive-wrapper",extraArgs:["--add-dir",String(data.harnessRoot),"--add-dir",String(data.bridgeRoot)],dsp7WebJiraIntake:true,dsp7Seat:{machineId:body.machine_id,machineFingerprint:body.machine_fingerprint,name:data.name,ownerUserId:data.responsibleUserId,intakeUserIds:data.intakeUserIds}},updatedAt:new Date()}).where(eq(agents.id,agent.id));
      await tx.insert(activityLog).values({companyId:agent.companyId,actorType:"system",actorId:"seat-enrollment",agentId:agent.id,action:"dsp7.seat.enrollment.completed",entityType:"dsp7_seat_enrollment",entityId:body.invitationId,details:{agentId:agent.id,machineId:body.machine_id,authorizedBy:invite.actorId}});return{agentId:agent.id,companyId:agent.companyId,token};
    });res.setHeader("Cache-Control","no-store");res.status(201).json(result);
  });
  return router;
}
