import { deliveryWaitScope } from "../services/delivery-workflows.js";
import { analysisWaitScope } from "../services/analysis-executions.js";
import { isCurrentSeatWait, seatNotificationAttempts, sendSeatDing } from "../services/seat-notification-escalation.js";
import { canConfigureSeat } from "./dsp7-seat-owners.js";
import type { SeatDingtalkTarget } from "@paperclipai/shared";
import { resolveSeatGroupOwner, seatNotificationGroups, sendSeatGroupMessage } from "../services/seat-group-notifications.js";
/** Small company-scoped, versioned notification registry. Secrets stay in the encrypted vault. */
import { Router } from "express";
import { randomUUID } from "node:crypto";
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
export const seatNotificationBots = bots;
const publicBot=({secretId,...bot}:Bot)=>({...bot,secretConfigured:Boolean(secretId)});
export async function validateSeatBotTarget(db:Db,companyId:string,target:{botId?:string;userId:string}) {
 const bot=(await bots(db,companyId)).find(b=>b.id===target.botId&&b.enabled);if(!bot)throw badRequest("机器人不存在或已停用，请重新选择");
 const [person]=await db.select({id:personnelPeople.id}).from(personnelPeople).innerJoin(personnelSources,eq(personnelSources.id,personnelPeople.sourceId)).where(and(eq(personnelPeople.externalId,target.userId),eq(personnelPeople.active,true),eq(personnelSources.type,"DingTalk"),eq(personnelSources.corpId,bot.corpId),eq(personnelSources.enabled,true))).limit(1);
 if(!person)throw badRequest("接收人必须来自机器人所属企业的有效钉钉通讯录");return bot;
}
export async function validateSeatGroupTarget(db:Db,agent:typeof agents.$inferSelect,target:SeatDingtalkTarget,bot:Bot) {
 const group=(await seatNotificationGroups(db,agent.companyId)).find(group=>group.id===target.groupId&&group.botId===bot.id&&group.corpId===bot.corpId&&group.enabled);
 if(!group)throw badRequest("通知群不存在、已停用或不属于所选机器人");
 const owner=await resolveSeatGroupOwner(db,agent,bot.corpId);
 return {group,owner};
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
  if(!seat)throw notFound("席位不存在");if(!canConfigureSeat(req,companyId,seat))throw forbidden("未获席位授权");
  const rows=await db.select().from(activityLog).where(and(eq(activityLog.companyId,companyId),eq(activityLog.agentId,agent.id),eq(activityLog.action,"dsp7.notification.delivery"))).orderBy(desc(activityLog.createdAt)).limit(10);
  const latest=new Map<string,typeof rows[number]>();for(const row of rows)if(!latest.has(row.entityId))latest.set(row.entityId,row);
  res.json([...latest.values()].map(row=>({createdAt:row.createdAt.toISOString(),status:row.details?.status,code:row.details?.code,channel:row.details?.channel??"message",groupId:row.details?.groupId,groupName:row.details?.groupName,mentionedUserId:row.details?.mentionedUserId,openDingId:row.details?.openDingId})));
 });return r;
}
export async function notifySeatBot(db:Db,agent:typeof agents.$inferSelect,policy:{jiraKeys:string[];reminderMinutes:number;escalationMinutes:number;dingtalk?:SeatDingtalkTarget|null},alerts:Array<{id:string;taskId:string|null;message:string;elapsedMinutes:number;level:string}>) {
 const target=policy.dingtalk;if(!target?.botId)return;
 // At most one alert per heartbeat; configured channels fan out independently.
 // Every channel/bucket is reserved before network I/O, including unknown outcomes.
 for(const alert of alerts){
  if(!alert.taskId)continue;
  const [task]=await db.select().from(issues).where(and(eq(issues.id,alert.taskId),eq(issues.companyId,agent.companyId),sql`${issues.status} not in ('done','cancelled')`));
  if(!task)continue;
  const jiraKey=task.description?.match(/DSP7-PILOT:([A-Z][A-Z0-9_]*-\d+)/)?.[1];
  const analysis = !jiraKey ? await analysisWaitScope(db,agent.companyId,agent.id,task.id,alert.id) : null;
  const delivery=!jiraKey&&!analysis?await deliveryWaitScope(db,agent.companyId,agent.id,task.id,alert.id):null;
  if(!jiraKey&&!analysis&&!delivery)continue;
  if(task.assigneeAgentId!==agent.id&&!(delivery?.stage.executionMode==="human"&&task.assigneeUserId===delivery.stage.reviewerUserId))continue;
  if(jiraKey&&!policy.jiraKeys.includes(jiraKey))try{await dispatchAuthorization(db,agent,task);}catch{continue;}
  let delivered=false;
  for (const {channel,key,level} of seatNotificationAttempts(agent.id,target,policy,alert)) {
  const reserved=await db.transaction(async tx=>{await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${key},0))`);const [old]=await tx.select({id:activityLog.id}).from(activityLog).where(and(eq(activityLog.companyId,agent.companyId),eq(activityLog.entityType,"dsp7_notification_delivery"),eq(activityLog.entityId,key))).limit(1);if(old)return false;await tx.insert(activityLog).values({companyId:agent.companyId,actorType:"system",actorId:"notification-bot",agentId:agent.id,action:"dsp7.notification.delivery",entityType:"dsp7_notification_delivery",entityId:key,details:{status:"sending",channel,alertId:alert.id,botId:target.botId,taskId:alert.taskId}});return true;});
  if(!reserved)continue;
  let status="unknown",code="NETWORK_OR_RESPONSE_UNKNOWN",openDingId:string|undefined;
  let groupName:string|undefined,mentionedUserId:string|undefined;
  try {
   const bot=await validateSeatBotTarget(db,agent.companyId,target);
   if(channel==='group') {
    const [current]=await db.select().from(agents).where(and(eq(agents.id,agent.id),eq(agents.companyId,agent.companyId)));
    const [pending]=await db.select({id:issues.id}).from(issues).where(and(eq(issues.id,alert.taskId),eq(issues.companyId,agent.companyId),(task.assigneeAgentId===agent.id?eq(issues.assigneeAgentId,agent.id):eq(issues.assigneeUserId,task.assigneeUserId!)),sql`${issues.status} not in ('done','cancelled')`));
    const currentTarget=(current?.adapterConfig.dsp7SeatPolicy as {dingtalk?:SeatDingtalkTarget}|undefined)?.dingtalk;
    const stillWaiting=analysis?await analysisWaitScope(db,agent.companyId,agent.id,task.id,alert.id):delivery?await deliveryWaitScope(db,agent.companyId,agent.id,task.id,alert.id):isCurrentSeatWait(current?.adapterConfig.dsp7SeatPresence,alert,0);
    if(!current||!pending||currentTarget?.groupId!==target.groupId||currentTarget?.botId!==target.botId||!stillWaiting) {status='skipped';code='WAIT_RESOLVED_OR_CONFIGURATION_CHANGED';}
    else {
     const {group,owner}=await validateSeatGroupTarget(db,current,target,bot);groupName=group.name;mentionedUserId=owner.externalId;
     const credentials=JSON.parse(await secretService(db).resolveSecretValue(agent.companyId,group.secretId,"latest"));
     const [company]=await db.select({prefix:companies.issuePrefix}).from(companies).where(eq(companies.id,agent.companyId));
     const base=(process.env.PAPERCLIP_PUBLIC_URL||process.env.PAPERCLIP_AUTH_PUBLIC_BASE_URL||process.env.BETTER_AUTH_URL||'').replace(/\/$/,'');
     const link=base&&company?base+'/'+encodeURIComponent(company.prefix)+(delivery?'/delivery?snapshotId='+delivery.flow.snapshotId:(analysis?'/analysis-executions?executionId=':'/issues/')+alert.taskId):'';
     const result=await sendSeatGroupMessage(credentials,owner,'智研协同平台 · '+agent.name+'\n'+(level==='urgent'?'【超时升级】':'【待处理】')+alert.message+(link?'\n'+link:'\n请进入智研协同平台处理任务。'));
     status=result.status;code=result.code;
    }
   } else {
   const secret=await secretService(db).resolveSecretValue(agent.companyId,bot.secretId,"latest");
   const tokenResponse=await fetch('https://api.dingtalk.com/v1.0/oauth2/accessToken',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({appKey:bot.appKey,appSecret:secret}),redirect:'error',signal:AbortSignal.timeout(10000)});
   const token=await tokenResponse.json() as {accessToken?:string;code?:string};if(!tokenResponse.ok||!token.accessToken){status="failed";code="TOKEN_REJECTED";}
   else {
    const [company]=await db.select({prefix:companies.issuePrefix}).from(companies).where(eq(companies.id,agent.companyId));
    const base=(process.env.PAPERCLIP_PUBLIC_URL||process.env.PAPERCLIP_AUTH_PUBLIC_BASE_URL||process.env.BETTER_AUTH_URL||"").replace(/\/$/,"");
    const link=base&&company?base+"/"+encodeURIComponent(company.prefix)+(delivery?"/delivery?snapshotId="+delivery.flow.snapshotId:(analysis?"/analysis-executions?executionId=":"/issues/")+alert.taskId):"";
    const message=(level==='urgent'?'【超时升级】':'【待处理】')+alert.message+(link?"\n"+link:"\n请进入智研协同平台处理任务。");
    if(channel==='ding') {
     // A decision may have been resolved while acquiring the token. Re-read
     // current ownership, task state and fresh heartbeat immediately before DING.
     const [current]=await db.select({config:agents.adapterConfig}).from(agents).where(and(eq(agents.id,agent.id),eq(agents.companyId,agent.companyId)));
     const [pending]=await db.select({id:issues.id}).from(issues).where(and(eq(issues.id,alert.taskId),eq(issues.companyId,agent.companyId),(task.assigneeAgentId===agent.id?eq(issues.assigneeAgentId,agent.id):eq(issues.assigneeUserId,task.assigneeUserId!)),sql`${issues.status} not in ('done','cancelled')`));
     if(!pending||!isCurrentSeatWait(current?.config.dsp7SeatPresence,alert,policy.escalationMinutes)||(analysis&&!await analysisWaitScope(db,agent.companyId,agent.id,task.id,alert.id))||(delivery&&!await deliveryWaitScope(db,agent.companyId,agent.id,task.id,alert.id))) {status='skipped';code='WAIT_RESOLVED_OR_SEAT_OFFLINE';}
     else {const result=await sendSeatDing(token.accessToken,bot.robotCode,target.userId,message);status=result.status;code=result.code;openDingId=result.openDingId;}
    } else {
    const response=await fetch('https://api.dingtalk.com/v1.0/robot/oToMessages/batchSend',{method:'POST',headers:{'Content-Type':'application/json','x-acs-dingtalk-access-token':token.accessToken},body:JSON.stringify({robotCode:bot.robotCode,userIds:[target.userId],msgKey:'sampleText',msgParam:JSON.stringify({content:message})}),redirect:'error',signal:AbortSignal.timeout(10000)});
    const result=await response.json() as {processQueryKey?:string;code?:string;invalidStaffIdList?:string[];flowControlledStaffIdList?:string[]};
    if(response.ok&&result.processQueryKey&&!result.invalidStaffIdList?.length&&!result.flowControlledStaffIdList?.length){status='submitted';code='ACCEPTED_NOT_READ';}else {status='failed';code=response.ok?'RECIPIENT_REJECTED':'SEND_HTTP_'+response.status;}
    }
   }
   }
  }catch(e){if(e instanceof Error&&'status' in e){status='failed';code='CONFIGURATION_INVALID';}}
  await db.insert(activityLog).values({companyId:agent.companyId,actorType:"system",actorId:"notification-bot",agentId:agent.id,action:"dsp7.notification.delivery",entityType:"dsp7_notification_delivery",entityId:key,details:{status,code,channel,alertId:alert.id,...(openDingId?{openDingId}:{}),...(channel==='group'?{groupId:target.groupId,groupName,mentionedUserId}:{}),botId:target.botId,taskId:alert.taskId}});
  delivered=true;
  if(!target.groupId)return;
  }
  if(delivered)return;
 }
}
