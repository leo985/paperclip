/** Small company-scoped, versioned notification registry. Secrets stay in the encrypted vault. */
import { Router } from "express";
import { createHash, randomUUID } from "node:crypto";
import { and, desc, eq, sql } from "drizzle-orm";
import { activityLog, agents, companies, issues, personnelPeople, personnelSources, type Db } from "@paperclipai/db";
import { z } from "zod";
import { assertBoard, assertCompanyAccess } from "./authz.js";
import { badRequest, forbidden, notFound } from "../errors.js";
import { secretService } from "../services/secrets.js";
import { dispatchAuthorization } from "./dsp7-jira-dispatch.js";
type Bot = {id:string;name:string;corpId:string;appKey:string;robotCode:string;enabled:boolean;secretId:string};
const schema=z.object({name:z.string().trim().min(1).max(100),corpId:z.string().regex(/^[A-Za-z0-9_-]{1,100}$/),appKey:z.string().regex(/^[A-Za-z0-9_-]{1,200}$/),robotCode:z.string().regex(/^[A-Za-z0-9_-]{1,200}$/),enabled:z.boolean(),credentials:z.object({appSecret:z.string().min(1).max(1000)}).strict().optional()}).strict();
async function bots(db:Pick<Db,"select">,companyId:string):Promise<Bot[]> {
 const rows=await db.select().from(activityLog).where(and(eq(activityLog.companyId,companyId),eq(activityLog.action,"dsp7.notification.bot.saved"))).orderBy(desc(activityLog.createdAt),desc(activityLog.id));
 const found=new Map<string,Bot>();for(const r of rows)if(!found.has(r.entityId))found.set(r.entityId,r.details as Bot);return [...found.values()];
}
const publicBot=({secretId,...bot}:Bot)=>({...bot,secretConfigured:Boolean(secretId)});
export async function validateSeatBotTarget(db:Db,companyId:string,target:{botId?:string;userId:string}) {
 const bot=(await bots(db,companyId)).find(b=>b.id===target.botId&&b.enabled);if(!bot)throw badRequest("机器人不存在或已停用，请重新选择");
 const [person]=await db.select({id:personnelPeople.id}).from(personnelPeople).innerJoin(personnelSources,eq(personnelSources.id,personnelPeople.sourceId)).where(and(eq(personnelPeople.companyId,companyId),eq(personnelPeople.externalId,target.userId),eq(personnelPeople.active,true),eq(personnelSources.companyId,companyId),eq(personnelSources.type,"DingTalk"),eq(personnelSources.corpId,bot.corpId),eq(personnelSources.enabled,true))).limit(1);
 if(!person)throw badRequest("接收人必须来自机器人所属企业的有效钉钉通讯录");return bot;
}
export function seatBotRoutes(db:Db){
 const r=Router();
 r.get('/companies/:companyId/dsp7-notification-bots',async(req,res)=>{assertBoard(req);const companyId=String(req.params.companyId);assertCompanyAccess(req,companyId);res.json((await bots(db,companyId)).map(publicBot));});
 for(const path of ['/companies/:companyId/dsp7-notification-bots','/companies/:companyId/dsp7-notification-bots/:botId'])r.post(path,async(req,res)=>{
  assertBoard(req);const companyId=String(req.params.companyId);assertCompanyAccess(req,companyId);
  if(!req.actor.isInstanceAdmin&&req.actor.source!=="local_implicit"&&!req.actor.memberships?.some(m=>m.companyId===companyId&&m.status==='active'&&['owner','admin'].includes(m.membershipRole??'')))throw forbidden("登记机器人需要组织管理员权限");
  const parsed=schema.safeParse(req.body);if(!parsed.success)throw badRequest("机器人资料无效");
  const id=req.params.botId?String(req.params.botId):randomUUID();if(!z.string().uuid().safeParse(id).success)throw badRequest("机器人标识无效");
  const result=await db.transaction(async tx=>{await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${companyId+":notification-bots"},0))`);
   const old=(await bots(tx,companyId)).find(b=>b.id===id);if(req.params.botId&&!old)throw notFound("机器人不存在");
   const {credentials,...fields}=parsed.data;const appSecret=credentials?.appSecret;let secretId=old?.secretId;
   if(old&&old.appKey!==fields.appKey&&!appSecret)throw badRequest("更换 AppKey 时需要重新填写 AppSecret");
   const svc=secretService(tx);if(appSecret){if(secretId)await svc.rotate(secretId,{value:appSecret},{userId:req.actor.userId});else secretId=(await svc.create(companyId,{name:"钉钉通知机器人 "+id,provider:"local_encrypted",value:appSecret},{userId:req.actor.userId})).id;}
   if(!secretId)throw badRequest("新增机器人需要 AppSecret");const bot={id,...fields,secretId};
   await tx.insert(activityLog).values({companyId,actorType:"user",actorId:req.actor.userId??"local-board",action:"dsp7.notification.bot.saved",entityType:"dsp7_notification_bot",entityId:id,details:bot});return publicBot(bot);
  });res.json(result);
 });
 r.get('/companies/:companyId/dsp7-seats/:id/notification-deliveries',async(req,res)=>{
  assertBoard(req);const companyId=String(req.params.companyId);assertCompanyAccess(req,companyId);
  const [agent]=await db.select().from(agents).where(and(eq(agents.companyId,companyId),eq(agents.id,String(req.params.id))));const seat=agent?.adapterConfig.dsp7Seat as {intakeUserIds?:string[]}|undefined;
  if(!seat)throw notFound("席位不存在");if(!req.actor.isInstanceAdmin&&req.actor.source!=="local_implicit"&&!seat.intakeUserIds?.includes(req.actor.userId!))throw forbidden("未获席位授权");
  const rows=await db.select().from(activityLog).where(and(eq(activityLog.companyId,companyId),eq(activityLog.agentId,agent.id),eq(activityLog.action,"dsp7.notification.delivery"))).orderBy(desc(activityLog.createdAt)).limit(10);
  const latest=new Map<string,typeof rows[number]>();for(const row of rows)if(!latest.has(row.entityId))latest.set(row.entityId,row);
  res.json([...latest.values()].map(row=>({createdAt:row.createdAt.toISOString(),status:row.details?.status,code:row.details?.code})));
 });return r;
}
export async function notifySeatBot(db:Db,agent:typeof agents.$inferSelect,policy:{jiraKeys:string[];reminderMinutes:number;escalationMinutes:number;dingtalk?:{botId?:string;userId:string}|null},alerts:Array<{id:string;taskId:string|null;message:string;elapsedMinutes:number;level:string}>) {
 const target=policy.dingtalk;if(!target?.botId)return;
 // One bounded delivery per heartbeat. Each bucket is reserved before network I/O.
 for(const alert of alerts){
  if(!alert.taskId)continue;
  const [task]=await db.select().from(issues).where(and(eq(issues.id,alert.taskId),eq(issues.companyId,agent.companyId),eq(issues.assigneeAgentId,agent.id),sql`${issues.status} not in ('done','cancelled')`));
  if(!task)continue;
  const jiraKey=task.description?.match(/DSP7-PILOT:([A-Z][A-Z0-9_]*-\d+)/)?.[1];
  if(!jiraKey)continue;
  if(!policy.jiraKeys.includes(jiraKey))try{await dispatchAuthorization(db,agent,task);}catch{continue;}
  const level=alert.elapsedMinutes>=policy.escalationMinutes?"urgent":"warning";
  const key=createHash('sha256').update([agent.id,target.botId,target.userId,alert.id,level,Math.floor(alert.elapsedMinutes/policy.reminderMinutes)].join(':')).digest('hex');
  const reserved=await db.transaction(async tx=>{await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${key},0))`);const [old]=await tx.select({id:activityLog.id}).from(activityLog).where(and(eq(activityLog.companyId,agent.companyId),eq(activityLog.entityType,"dsp7_notification_delivery"),eq(activityLog.entityId,key))).limit(1);if(old)return false;await tx.insert(activityLog).values({companyId:agent.companyId,actorType:"system",actorId:"notification-bot",agentId:agent.id,action:"dsp7.notification.delivery",entityType:"dsp7_notification_delivery",entityId:key,details:{status:"sending",botId:target.botId,taskId:alert.taskId}});return true;});
  if(!reserved)continue;
  let status="unknown",code="NETWORK_OR_RESPONSE_UNKNOWN";
  try {
   const bot=await validateSeatBotTarget(db,agent.companyId,target);const secret=await secretService(db).resolveSecretValue(agent.companyId,bot.secretId,"latest");
   const tokenResponse=await fetch('https://api.dingtalk.com/v1.0/oauth2/accessToken',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({appKey:bot.appKey,appSecret:secret}),redirect:'error',signal:AbortSignal.timeout(10000)});
   const token=await tokenResponse.json() as {accessToken?:string;code?:string};if(!tokenResponse.ok||!token.accessToken){status="failed";code="TOKEN_REJECTED";}
   else {
    const [company]=await db.select({prefix:companies.issuePrefix}).from(companies).where(eq(companies.id,agent.companyId));
    const base=(process.env.PAPERCLIP_PUBLIC_URL||process.env.PAPERCLIP_AUTH_PUBLIC_BASE_URL||process.env.BETTER_AUTH_URL||"").replace(/\/$/,"");
    const link=base&&company?base+"/"+encodeURIComponent(company.prefix)+"/issues/"+alert.taskId:"";
    const message=(level==='urgent'?'【超时升级】':'【待处理】')+alert.message+(link?"\n"+link:"\n请进入智研协同平台处理任务。");
    const response=await fetch('https://api.dingtalk.com/v1.0/robot/oToMessages/batchSend',{method:'POST',headers:{'Content-Type':'application/json','x-acs-dingtalk-access-token':token.accessToken},body:JSON.stringify({robotCode:bot.robotCode,userIds:[target.userId],msgKey:'sampleText',msgParam:JSON.stringify({content:message})}),redirect:'error',signal:AbortSignal.timeout(10000)});
    const result=await response.json() as {processQueryKey?:string;code?:string;invalidStaffIdList?:string[];flowControlledStaffIdList?:string[]};
    if(response.ok&&result.processQueryKey&&!result.invalidStaffIdList?.length&&!result.flowControlledStaffIdList?.length){status='submitted';code='ACCEPTED_NOT_READ';}else {status='failed';code=response.ok?'RECIPIENT_REJECTED':'SEND_HTTP_'+response.status;}
   }
  }catch(e){if(e instanceof Error&&'status' in e){status='failed';code='CONFIGURATION_INVALID';}}
  await db.insert(activityLog).values({companyId:agent.companyId,actorType:"system",actorId:"notification-bot",agentId:agent.id,action:"dsp7.notification.delivery",entityType:"dsp7_notification_delivery",entityId:key,details:{status,code,botId:target.botId,taskId:alert.taskId}});
  break;
 }
}
