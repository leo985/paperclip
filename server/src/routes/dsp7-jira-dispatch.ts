import { Router, type Request } from "express";
import { and, eq, sql } from "drizzle-orm";
import { activityLog, agents, issues, projects, projectWorkspaces, type Db } from "@paperclipai/db";
import { z } from "zod";
import { badRequest, conflict, forbidden } from "../errors.js";
import { secretService } from "../services/secrets.js";
import { issueService } from "../services/issues.js";

const word=z.string().trim().min(1).max(100).refine(v=>!/[\r\n\0]/.test(v));
export const jiraDispatchSchema=z.object({enabled:z.boolean(),intakePaused:z.boolean().optional().default(false),jiraAssignee:word,jiraProjectKey:z.string().regex(/^[A-Z][A-Z0-9_]*$/),projectId:z.string().uuid(),workspaceId:z.string().uuid(),readyStatuses:z.array(word).min(1).max(20),jiraBaseUrl:z.string().url().max(2048).refine(v=>{try{const u=new URL(v);return ["http:","https:"].includes(u.protocol)&&!u.username&&!u.password&&!u.search&&!u.hash;}catch{return false;}}),issueTypes:z.array(z.enum(["编码","前端编码","功能","内部缺陷","线上问题","系统设计","系统设计补充"])).min(1).max(7)}).strict();
type Agent=typeof agents.$inferSelect;
type Rule=z.infer<typeof jiraDispatchSchema>&{revision:number;ownerUserId:string;jiraSecretId?:string};
export function dispatchRule(agent:Agent):Rule|null {return agent.adapterConfig.dsp7JiraDispatch as Rule??null;}
export function publicRule(agent:Agent) {
 const rule=dispatchRule(agent);if(!rule)return null;
 const {jiraSecretId,...fields}=rule;return {...fields,jiraPatConfigured:!!jiraSecretId};
}
export async function dispatchAuthorization(db:Db,agent:Agent,task:typeof issues.$inferSelect) {
 const rule=dispatchRule(agent);
 if(!rule?.enabled||task.createdByAgentId!==agent.id||task.createdByUserId)throw forbidden("自动接入授权已失效");
 const [record]=await db.select().from(activityLog).where(and(eq(activityLog.companyId,agent.companyId),eq(activityLog.agentId,agent.id),eq(activityLog.action,"dsp7.jira.discovered"),eq(activityLog.entityId,task.id))).limit(1);
 const raw=task.description?.match(/<!-- DSP7-JIRA-INTAKE (.*?) -->/)?.[1];
 if(!record||record.details?.request!==raw||record.details?.ownerUserId!==rule.ownerUserId)throw forbidden("自动接入申请或调度规则已变化");
 let intake;try{intake=JSON.parse(raw??"");}catch{throw forbidden("自动申请无效");}
 if(record.details?.assignee!==rule.jiraAssignee||!rule.issueTypes.includes(record.details?.issueType as Rule["issueTypes"][number])||!String(record.details?.jiraKey).startsWith(rule.jiraProjectKey+"-"))throw forbidden("Jira 经办人、项目或类型不再符合当前规则");
 if(intake.project_id!==rule.projectId||intake.workspace_id!==rule.workspaceId||!rule.readyStatuses.includes(intake.ready_status))throw forbidden("工单不再符合当前调度规则");
 return rule;
}
export function dsp7JiraDispatchRoutes(db:Db,own:(req:Request)=>Promise<Agent>,board:(req:Request)=>Promise<Agent>) {
 const router=Router();
 router.get("/companies/:companyId/dsp7-seats/:id/jira-dispatch",async(req,res)=>res.json(publicRule(await board(req))));
 router.post("/companies/:companyId/dsp7-seats/:id/jira-dispatch/intake",async(req,res)=>{
  const agent=await board(req);const parsed=z.object({paused:z.boolean()}).strict().safeParse(req.body);
  if(!parsed.success)throw badRequest("接单状态无效");
  const result=await db.transaction(async tx=>{
   const [current]=await tx.select().from(agents).where(eq(agents.id,agent.id)).for("update");
   const rule=dispatchRule(current);if(!rule?.enabled)throw conflict("请先启用 Jira 自动接单规则");
   const next={...rule,intakePaused:parsed.data.paused,revision:rule.revision+1};
   await tx.update(agents).set({adapterConfig:{...current.adapterConfig,dsp7JiraDispatch:next},updatedAt:new Date()}).where(eq(agents.id,agent.id));
   await tx.insert(activityLog).values({companyId:agent.companyId,agentId:agent.id,actorType:"user",actorId:req.actor.userId!,action:"dsp7.jira.intake.changed",entityType:"agent",entityId:agent.id,details:{paused:next.intakePaused,revision:next.revision}});
   return {...current,adapterConfig:{...current.adapterConfig,dsp7JiraDispatch:next}};
  });res.json(publicRule(result));
 });
 router.post("/companies/:companyId/dsp7-seats/:id/jira-dispatch/preview",async(req,res)=>{
  const agent=await board(req);
  const parsed=jiraDispatchSchema.pick({jiraBaseUrl:true,jiraAssignee:true,jiraProjectKey:true,readyStatuses:true,issueTypes:true}).partial().extend({jiraBaseUrl:jiraDispatchSchema.shape.jiraBaseUrl,credentials:z.object({token:z.string().trim().min(1).max(4096).refine(v=>!/[\r\n\0]/.test(v))}).strict().optional()}).strict().safeParse(req.body);
  if(!parsed.success)throw badRequest("Jira 连接或查询范围无效");
  const data=parsed.data;const target=new URL(data.jiraBaseUrl);
  const allowed=(process.env.PAPERCLIP_JIRA_ALLOWED_ORIGINS??"http://jira.fingard.com:6001").split(",").map(v=>v.trim());
  if(!allowed.includes(target.origin))throw badRequest("此 Jira 地址尚未允许服务器预览，请管理员配置 PAPERCLIP_JIRA_ALLOWED_ORIGINS");
  const rule=dispatchRule(agent);
  if(!data.credentials&&(!rule?.jiraSecretId||new URL(rule.jiraBaseUrl).href!==target.href))throw badRequest("请填写当前 Jira 地址的 PAT 后验证连接");
  const token=data.credentials?.token??await secretService(db).resolveSecretValue(agent.companyId,rule!.jiraSecretId!,"latest",{accessContext:{consumerType:"agent",consumerId:agent.id,configPath:"dsp7JiraDispatch.jiraSecretId",responsibleUserId:req.actor.userId,actorType:"user",actorId:req.actor.userId!}});
  async function get(path:string){
   let reply:Response;try{reply=await fetch(target.href.replace(/\/$/,"")+path,{headers:{Authorization:"Bearer "+token,Accept:"application/json"},redirect:"error",signal:AbortSignal.timeout(10000)});}catch{throw badRequest("无法连接 Jira，请核对地址、网络和 PAT");}
   if(!reply.ok)throw badRequest(reply.status===401||reply.status===403?"Jira PAT 无效或没有查询权限":"Jira 查询失败（HTTP "+reply.status+"）");
   try{return await reply.json();}catch{throw badRequest("Jira 返回格式无效");}
  }
  const actor=await get("/rest/api/2/myself");const statuses=await get("/rest/api/2/status");
  const scopeComplete=!!(data.jiraAssignee&&data.jiraProjectKey&&data.readyStatuses?.length&&data.issueTypes?.length);
  let matches:{total:number;issues:Array<{key:string;summary:string;status:string}>}|null=null;
  if(scopeComplete){
   const quote=(v:string)=>JSON.stringify(v);
   const jql="project = "+quote(data.jiraProjectKey!)+" AND assignee = "+quote(data.jiraAssignee!)+" AND status in ("+data.readyStatuses!.map(quote).join(",")+") AND issuetype in ("+data.issueTypes!.map(quote).join(",")+") AND statusCategory != Done ORDER BY created ASC";
   const result=await get("/rest/api/2/search?"+new URLSearchParams({jql,maxResults:"10",fields:"summary,status"}));
   matches={total:Number(result.total??0),issues:(result.issues??[]).slice(0,10).map((i:{key:string;fields:{summary:string;status:{name:string}}})=>({key:i.key,summary:i.fields.summary,status:i.fields.status.name}))};
  }
  res.setHeader("Cache-Control","no-store");res.json({actorName:String(actor.displayName??actor.name??"Jira 用户"),statuses:Array.isArray(statuses)?statuses.map((s:{name:string})=>s.name):[],matches,verifiedAt:new Date().toISOString()});
 });
 router.post("/companies/:companyId/dsp7-seats/:id/jira-dispatch",async(req,res)=>{
  const agent=await board(req);const parsed=jiraDispatchSchema.extend({credentials:z.object({token:z.string().trim().min(1).max(4096).refine(v=>!/[\r\n\0]/.test(v))}).strict().optional()}).safeParse(req.body);if(!parsed.success)throw badRequest("请填写 Jira 经办人、项目、允许状态和工单类型");
  const {credentials,...data}=parsed.data;const [project]=await db.select().from(projects).where(and(eq(projects.id,data.projectId),eq(projects.companyId,agent.companyId)));
  const [workspace]=await db.select().from(projectWorkspaces).where(and(eq(projectWorkspaces.id,data.workspaceId),eq(projectWorkspaces.projectId,data.projectId)));
  if(!project||project.archivedAt||!workspace?.repoUrl||!(workspace.repoRef||workspace.defaultRef))throw conflict("请选择有仓库 URL 和基线分支的有效工作区");
  const users=(agent.adapterConfig.dsp7Seat as {intakeUserIds?:string[]}).intakeUserIds??[];
  const owner=users.includes(req.actor.userId??"")?req.actor.userId!:users[0];if(!owner)throw conflict("请先登记席位负责人的网站账号");
  const rule=await db.transaction(async tx=>{
   await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${agent.companyId+":jira-dispatch-rules"},0))`);
   const peers=await tx.select().from(agents).where(eq(agents.companyId,agent.companyId));
   if(data.enabled&&peers.some(p=>p.id!==agent.id&&dispatchRule(p)?.enabled&&dispatchRule(p)?.jiraAssignee===data.jiraAssignee&&dispatchRule(p)?.jiraProjectKey===data.jiraProjectKey))throw conflict("该 Jira 经办人和项目已有默认执行席位，请先停用原席位调度规则");
   const [current]=await tx.select().from(agents).where(eq(agents.id,agent.id)).for("update");
   let jiraSecretId=dispatchRule(current)?.jiraSecretId;
   if(!credentials&&jiraSecretId&&dispatchRule(current)?.jiraBaseUrl!==data.jiraBaseUrl)throw badRequest("更换 Jira 地址时请重新填写 PAT");
   if(credentials){
    const secrets=secretService(tx);
    if(jiraSecretId){await secrets.rotate(jiraSecretId,{value:credentials.token},{userId:req.actor.userId});}
    else {
     const existing=await secrets.getByName(agent.companyId,"DSP7 Jira PAT "+agent.id);
     if(existing){await secrets.rotate(existing.id,{value:credentials.token},{userId:req.actor.userId});jiraSecretId=existing.id;}
     else jiraSecretId=(await secrets.create(agent.companyId,{name:"DSP7 Jira PAT "+agent.id,provider:"local_encrypted",value:credentials.token},{userId:req.actor.userId})).id;
    }
   }
   if(data.enabled&&!jiraSecretId)throw badRequest("首次启用 Jira 自动接单，请填写 PAT；后续留空表示保留已有 PAT");
   const rule={...data,intakePaused:dispatchRule(current)?.intakePaused??false,jiraSecretId,revision:(dispatchRule(current)?.revision??0)+1,ownerUserId:owner};
   await tx.update(agents).set({adapterConfig:{...current.adapterConfig,dsp7JiraDispatch:rule}}).where(eq(agents.id,agent.id));
   await tx.insert(activityLog).values({companyId:agent.companyId,agentId:agent.id,actorType:"user",actorId:req.actor.userId!,action:"dsp7.jira.dispatch.configured",entityType:"agent",entityId:agent.id,details:rule});
   return rule;
  });const {jiraSecretId,...fields}=rule;res.json({...fields,jiraPatConfigured:!!jiraSecretId});
 });
 router.post("/agents/:id/dsp7-jira-dispatch",async(req,res)=>{
  const agent=await own(req);res.json({rule:publicRule(agent)});
 });
 router.post("/agents/:id/dsp7-jira-dispatch/credentials",async(req,res)=>{
  const agent=await own(req);const rule=dispatchRule(agent);
  res.setHeader("Cache-Control","no-store");
  if(!rule?.jiraSecretId||["paused","terminated","pending_approval"].includes(agent.status))throw forbidden("席位没有可用的 Jira PAT 配置");
  const token=await secretService(db).resolveSecretValue(agent.companyId,rule.jiraSecretId,"latest",{accessContext:{consumerType:"agent",consumerId:agent.id,configPath:"dsp7JiraDispatch.jiraSecretId",responsibleUserId:rule.ownerUserId,actorType:"agent",actorId:agent.id,actorSource:"agent_key"}});
  res.json({baseUrl:rule.jiraBaseUrl,token});
 });
 router.post("/agents/:id/dsp7-jira-dispatch/verify",async(req,res)=>{
  const agent=await own(req);const [task]=await db.select().from(issues).where(and(eq(issues.id,String(req.body.taskId)),eq(issues.companyId,agent.companyId)));
  if(!task)throw badRequest("任务不存在");const rule=await dispatchAuthorization(db,agent,task);if(req.body.start===true&&rule.intakePaused)throw conflict("席位已暂停接单，当前运行可继续");res.json({rule:publicRule(agent)});
 });
 router.post("/agents/:id/dsp7-jira-dispatch/discover",async(req,res)=>{
  const agent=await own(req);const rule=dispatchRule(agent);
  if(!rule?.enabled||rule.intakePaused||["paused","terminated","pending_approval"].includes(agent.status))throw forbidden("Jira 自动调度未启用");
  const parsed=z.object({revision:z.number().int(),jiraKey:z.string().regex(/^[A-Z][A-Z0-9_]*-\d+$/),assignee:word,status:word,issueType:word,summary:z.string().min(1).max(500)}).safeParse(req.body);if(!parsed.success)throw badRequest("Jira 工单信息无效");const data=parsed.data;
  if(data.revision!==rule.revision||data.assignee!==rule.jiraAssignee||!data.jiraKey.startsWith(rule.jiraProjectKey+"-")||!rule.readyStatuses.includes(data.status)||!rule.issueTypes.includes(data.issueType as Rule['issueTypes'][number]))throw forbidden("工单不符合已授权的 Jira 调度规则");
  const task=await db.transaction(async tx=>{
   await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${agent.companyId+":jira-discovery:"+data.jiraKey},0))`);
   const [fresh]=await tx.select().from(agents).where(eq(agents.id,agent.id)).for("update");
   const live=dispatchRule(fresh);if(!live?.enabled||live.intakePaused||live.revision!==rule.revision)throw conflict("调度状态已变化，请等待下一次查询");
   const old=await tx.select().from(activityLog).where(and(eq(activityLog.companyId,agent.companyId),eq(activityLog.action,"dsp7.jira.discovered"),sql`${activityLog.details}->>'jiraKey' = ${data.jiraKey}`));
   if(old.length){const [existing]=await tx.select().from(issues).where(eq(issues.id,old[0].entityId));if(!existing||existing.createdByAgentId!==agent.id)throw conflict("此 Jira 已进入其他席位队列，请核对执行归属");return existing;}
   const request=JSON.stringify({version:2,jira_key:data.jiraKey,project_id:rule.projectId,workspace_id:rule.workspaceId,seat_id:agent.id,ready_status:data.status});
   const created=await issueService(db).create(agent.companyId,{title:"Jira 接入申请："+data.jiraKey,description:"Jira 指派自动发现："+data.summary+"\n<!-- DSP7-JIRA-INTAKE "+request+" -->",projectId:rule.projectId,status:"backlog",createdByAgentId:agent.id,responsibleUserId:rule.ownerUserId},tx);
   await tx.insert(activityLog).values({companyId:agent.companyId,agentId:agent.id,actorType:"agent",actorId:agent.id,responsibleUserId:rule.ownerUserId,action:"dsp7.jira.discovered",entityType:"issue",entityId:created.id,details:{jiraKey:data.jiraKey,request,revision:rule.revision,ownerUserId:rule.ownerUserId,assignee:data.assignee,issueType:data.issueType}});
   return created;
  });res.json({taskId:task.id,status:task.status});
 });
 return router;
}
