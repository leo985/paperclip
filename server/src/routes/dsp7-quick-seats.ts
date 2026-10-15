import { createHash, randomBytes, randomUUID } from "node:crypto";
import { Router, type Request } from "express";
import { and, eq, sql } from "drizzle-orm";
import { activityLog, agentApiKeys, agents, companies, environments, heartbeatRuns, companyMemberships, instanceUserRoles, type Db } from "@paperclipai/db";
import { z } from "zod";
import { assertBoard, assertCompanyAccess } from "./authz.js";
import { accessService } from "../services/access.js";
import { badRequest, conflict, forbidden } from "../errors.js";
import { claimOutbound, outboundJob, pendingOutbound, receiveOutbound } from "../services/dsp7-outbound.js";
const uuid=z.string().uuid();
const machine=z.object({seat_id:uuid,machine_id:uuid,machine_fingerprint:z.string().regex(/^[a-f0-9]{64}$/)});
const localPath=z.string().regex(/^(?:\/|[A-Za-z]:[\\/])/).max(2048).refine(s=>!/[\r\n\0]/.test(s));
export const quickProfileSchema=z.object({harnessRoot:localPath,bridgeRoot:localPath,claudeCommand:localPath,settingsFile:localPath.nullable(),name:z.string().trim().min(1).max(100)}).strict();
const resultSchema=z.object({exitCode:z.number().int().nullable(),signal:z.string().max(50).nullable(),timedOut:z.boolean(),summary:z.string().max(10000).optional(),errorMessage:z.string().max(2000).optional(),usage:z.object({inputTokens:z.number().int().nonnegative(),outputTokens:z.number().int().nonnegative(),cachedInputTokens:z.number().int().nonnegative().optional()}).optional(),model:z.string().max(100).optional(),usageBasis:z.literal("per_run").optional(),billingType:z.literal("unknown").optional(),costUsd:z.null().optional(),sessionId:uuid.optional()}).strict();
export function dsp7QuickSeatRoutes(db:Db) {
 const router=Router();const access=accessService(db);
 async function own(req:Request) {
  const parsed=machine.safeParse(req.body);
  if(!parsed.success)throw badRequest("本机身份无效");
  if(req.actor.type!=="agent"||req.actor.source!=="agent_key"||(req.actor.keyScope&&req.actor.keyScope.kind!=="standard")||req.actor.agentId!==String(req.params.id))throw forbidden("需要本机独立凭证");
  assertCompanyAccess(req,req.actor.companyId!);
  const[agent]=await db.select().from(agents).where(and(eq(agents.id,String(req.params.id)),eq(agents.companyId,req.actor.companyId!)));
  const seat=agent?.adapterConfig.dsp7Seat as Record<string,unknown>|undefined;
  if(!agent||agent.adapterConfig.dsp7Transport!=="outbound"||!seat||seat.machineId!==parsed.data.machine_id||seat.machineFingerprint!==parsed.data.machine_fingerprint||parsed.data.seat_id!==agent.id||["paused","terminated","pending_approval"].includes(agent.status))throw forbidden("席位不可用或本机身份不一致");
  return agent;
 }
 router.post("/companies/:companyId/dsp7-quick-enrollments",async(req,res)=>{
  assertBoard(req);const companyId=String(req.params.companyId);assertCompanyAccess(req,companyId);
  if(!req.actor.userId)throw forbidden("请使用本人网站账号登录");
  const decision=await access.decide({actor:req.actor,action:"agents:create",resource:{type:"company",companyId}});
  if(!decision.allowed)throw forbidden("组织尚未授权此账号创建执行席位，请管理员授予 agents:create 权限");
  const[company]=await db.select().from(companies).where(eq(companies.id,companyId));
  if(!company||company.requireBoardApprovalForNewAgents)throw conflict("组织要求新智能体审批，请管理员先按组织规则完成审批接入");
  const parsed=z.object({requestId:uuid,name:z.string().trim().min(1).max(100)}).strict().safeParse(req.body);if(!parsed.success)throw badRequest("席位名称无效");
  const token=randomBytes(32).toString("hex"),invitationId=parsed.data.requestId,expiresAt=new Date(Date.now()+15*60000).toISOString();
  await db.transaction(async tx=>{
   await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${companyId+":quick-enroll:"+req.actor.userId},0))`);
   const[existing]=await tx.select().from(activityLog).where(and(eq(activityLog.entityId,invitationId),eq(activityLog.action,"dsp7.quick.invited")));if(existing)throw conflict("邀请请求已提交；请重新生成命令，旧邀请不能重复签发");
   await tx.insert(activityLog).values({companyId,actorType:"user",actorId:req.actor.userId!,action:"dsp7.quick.invited",entityType:"dsp7_quick_enrollment",entityId:invitationId,details:{name:parsed.data.name,userId:req.actor.userId,tokenHash:createHash("sha256").update(token).digest("hex"),expiresAt,instanceAdmin:req.actor.isInstanceAdmin===true}});
  });
  res.setHeader("Cache-Control","no-store");res.status(201).json({invitationId,token,expiresAt});
 });
 router.post("/dsp7-quick-enroll",async(req,res)=>{
  const parsed=z.object({invitationId:uuid,token:z.string().regex(/^[a-f0-9]{64}$/),machine_id:uuid,machine_fingerprint:machine.shape.machine_fingerprint,profile:quickProfileSchema}).strict().safeParse(req.body);if(!parsed.success)throw badRequest("本机接入信息无效");const body=parsed.data;
  const result=await db.transaction(async tx=>{
   const[invite]=await tx.select().from(activityLog).where(and(eq(activityLog.entityType,"dsp7_quick_enrollment"),eq(activityLog.entityId,body.invitationId),eq(activityLog.action,"dsp7.quick.invited"))).limit(1);const data=invite?.details;
   if(!invite||!data||data.tokenHash!==createHash("sha256").update(body.token).digest("hex")||Date.parse(String(data.expiresAt))<=Date.now())throw forbidden("邀请无效或过期，请从网页重新生成");
   await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${invite.companyId+":quick-enroll"},0))`);
   const[used]=await tx.select().from(activityLog).where(and(eq(activityLog.entityId,body.invitationId),eq(activityLog.action,"dsp7.quick.completed")));if(used)throw conflict("邀请已消费，请复用本机现有配置");
   const userId=String(data.userId);
   const [admin]=await tx.select().from(instanceUserRoles).where(and(eq(instanceUserRoles.userId,userId),eq(instanceUserRoles.role,"instance_admin")));
   const memberships=await tx.select().from(companyMemberships).where(and(eq(companyMemberships.companyId,invite.companyId),eq(companyMemberships.principalType,"user"),eq(companyMemberships.principalId,userId),eq(companyMemberships.status,"active")));
   if(!admin&&!memberships.length)throw forbidden("接入授权用户已失去组织访问权限");
   const currentPermission=await accessService(tx as unknown as Db).decide({actor:{type:"board",source:"session",userId,isInstanceAdmin:!!admin,companyIds:memberships.map(m=>m.companyId),memberships},action:"agents:create",resource:{type:"company",companyId:invite.companyId}});
   if(!currentPermission.allowed)throw forbidden("创建执行席位的授权已失效，请管理员核对");
   const[company]=await tx.select().from(companies).where(eq(companies.id,invite.companyId));if(!company||company.requireBoardApprovalForNewAgents)throw conflict("组织审批规则已变化，请管理员核对");
   const peers=await tx.select().from(agents).where(eq(agents.companyId,invite.companyId));if(peers.some(p=>(p.adapterConfig.dsp7Seat as Record<string,unknown>|undefined)?.machineFingerprint===body.machine_fingerprint))throw conflict("此电脑已有席位，请使用原席位，不复制或重复创建");
   const[environment]=await tx.select().from(environments).where(and(eq(environments.driver,"local"),eq(environments.status,"active")));if(!environment)throw conflict("服务器缺少可用控制环境，请管理员检查");
   const[agent]=await tx.insert(agents).values({companyId:invite.companyId,name:String(data.name),role:"engineer",adapterType:"claude_local",defaultEnvironmentId:environment.id,adapterConfig:{engine:"cli",command:"claude",dsp7Transport:"outbound",dsp7WebJiraIntake:true,dsp7Seat:{machineId:body.machine_id,machineFingerprint:body.machine_fingerprint,name:String(data.name),intakeUserIds:[String(data.userId)]}},runtimeConfig:{heartbeat:{intervalEnabled:false,wakeOnDemand:true,maxConcurrentRuns:1}}}).returning();
   const token="pcp_"+randomBytes(32).toString("hex");await tx.insert(agentApiKeys).values({companyId:agent.companyId,agentId:agent.id,name:"DSP7 outbound personal seat",responsibleUserId:String(data.userId),keyHash:createHash("sha256").update(token).digest("hex"),scopeConfig:null});
   await tx.insert(activityLog).values({companyId:agent.companyId,actorType:"system",actorId:"quick-seat-enrollment",agentId:agent.id,action:"dsp7.quick.completed",entityType:"dsp7_quick_enrollment",entityId:body.invitationId,details:{agentId:agent.id,machineId:body.machine_id,ownerUserId:data.userId,profile:body.profile}});
   return {agentId:agent.id,companyId:agent.companyId,token,environmentId:environment.id,intakeUserIds:[String(data.userId)],name:agent.name};
  });res.setHeader("Cache-Control","no-store");res.status(201).json(result);
 });
 router.post("/agents/:id/dsp7-outbound-poll",async(req,res)=>{
  const agent=await own(req);const job=pendingOutbound(agent.id);res.setHeader("Cache-Control","no-store");
  if(!job){res.json({job:null});return;}
  const runtime=agent.adapterConfig.dsp7SeatRuntime as {revision?:number}|undefined;
  if(!runtime||req.body.revision!==runtime.revision)throw conflict("登记版本已变化，不能领取运行");
  const[run]=await db.select().from(heartbeatRuns).where(and(eq(heartbeatRuns.id,job.ctx.runId),eq(heartbeatRuns.companyId,agent.companyId),eq(heartbeatRuns.agentId,agent.id),eq(heartbeatRuns.status,"running")));
  if(!run){res.json({job:null});return;}
  const packet=await claimOutbound(job);
  await db.insert(activityLog).values({companyId:agent.companyId,actorType:"agent",actorId:agent.id,agentId:agent.id,action:"dsp7.outbound.claimed",entityType:"heartbeat_run",entityId:run.id,details:{machineId:req.body.machine_id,revision:runtime.revision}});
  res.json({job:packet});
 });
 router.post("/agents/:id/dsp7-outbound-runs/:runId",async(req,res)=>{
  const agent=await own(req);const parsed=z.object({lease:uuid,sequence:z.number().int().nonnegative(),stream:z.enum(["stdout","stderr"]).optional(),chunk:z.string().max(65536).optional(),result:resultSchema.optional()}).safeParse(req.body);if(!parsed.success)throw badRequest("执行回执无效");
  const runId=String(req.params.runId);const job=outboundJob(runId);
  const[run]=await db.select().from(heartbeatRuns).where(and(eq(heartbeatRuns.id,runId),eq(heartbeatRuns.agentId,agent.id),eq(heartbeatRuns.companyId,agent.companyId)));
  if(!job||!run||job.ctx.agent.id!==agent.id||job.lease!==parsed.data.lease||run.status!=="running"||job.ctx.signal?.aborted){res.json({alive:false,status:run?.status??"unavailable"});return;}
  await receiveOutbound(job,parsed.data);res.json({alive:true,sequence:job.sequence});
 });
 return router;
}
