import { logger } from "../middleware/logger.js";
import { seatBotRoutes, notifySeatBot, validateSeatBotTarget } from "./dsp7-seat-bots.js";
import { dsp7JiraDispatchRoutes, dispatchRule, dispatchAuthorization, publicRule } from "./dsp7-jira-dispatch.js";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { dsp7QuickSeatRoutes } from "./dsp7-quick-seats.js";
import { Router, type Request } from "express";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { activityLog, agentApiKeys, agents, environments, heartbeatRuns, issues, personnelPeople, personnelSources, personnelDepartments, type Db } from "@paperclipai/db";
import { z } from "zod";
import { assertBoard, assertCompanyAccess, assertInstanceAdmin } from "./authz.js";
import { badRequest, conflict, forbidden, notFound } from "../errors.js";
const uuid = z.string().uuid();
const machine = z.object({ seat_id: uuid, machine_id: uuid, machine_fingerprint: z.string().regex(/^[a-f0-9]{64}$/) });
const check = z.object({ id: z.string().max(80), label: z.string().max(100), status: z.enum(["pass", "fail", "warn"]), message: z.string().max(500) });
const alert = z.object({ id: z.string().max(160), taskId: uuid.nullable(), jiraKey: z.string().max(80), level: z.enum(["info", "warning", "urgent"]), message: z.string().max(500), elapsedMinutes: z.number().min(0).max(525600) });
const presenceSchema = machine.extend({ revision: z.number().int().positive().nullable(), state: z.enum(["idle", "busy", "waiting_decision", "awaiting_local", "config_error", "error"]), activeTaskId: uuid.nullable(), runId: uuid.nullable(), checkedAt: z.string().datetime({ offset: true }), checks: z.array(check).max(12), alerts: z.array(alert).max(20), tasks: z.array(z.object({ taskId: uuid, jiraKey: z.string().regex(/^[A-Z][A-Z0-9_]*-\d+$/), status: z.string().max(50), mode: z.enum(["replay", "formal"]), automatic:z.boolean().optional(), ready: z.boolean() })).max(50), autoPermit: z.object({ until: z.string().datetime({ offset: true }), jiraKeys: z.array(z.string().max(80)).max(50) }).nullable() }).strict();
const commandSchema = z.object({ requestId: uuid, kind: z.enum(["check", "refresh", "start"]), taskId: uuid.optional(), revision: z.number().int().positive(), confirmNoOtherExecutor: z.boolean().optional() }).strict();
export const seatPolicySchema = z.object({ mode: z.enum(["manual", "notify", "auto"]), jiraKeys: z.array(z.string().regex(/^[A-Z][A-Z0-9_]*-\d+$/)).max(50), reminderMinutes: z.number().int().min(1).max(1440), escalationMinutes: z.number().int().min(2).max(10080), dingtalk: z.object({ userId: z.string().regex(/^[A-Za-z0-9_-]{1,100}$/), botId: uuid.optional(), profile: z.string().regex(/^[A-Za-z0-9_-]+:[A-Za-z0-9_-]+$/).max(200).optional() }).strict().refine(v=>Boolean(v.botId)||Boolean(v.profile)).nullable().optional() }).strict().refine(v => v.escalationMinutes > v.reminderMinutes);
export const defaultSeatPolicy = { mode: "manual", jiraKeys: [], reminderMinutes: 10, escalationMinutes: 30 };
export function isSeatOnline(p: Record<string, unknown> | undefined, now = Date.now()) { const seen = Date.parse(String(p?.lastSeenAt)); return Number.isFinite(seen) && seen <= now + 5000 && now - seen < 90000; }
export function commandState(request: Record<string, unknown>, events: Array<{ details: Record<string, unknown> | null }>, now = Date.now()) {
  const last = events.filter(e => e.details?.commandId === request.commandId).sort((a,b) => Number(b.details?.sequence ?? 0)-Number(a.details?.sequence ?? 0))[0]?.details;
  const status = String(last?.status ?? "queued");
  if (["queued", "awaiting_local", "accepted"].includes(status) && Date.parse(String(request.expiresAt)) <= now) return { status: "expired", message: "请求已过期，请核对本机后重试", sequence: Number(last?.sequence ?? 0), runId: null };
  return { status, message: String(last?.message ?? "等待本机接收"), sequence: Number(last?.sequence ?? 0), runId: last?.runId ?? null };
}
const terminal = ["succeeded", "failed", "denied", "cancelled", "expired"];
const transitions: Record<string,string[]> = { queued: ["awaiting_local", "accepted", "failed", "denied", "cancelled", "expired"], awaiting_local: ["accepted", "failed", "denied", "cancelled", "expired"], accepted: ["running", "succeeded", "failed", "denied", "expired"], running: ["succeeded", "failed"] };
const path = z.string().regex(/^\//).max(2048).refine(v => !/[\r\n\0]/.test(v));
const invitationSchema = z.object({ agentId: uuid, environmentId: uuid, name: z.string().trim().min(1).max(100), harnessRoot: path, bridgeRoot: path, claudeCommand: path, settingsFile: path.nullable(), intakeUserIds: z.array(z.string().min(1).max(200)).min(1).max(50) }).strict();
export function dsp7SeatControlRoutes(db: Db) {
  const router = Router();
  router.use(dsp7QuickSeatRoutes(db));
  router.use(seatBotRoutes(db));
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
    if (!req.actor.isInstanceAdmin && req.actor.source !== "local_implicit" && !(Array.isArray(seat.intakeUserIds) && seat.intakeUserIds.includes(req.actor.userId))) throw forbidden("未获席位授权");
    return agent;
  }
  router.use(dsp7JiraDispatchRoutes(db,own,board));
  async function history(agent: typeof agents.$inferSelect, tx: Db = db) {
    const events = await tx.select().from(activityLog).where(and(eq(activityLog.companyId, agent.companyId), eq(activityLog.agentId, agent.id), eq(activityLog.entityType,"dsp7_seat_command"))).orderBy(desc(activityLog.createdAt)).limit(500);
    return events.filter(e => e.action === "dsp7.seat.command.requested").map(e => ({ ...(e.details as { commandId: string; kind: string; taskId: string | null; revision: number; requestedBy: string; expiresAt: string }), ...commandState(e.details!,events), createdAt:e.createdAt.toISOString() }));
  }
  async function taskFor(agent: typeof agents.$inferSelect, id: string) {
    const [task] = await db.select().from(issues).where(and(eq(issues.id,id),eq(issues.companyId,agent.companyId)));
    if (!task || ["done","cancelled"].includes(task.status) || task.assigneeUserId || (task.assigneeAgentId && task.assigneeAgentId !== agent.id) || !task.description?.includes("DSP7-PILOT:")) throw conflict("请选择本席位已登记、未结束的 Harness 工单");
    const raw = task.description.match(/<!-- DSP7-JIRA-INTAKE (.*?) -->/)?.[1];
    if (raw) {
      let intake;try { intake=JSON.parse(raw); } catch { throw badRequest("工单登记无效"); }
      if (intake.seat_id !== agent.id) throw forbidden("工单属于其他席位");
      const [claim]=await db.select().from(activityLog).where(and(eq(activityLog.companyId,agent.companyId),eq(activityLog.action,"dsp7.jira.reserved"),eq(activityLog.entityId,intake.jira_key))).limit(1);
      if (claim?.details?.taskId !== task.id || claim.details.seatId !== agent.id) throw conflict("工单缺少独占登记");
    } else if (task.assigneeAgentId !== agent.id) {
      const presence=agent.adapterConfig.dsp7SeatPresence as {tasks?:Array<{taskId:string;mode:string}>}|undefined;
      if(!task.description.includes("明确模式：replay")||!presence?.tasks?.some(item=>item.taskId===task.id&&item.mode==="replay"))throw forbidden("模拟工单尚未由本机确认登记");
    }
    return task;
  }
  async function createCommand(agent: typeof agents.$inferSelect, data:z.infer<typeof commandSchema>, actor:{type:string;id:string}) {
    const repeated=(await history(agent)).find(c=>c.commandId===data.requestId);
    if(repeated){if(repeated.kind!==data.kind||repeated.taskId!==(data.taskId??null)||repeated.revision!==data.revision||repeated.requestedBy!==actor.id)throw conflict("请求编号已用于其他操作");return repeated;}
    const runtime=agent.adapterConfig.dsp7SeatRuntime as Record<string,unknown>|undefined;
    const presence=agent.adapterConfig.dsp7SeatPresence as Record<string,unknown>|undefined;
    if (!runtime || runtime.revision !== data.revision || ["paused","terminated","pending_approval"].includes(agent.status)) throw conflict("席位登记或状态已变化");
    if (!isSeatOnline(presence)) throw conflict("席位离线，无法接收请求");
    if (data.kind === "start") {
      if (!Number.isFinite(Date.parse(String(runtime.checkedAt))) || Date.now()-Date.parse(String(runtime.checkedAt))>=86400000) throw conflict("登记检查已过期，请刷新登记");
      if (!data.taskId || data.confirmNoOtherExecutor !== true) throw badRequest("请确认没有其他执行者");
      if (presence?.state !== "idle") throw conflict("席位忙碌或配置异常，不能启动另一个执行者");
      await taskFor(agent,data.taskId);
      const [run]=await db.select().from(heartbeatRuns).where(and(eq(heartbeatRuns.agentId,agent.id),inArray(heartbeatRuns.status,["queued","running"])));
      if (run) throw conflict("席位已有活动运行");
    }
    return db.transaction(async tx => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${agent.id+":seat-commands"},0))`);
      const [fresh]=await tx.select().from(agents).where(eq(agents.id,agent.id)).for("update");
      if(data.kind==="start"&&dispatchRule(fresh)?.intakePaused)throw conflict("已暂停接单，当前运行继续；恢复接单后再启动工单");
      const commands=await history(agent,tx as unknown as Db); const old=commands.find(c=>c.commandId===data.requestId);
      if (old) { if (old.kind !== data.kind || old.taskId !== (data.taskId??null) || old.revision !== data.revision || old.requestedBy !== actor.id) throw conflict("请求编号已用于其他操作"); return old; }
      const active=commands.filter(c=>!terminal.includes(c.status));
      if (active.length>=10 || active.some(c=>c.kind===data.kind)) throw conflict("已有相同操作等待处理，请查看请求状态");
      const command={commandId:data.requestId,agentId:agent.id,kind:data.kind,taskId:data.taskId??null,revision:data.revision,requestedBy:actor.id,expiresAt:new Date(Date.now()+15*60000).toISOString()};
      await tx.insert(activityLog).values({companyId:agent.companyId,actorType:actor.type,actorId:actor.id,agentId:agent.id,responsibleUserId:actor.type==="user"?actor.id:null,action:"dsp7.seat.command.requested",entityType:"dsp7_seat_command",entityId:command.commandId,details:command});
      return {...command,status:"queued",message:"等待本机接收"};
    });
  }
  router.post("/agents/:id/dsp7-seat-heartbeat",async(req,res)=>{
    const parsed=presenceSchema.safeParse(req.body);if(!parsed.success)throw badRequest("心跳字段无效");const agent=await own(req);const body=parsed.data;
    await db.transaction(async tx=>{
      const [current]=await tx.select().from(agents).where(eq(agents.id,agent.id)).for("update");
      const {seat_id:_seat,machine_id:_machine,machine_fingerprint:_fp,...fields}=body;
      const presence={...fields,lastSeenAt:new Date().toISOString()};const old=current.adapterConfig.dsp7SeatPresence as Record<string,unknown>|undefined;
      await tx.update(agents).set({adapterConfig:{...current.adapterConfig,dsp7SeatPresence:presence}}).where(eq(agents.id,agent.id));
      const oldIds=new Set(((old?.alerts as Array<Record<string,unknown>>)||[]).map(a=>a.id+":"+a.level));const changed=body.alerts.filter(a=>!oldIds.has(a.id+":"+a.level));
      if(old?.state!==body.state||changed.length)await tx.insert(activityLog).values({companyId:agent.companyId,actorType:"agent",actorId:agent.id,agentId:agent.id,action:"dsp7.seat.presence.changed",entityType:"agent",entityId:agent.id,details:{state:body.state,alerts:changed}});
    });
    const policy=seatPolicySchema.safeParse(agent.adapterConfig.dsp7SeatPolicy);
    if(policy.success)try{await notifySeatBot(db,agent,policy.data,body.alerts);}catch{logger.warn({agentId:agent.id},"Seat bot notification failed; heartbeat continues");}
    // Old bridges must not interpret a robot selection as a personal DWS sender.
    res.json({serverTime:new Date().toISOString(),dispatch:publicRule(agent),policy:policy.success?{...policy.data,...(policy.data.dingtalk?.botId?{dingtalk:null}:{})}:defaultSeatPolicy,commands:(await history(agent)).filter(c=>["queued","awaiting_local"].includes(c.status))});
  });
  router.get("/companies/:companyId/dsp7-seats/:id/notification-contacts",async(req,res)=>{
    const agent=await board(req);
    const people=await db.select({externalId:personnelPeople.externalId,name:personnelPeople.name,departmentIds:personnelPeople.departmentIds,userId:personnelPeople.userId,sourceId:personnelSources.id,corpId:personnelSources.corpId,organization:personnelSources.name}).from(personnelPeople).innerJoin(personnelSources,eq(personnelPeople.sourceId,personnelSources.id)).where(and(eq(personnelPeople.companyId,agent.companyId),eq(personnelSources.companyId,agent.companyId),eq(personnelSources.type,"DingTalk"),eq(personnelSources.enabled,true),eq(personnelPeople.active,true)));
    const departments=await db.select().from(personnelDepartments).where(and(eq(personnelDepartments.companyId,agent.companyId),eq(personnelDepartments.active,true)));
    res.json(people.map(({departmentIds,sourceId,...person})=>({...person,departments:departmentIds.map(id=>departments.find(d=>d.sourceId===sourceId&&d.externalId===id)?.name).filter(Boolean)})));
  });
  router.get("/companies/:companyId/dsp7-seats/:id/commands",async(req,res)=>res.json(await history(await board(req))));
  router.post("/companies/:companyId/dsp7-seats/:id/commands",async(req,res)=>{
    const agent=await board(req);const parsed=commandSchema.safeParse(req.body);if(!parsed.success)throw badRequest("请求字段无效");res.status(201).json(await createCommand(agent,parsed.data,{type:"user",id:req.actor.userId??"local-board"}));
  });
  router.post("/agents/:id/dsp7-seat-command-result",async(req,res)=>{
    const agent=await own(req);const parsed=z.object({commandId:uuid,status:z.enum(["awaiting_local","accepted","running","succeeded","failed","denied","expired"]),message:z.string().max(500),runId:uuid.nullable().optional()}).safeParse(req.body);if(!parsed.success)throw badRequest("回执无效");
    const result=await db.transaction(async tx=>{
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${agent.id+":seat-commands"},0))`);
      const [fresh]=await tx.select().from(agents).where(eq(agents.id,agent.id)).for("update");
      const command=(await history(agent,tx as unknown as Db)).find(c=>c.commandId===parsed.data.commandId);
      if(command?.kind==="start"&&["queued","awaiting_local"].includes(command.status)&&parsed.data.status==="accepted"&&dispatchRule(fresh)?.intakePaused)throw conflict("已暂停接单，请恢复后再启动");if(!command)throw notFound("请求不存在");
      if(command.status===parsed.data.status)return command;
      if(terminal.includes(command.status)||!transitions[command.status]?.includes(parsed.data.status))throw conflict("请求已变化，不能重复执行");
      const details={...parsed.data,sequence:command.sequence+1};
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
    await db.transaction(async tx=>{const[current]=await tx.select().from(agents).where(eq(agents.id,agent.id)).for("update");await tx.update(agents).set({adapterConfig:{...current.adapterConfig,dsp7SeatPolicy:parsed.data},updatedAt:new Date()}).where(eq(agents.id,agent.id));await tx.insert(activityLog).values({companyId:agent.companyId,actorType:"user",actorId:req.actor.userId??"local-board",agentId:agent.id,action:"dsp7.seat.policy.updated",entityType:"agent",entityId:agent.id,details:parsed.data});});res.json(parsed.data);
  });
  router.post("/agents/:id/dsp7-seat-auto-request",async(req,res)=>{
    const agent=await own(req);const parsed=commandSchema.safeParse(req.body.command);if(!parsed.success||parsed.data.kind!=="start"||!parsed.data.taskId)throw badRequest("自动请求无效");
    const policy=seatPolicySchema.safeParse(agent.adapterConfig.dsp7SeatPolicy);const task=await taskFor(agent,parsed.data.taskId);const key=task.description?.match(/DSP7-PILOT:([A-Z][A-Z0-9_]*-\d+)/)?.[1];
    const dispatch=dispatchRule(agent);
    if(dispatch?.enabled&&task.createdByAgentId===agent.id)await dispatchAuthorization(db,agent,task);
    else if(!policy.success||policy.data.mode==="manual"||!key||!policy.data.jiraKeys.includes(key))throw forbidden("工单不在主动推进范围");res.status(201).json(await createCommand(agent,parsed.data,{type:"agent",id:agent.id}));
  });
  router.post("/companies/:companyId/dsp7-seat-enrollments",async(req,res)=>{
    assertInstanceAdmin(req);assertCompanyAccess(req,String(req.params.companyId));const parsed=invitationSchema.safeParse({...req.body,intakeUserIds: req.body.intakeUserIds?.length ? req.body.intakeUserIds : [req.actor.userId]});if(!parsed.success)throw badRequest("接入资料无效");const data=parsed.data;
    const[agent]=await db.select().from(agents).where(and(eq(agents.id,data.agentId),eq(agents.companyId,String(req.params.companyId))));const[env]=await db.select().from(environments).where(eq(environments.id,data.environmentId));
    if(!agent||!env||env.status!=="active"||!["ssh","local"].includes(env.driver)||["paused","terminated","pending_approval"].includes(agent.status)||agent.adapterConfig.dsp7Seat)throw conflict("请选择尚未绑定席位的可用 Agent 和环境");
    const token=randomBytes(32).toString("hex"),invitationId=randomUUID(),expiresAt=new Date(Date.now()+15*60000).toISOString();
    await db.insert(activityLog).values({companyId:agent.companyId,actorType:"user",actorId:req.actor.userId??"local-board",agentId:agent.id,action:"dsp7.seat.enrollment.invited",entityType:"dsp7_seat_enrollment",entityId:invitationId,details:{...data,tokenHash:createHash("sha256").update(token).digest("hex"),expiresAt,responsibleUserId:req.actor.userId}});
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
      const token="pcp_"+randomBytes(32).toString("hex");await tx.insert(agentApiKeys).values({companyId:agent.companyId,agentId:agent.id,name:"DSP7 machine seat",keyHash:createHash("sha256").update(token).digest("hex"),responsibleUserId:String(data.responsibleUserId),scopeConfig:null});
      const { aiConnection: _connection, ...localConfig } = agent.adapterConfig;
      const localEnv = Object.fromEntries(Object.entries((localConfig.env as Record<string,unknown>)??{}).filter(([key])=>!/^ANTHROPIC_|^CLAUDE_CODE_OAUTH/.test(key)));
      await tx.update(agents).set({adapterType:"claude_local",defaultEnvironmentId:String(data.environmentId),adapterConfig:{...localConfig,env:localEnv,engine:"cli",command:String(data.bridgeRoot)+"/claude-interactive-wrapper",extraArgs:["--add-dir",String(data.harnessRoot),"--add-dir",String(data.bridgeRoot)],dsp7WebJiraIntake:true,dsp7Seat:{machineId:body.machine_id,machineFingerprint:body.machine_fingerprint,name:data.name,intakeUserIds:data.intakeUserIds}},updatedAt:new Date()}).where(eq(agents.id,agent.id));
      await tx.insert(activityLog).values({companyId:agent.companyId,actorType:"system",actorId:"seat-enrollment",agentId:agent.id,action:"dsp7.seat.enrollment.completed",entityType:"dsp7_seat_enrollment",entityId:body.invitationId,details:{agentId:agent.id,machineId:body.machine_id,authorizedBy:invite.actorId}});return{agentId:agent.id,companyId:agent.companyId,token};
    });res.setHeader("Cache-Control","no-store");res.status(201).json(result);
  });
  return router;
}
