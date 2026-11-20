import { startupRetryBlockedReason } from "../services/seat-startup-retry.js";
import { seatCanAcceptWork } from "@paperclipai/shared";
import { assertDeliveryCodingAdmission } from "../services/delivery-admission.js";
import { jiraRequirementRoutes } from "./jira-requirements.js";
import { canConfigureSeat, canCreateSeatIntake, isSeatManager, isSeatManagerUser } from "./dsp7-seat-owners.js";
import { Router, type Request } from "express";
import { HARNESS_REPOSITORY_MANAGEMENT_CAPABILITY } from "@paperclipai/shared";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { activityLog, agents, heartbeatRuns, issueComments, issues, projects, type Db } from "@paperclipai/db";
import { z } from "zod";
import { badRequest, conflict, forbidden } from "../errors.js";
import { secretService } from "../services/secrets.js";
import { acknowledgeStoppedSeatConversation, hasSeatStopIntent } from "../services/seat-execution-stop.js";
import { jiraIntakeSyncRoutes, syncJiraIntake } from "./jira-intake-sync.js";

const word=z.string().trim().min(1).max(100).refine(v=>!/[\r\n\0]/.test(v));
export const jiraDispatchSchema=z.object({enabled:z.boolean(),intakePaused:z.boolean().optional().default(false),jiraAssignee:word,jiraProjectKey:z.string().regex(/^[A-Z][A-Z0-9_]*$/),projectId:z.string().uuid(),workspaceId:z.string().uuid().optional(),readyStatuses:z.array(word).min(1).max(1000),jiraBaseUrl:z.string().url().max(2048).refine(v=>{try{const u=new URL(v);return ["http:","https:"].includes(u.protocol)&&!u.username&&!u.password&&!u.search&&!u.hash;}catch{return false;}}),issueTypes:z.array(z.enum(["编码","前端编码","功能","内部缺陷","线上问题","系统设计","系统设计补充","接口联调"])).min(1).max(8)}).strict();
type Agent=typeof agents.$inferSelect;
type Rule=z.infer<typeof jiraDispatchSchema>&{revision:number;ownerUserId:string;jiraSecretId?:string;jiraAccountOwnerUserId?:string};
export function dispatchRule(agent:Agent):Rule|null {return agent.adapterConfig.dsp7JiraDispatch as Rule??null;}
export function publicRule(agent:Agent) {
 const rule=dispatchRule(agent);if(!rule)return null;
 const {jiraSecretId,jiraAccountOwnerUserId: _accountOwner,...fields}=rule;return {...fields,jiraPatConfigured:!!jiraSecretId};
}
/** Manual intake reuses saved scope, but never grants automatic execution. */
export function manualIntakeRule(agent:Agent,intake:{jira_key:string;project_id:string;workspace_id?:string;version?:number},options:{allowPaused?:boolean}={}) {
 const rule=dispatchRule(agent);
 if(!rule?.jiraSecretId||!rule.readyStatuses?.length)throw conflict("请先在席位接单设置中配置 Jira PAT 和允许开工状态");
 if(rule.intakePaused&&!options.allowPaused)throw conflict("席位已暂停接单，请先恢复接单");
 if(!intake.jira_key.startsWith(rule.jiraProjectKey+"-"))throw conflict("工单所属 Jira 项目与席位规则不匹配；当前席位只接入 "+rule.jiraProjectKey+" 项目");
 if(rule.projectId!==intake.project_id)throw conflict("所选项目与席位接单设置不一致，请先调整席位规则");
 if(intake.version===4&&!(agent.adapterConfig.dsp7SeatPresence as {capabilities?:string[]}|undefined)?.capabilities?.includes(HARNESS_REPOSITORY_MANAGEMENT_CAPABILITY))throw conflict("请先更新席位客户端，由 Harness 管理执行仓库");
 return rule;
}
export async function platformDispatchRecord(db:Db,agent:Agent,taskId:string) {
 const [record]=await db.select().from(activityLog).where(and(eq(activityLog.companyId,agent.companyId),eq(activityLog.agentId,agent.id),eq(activityLog.action,"dsp7.platform.dispatch.changed"),eq(activityLog.entityId,taskId))).orderBy(desc(activityLog.createdAt)).limit(1);
 return record;
}
export async function platformAuthorization(db:Db,agent:Agent,task:typeof issues.$inferSelect,options:{allowStoppedRetry?:boolean}={}) {
 const raw=task.description?.match(/<!-- DSP7-JIRA-INTAKE (.*?) -->/)?.[1];
 let intake;try{intake=JSON.parse(raw??"");}catch{throw forbidden("平台派单申请无效");}
 if(![3,4].includes(intake.version)||intake.status_source!=="seat_rule"||intake.seat_id!==agent.id||task.projectId!==intake.project_id||!task.createdByUserId||task.createdByAgentId)throw forbidden("需要网页创建的席位规则接入申请");
 // Imported requirements retain authoritative execution roles in the audit record.
 // Editable descriptions cannot turn a human/linked review or QA item into a dev run.
 if(task.parentId){
  const [requirement]=await db.select().from(activityLog).where(and(eq(activityLog.companyId,agent.companyId),eq(activityLog.entityId,task.parentId),eq(activityLog.action,"dsp7.jira.requirement.imported"))).limit(1);
  if(requirement){
   const children=requirement.details?.children as Array<{key?:string;mode?:string;originId?:string}>|undefined;
   const child=Array.isArray(children)?children.find(item=>item.key===intake.jira_key):undefined;
   let jiraBaseUrl;try{jiraBaseUrl=new URL(dispatchRule(agent)?.jiraBaseUrl??"").href.replace(/\/$/,"");}catch{throw forbidden("Jira 来源配置无效");}
   if(!child||child.mode!=="development"||child.originId!==`${jiraBaseUrl}:${intake.jira_key}`)throw forbidden("此需求子工单不属于独立研发执行项；评审不能重复派单，测试须使用测试执行通道");
  }
 }
 if (task.status !== "in_progress") await assertDeliveryCodingAdmission(db,agent.companyId,intake.project_id,intake.jira_key);
 const rule=manualIntakeRule(agent,intake,{allowPaused:true});
 if(!rule.enabled)throw forbidden("席位尚未开启平台派单执行，请在接单设置中启用");
 const record=await platformDispatchRecord(db,agent,task.id);
 const creatorAllowed=await canCreateSeatIntake(db,agent,task.createdByUserId);
 const managerAllowed=await isSeatManagerUser(db,agent.companyId,typeof record?.details?.managerAuthorizedBy==="string"?record.details.managerAuthorizedBy:null);
 if((!creatorAllowed&&!managerAllowed)||record?.details?.state!=="authorized"||record.details.request!==raw||record.details.ownerUserId!==rule.ownerUserId)throw forbidden("任务没有有效的平台派单授权，或负责人已变化");
 const retry=record.details.automaticRetry as {sourceRunId?:string}|undefined;
 if(retry?.sourceRunId&&!options.allowStoppedRetry){
  const [source]=await db.select().from(heartbeatRuns).where(and(eq(heartbeatRuns.id,retry.sourceRunId),eq(heartbeatRuns.companyId,agent.companyId),eq(heartbeatRuns.agentId,agent.id)));
  if(!source||source.resultJson?.dsp7StopIntent||source.resultJson?.cancelledByActorType==="user"||await hasSeatStopIntent(db,agent.companyId,agent.id,source.id))throw forbidden("用户已明确停止，不能继续此前准备的自动重试；请明确恢复执行");
 }
 if(["done","cancelled"].includes(task.status))throw forbidden("任务已结束或阻塞，不能自动启动");
 return rule;
}
export async function dispatchAuthorization(db:Db,agent:Agent,task:typeof issues.$inferSelect) {
 if(task.createdByUserId)return platformAuthorization(db,agent,task);
 const rule=dispatchRule(agent);
 // Legacy active runs retain monitoring; Jira-discovered queued work cannot start.
 if(task.status!=="in_progress")throw forbidden("Jira 指派不再触发执行，请在智研平台派单");
 if(!rule?.enabled||task.createdByAgentId!==agent.id||task.createdByUserId)throw forbidden("自动接入授权已失效");
 const [record]=await db.select().from(activityLog).where(and(eq(activityLog.companyId,agent.companyId),eq(activityLog.agentId,agent.id),eq(activityLog.action,"dsp7.jira.discovered"),eq(activityLog.entityId,task.id))).limit(1);
 const raw=task.description?.match(/<!-- DSP7-JIRA-INTAKE (.*?) -->/)?.[1];
 if(!record||record.details?.request!==raw||record.details?.ownerUserId!==rule.ownerUserId)throw forbidden("自动接入申请或调度规则已变化");
 let intake;try{intake=JSON.parse(raw??"");}catch{throw forbidden("自动申请无效");}
 if(!rule.issueTypes.includes(record.details?.issueType as Rule["issueTypes"][number])||!String(record.details?.jiraKey).startsWith(rule.jiraProjectKey+"-"))throw forbidden("Jira 项目或类型不再符合当前规则");
 if(intake.project_id!==rule.projectId||!rule.readyStatuses.includes(intake.ready_status))throw forbidden("工单不再符合当前调度规则");
 return rule;
}
export function dsp7JiraDispatchRoutes(db:Db,own:(req:Request)=>Promise<Agent>,board:(req:Request)=>Promise<Agent>,enqueue?:(tx:Db,agent:Agent,task:typeof issues.$inferSelect,actorId:string,authorizationId:string)=>Promise<unknown>) {
 const router=Router();
 router.use(jiraIntakeSyncRoutes(db,own,board,platformAuthorization));
 router.use(jiraRequirementRoutes(db,board));
 router.post("/companies/:companyId/dsp7-seats/:id/platform-dispatch",async(req,res)=>{
  const agent=await board(req);const parsed=z.object({taskId:z.string().uuid(),action:z.enum(["authorize","cancel","resume"]).default("authorize")}).strict().safeParse(req.body);
  if(!parsed.success)throw badRequest("派单参数无效");
  let syncedRevision:number|undefined;
  let syncedRequest:string|undefined;
  if(parsed.data.action!=="cancel"){
   const [sourceTask]=await db.select().from(issues).where(and(eq(issues.id,parsed.data.taskId),eq(issues.companyId,agent.companyId)));
   if(!sourceTask)throw badRequest("任务不存在");
   const snapshot=await syncJiraIntake(db,agent,sourceTask,req.actor.userId??"local-board");
   if(!snapshot.eligible)throw conflict(snapshot.reasons.join("；"));
   syncedRevision=snapshot.ruleRevision;
   syncedRequest=sourceTask.description?.match(/<!-- DSP7-JIRA-INTAKE (.*?) -->/)?.[1];
  }
  const result=await db.transaction(async tx=>{
   await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${agent.id+":seat-commands"},0))`);
   const [fresh]=await tx.select().from(agents).where(and(eq(agents.id,agent.id),eq(agents.companyId,agent.companyId))).for("update");
   if(!canConfigureSeat(req,fresh.companyId,fresh.adapterConfig.dsp7Seat as Record<string,unknown>))throw forbidden("席位负责人已变化");
   const [task]=await tx.select().from(issues).where(and(eq(issues.id,parsed.data.taskId),eq(issues.companyId,agent.companyId))).for("update");
   if(!task||["done","cancelled"].includes(task.status))throw conflict("请选择尚未开始的有效接入任务；活动执行请在任务页处理");
   const recoveringStartup=task.status==="in_progress"&&parsed.data.action==="authorize";
   if(task.status==="in_progress"&&parsed.data.action!=="resume"){
    if(!recoveringStartup)throw conflict("活动执行请在任务页处理");
    const reason=await startupRetryBlockedReason(tx as unknown as Db,fresh,task);
    if(reason)throw conflict(reason);
   }
   const presence=fresh.adapterConfig.dsp7SeatPresence as {activeTaskId?:string;runId?:string;lastSeenAt?:string;capabilities?:string[];tasks?:Array<{taskId:string;stoppedRunId?:string}>}|undefined;
   if(presence?.activeTaskId===task.id&&presence.runId)throw conflict("任务已启动，请在任务页处理活动运行");
   const raw=task.description?.match(/<!-- DSP7-JIRA-INTAKE (.*?) -->/)?.[1];let intake;try{intake=JSON.parse(raw??"");}catch{throw badRequest("接入申请无效");}
   if(![3,4].includes(intake.version)||intake.status_source!=="seat_rule"||intake.seat_id!==agent.id||intake.project_id!==task.projectId||!task.createdByUserId||task.createdByAgentId)throw forbidden("仅支持网页席位规则申请，请勿修改旧申请标记");
   if(parsed.data.action!=="cancel"&&intake.version===4&&!presence?.capabilities?.includes(HARNESS_REPOSITORY_MANAGEMENT_CAPABILITY))throw conflict("请先更新席位客户端，由 Harness 管理执行仓库");
   const rule=parsed.data.action==="cancel"?dispatchRule(fresh):manualIntakeRule(fresh,intake);
   if(!rule)throw conflict("席位规则尚未配置");
   if(syncedRequest!==undefined&&raw!==syncedRequest)throw conflict("同步期间接入申请已变化，请刷新后重新派单");
   if(syncedRevision!==undefined&&rule.revision!==syncedRevision)throw conflict("同步期间席位规则已变化，请刷新后重新派单");
   const managerDispatch=isSeatManager(req,fresh.companyId);
   if(!managerDispatch&&!await canCreateSeatIntake(tx as unknown as Db,fresh,task.createdByUserId))throw forbidden("原申请人未获所选席位授权");
   const action=parsed.data.action;
   let retryingIntake=false;
   let retryingStartup=false;
   if(action!=="cancel") await assertDeliveryCodingAdmission(tx as unknown as Db,agent.companyId,intake.project_id,intake.jira_key);
   if(action==="resume"){
    await platformAuthorization(tx as unknown as Db,fresh,task,{allowStoppedRetry:true});
    if(!presence?.capabilities?.includes("execution-recovery-v1"))throw conflict("请先更新席位客户端以支持中断恢复");
    if(!presence.lastSeenAt||Date.now()-Date.parse(presence.lastSeenAt)>90000)throw conflict("请等待席位上线并核验旧进程已停止");
    const [active]=await tx.select().from(heartbeatRuns).where(and(eq(heartbeatRuns.agentId,agent.id),inArray(heartbeatRuns.status,["queued","running","scheduled_retry"]),sql`(${heartbeatRuns.contextSnapshot}->>'issueId' = ${task.id} or ${heartbeatRuns.contextSnapshot}->>'taskId' = ${task.id})`));
    if(active)throw conflict("工单仍有活动运行，不能重复启动");
    const stoppedId=presence.tasks?.find(t=>t.taskId===task.id)?.stoppedRunId;
    const [lastRun]=await tx.select().from(heartbeatRuns).where(and(eq(heartbeatRuns.agentId,agent.id),eq(heartbeatRuns.companyId,agent.companyId),sql`(${heartbeatRuns.contextSnapshot}->>'issueId' = ${task.id} or ${heartbeatRuns.contextSnapshot}->>'taskId' = ${task.id}) and ${heartbeatRuns.contextSnapshot}->>'wakeReason' like ${'本地研发人员主动启动交互会话；%'}`)).orderBy(desc(heartbeatRuns.createdAt)).limit(1);
    if(!lastRun||lastRun.id!==stoppedId||!["failed","cancelled","timed_out"].includes(lastRun.status))throw conflict("尚未确认本机旧执行已经停止，请稍后刷新");
    if(task.status!=="blocked"||!String((task.unblockDescriptor as {action?:string}|null)?.action??"").startsWith("执行已中断"))throw conflict("仅支持恢复已确认中断的执行；其他阻塞请先处理原因");
    await acknowledgeStoppedSeatConversation(tx as unknown as Db,{agent:fresh,task,runId:lastRun.id,actorId:req.actor.userId??"local-board"});
   }
   const commandRequests=await tx.select().from(activityLog).where(and(eq(activityLog.companyId,agent.companyId),eq(activityLog.agentId,agent.id),eq(activityLog.action,"dsp7.seat.command.requested"),sql`${activityLog.details}->>'taskId' = ${task.id}`)).orderBy(desc(activityLog.createdAt));
   for(const request of commandRequests){
    const [last]=await tx.select().from(activityLog).where(and(eq(activityLog.companyId,agent.companyId),eq(activityLog.agentId,agent.id),eq(activityLog.action,"dsp7.seat.command.result"),eq(activityLog.entityId,request.entityId))).orderBy(desc(activityLog.createdAt)).limit(1);
    const state=String(last?.details?.status??"queued");
    if(action==="authorize"&&request===commandRequests[0]&&["failed","denied","expired","cancelled"].includes(state))retryingStartup=true;
    if(action==="resume"&&["queued","awaiting_local","accepted","running"].includes(state))await tx.insert(activityLog).values({companyId:agent.companyId,agentId:agent.id,actorType:"user",actorId:req.actor.userId!,action:"dsp7.seat.command.result",entityType:"dsp7_seat_command",entityId:request.entityId,details:{commandId:request.entityId,status:["accepted","running"].includes(state)?"failed":"cancelled",sequence:Number(last?.details?.sequence??0)+1,message:"已核验旧进程停止，关闭旧请求并由网页恢复执行"}});
    if(action!=="resume"&&["accepted","running"].includes(state))throw conflict("本机已领取启动请求，请到任务页处理活动执行");
    if(action==="cancel"&&["queued","awaiting_local"].includes(state))await tx.insert(activityLog).values({companyId:agent.companyId,agentId:agent.id,actorType:"user",actorId:req.actor.userId!,action:"dsp7.seat.command.result",entityType:"dsp7_seat_command",entityId:request.entityId,details:{commandId:request.entityId,status:"cancelled",sequence:Number(last?.details?.sequence??0)+1,message:"网页已取消平台自动执行"}});
   }
   if(action!=="cancel"){
    if(!rule.enabled)throw conflict("请先在席位接单设置中开启平台派单执行");
    if(task.status==="blocked"&&action!=="resume"){
     let receipt;try{receipt=JSON.parse(task.description?.match(/<!-- DSP7-INTAKE-RESULT (.*?) -->/)?.[1]??"{}");}catch{/* Not an intake failure. */}
     if(receipt?.status!=="blocked"||!String(task.unblockDescriptor?.action??"").startsWith("请核对并解决接入失败原因"))throw conflict("请先解决阻塞并重试接入，再派单执行");
     await tx.update(issues).set({status:"backlog",unblockDescriptor:null,updatedAt:new Date()}).where(eq(issues.id,task.id));
     task.status="backlog";task.unblockDescriptor=null;
     retryingIntake=true;
    }
    if(!presence?.capabilities?.includes("platform-dispatch-v1"))throw conflict("请先更新席位客户端，等待新版能力上报后再派单");
    const comments=await tx.select().from(issueComments).where(and(eq(issueComments.issueId,task.id),eq(issueComments.companyId,agent.companyId),eq(issueComments.authorUserId,task.createdByUserId)));
    if(!managerDispatch&&!comments.some(c=>!c.authorAgentId&&!c.deletedAt&&c.body.includes(`<!-- DSP7-JIRA-INTAKE-AUTH ${raw} -->`)))throw forbidden("缺少原申请人的接入授权评论");
   }
   const previous=await platformDispatchRecord(tx as unknown as Db,fresh,task.id);
   if(action==="authorize"&&retryingStartup&&!recoveringStartup&&previous?.details?.state==="authorized"){
    const reason=await startupRetryBlockedReason(tx as unknown as Db,fresh,task);
    if(reason)throw conflict(reason);
   }
   const state=action==="cancel"?"cancelled":"authorized";
   if(recoveringStartup){
    const stoppedId=presence?.tasks?.find(item=>item.taskId===task.id)?.stoppedRunId;
    if(!stoppedId)throw conflict("尚未确认本机旧执行已经停止，请稍后刷新");
    await acknowledgeStoppedSeatConversation(tx as unknown as Db,{agent:fresh,task,runId:stoppedId,actorId:req.actor.userId??"local-board"});
   }
   if(action==="resume"||recoveringStartup){
    await tx.update(issues).set({status:"backlog",unblockDescriptor:null,updatedAt:new Date()}).where(eq(issues.id,task.id));
    task.status="backlog";task.unblockDescriptor=null;
   }
   if(!retryingIntake&&!retryingStartup&&action!=="resume"&&previous?.details?.state===state&&previous.details.request===raw&&previous.details.ownerUserId===rule.ownerUserId&&(!managerDispatch||previous.details.managerAuthorizedBy===req.actor.userId))return {taskId:task.id,state,authorizationId:previous.id};
   const [record]=await tx.insert(activityLog).values({companyId:agent.companyId,agentId:agent.id,actorType:"user",actorId:req.actor.userId!,action:"dsp7.platform.dispatch.changed",entityType:"issue",entityId:task.id,responsibleUserId:rule.ownerUserId,details:{state,request:raw,ownerUserId:rule.ownerUserId,...(managerDispatch?{managerAuthorizedBy:req.actor.userId}:{}),...(action==="resume"?{recovery:true}: {}),...(recoveringStartup?{startupRecovery:true}: {})}}).returning();
   const command=state==="authorized"?await enqueue?.(tx as unknown as Db,fresh,action==="resume"?{...task,status:"backlog",unblockDescriptor:null}:task,req.actor.userId!,record.id):null;
   return {taskId:task.id,state,authorizationId:record.id,command};
  });res.json(result);
 });
 router.get("/companies/:companyId/dsp7-seats/:id/platform-dispatch/:taskId",async(req,res)=>{
  const agent=await board(req);const [task]=await db.select().from(issues).where(and(eq(issues.id,String(req.params.taskId)),eq(issues.companyId,agent.companyId)));
  if(!task)throw badRequest("任务不存在");
  const raw=task.description?.match(/<!-- DSP7-JIRA-INTAKE (.*?) -->/)?.[1];let intake;try{intake=JSON.parse(raw??"");}catch{throw badRequest("接入申请无效");}if(intake.seat_id!==agent.id)throw forbidden("任务属于其他席位");
  const record=await platformDispatchRecord(db,agent,task.id);const presence=agent.adapterConfig.dsp7SeatPresence as {state?:string;activeRuns?:Array<{taskId:string;state:string}>;lastSeenAt?:string;activeTaskId?:string;runId?:string|null;acceptingWork?:boolean;checks?:Array<{label:string;status:string}>;alerts?:Array<{taskId:string;id:string}>;tasks?:Array<{taskId:string;stoppedRunId?:string}>}|undefined;
  const online=!!presence?.lastSeenAt&&Date.now()-Date.parse(presence.lastSeenAt)<90000;
  const authorized=record?.details?.state==="authorized";
  const taskRun=presence?.activeRuns?.find(run=>run.taskId===task.id);
  let phase=task.status==="done"?"done":task.status==="cancelled"?"cancelled":task.status==="blocked"?"blocked":task.status==="in_progress"?((taskRun?.state??(presence?.activeTaskId===task.id?presence.state:undefined))==="waiting_decision"?"waiting_decision":"running"):!authorized?(record?.details?.state==="cancelled"?"dispatch_cancelled":"registered_only"):!online?"waiting_online":presence?.activeTaskId&&presence.activeTaskId!==task.id?"queued":task.description?.includes("DSP7-PILOT:")?"ready_to_start":"preparing";
  let message:string|null=null;
  if(task.status==="in_progress"&&presence?.alerts?.some(a=>a.taskId===task.id&&a.id.endsWith(":terminal_disconnected"))){phase="reconnecting";message=`本机终端已断开，可在 60 秒内运行 harness attach ${intake.jira_key} 重连；等待审批时保留会话。`;}
  if(task.status==="blocked"&&String((task.unblockDescriptor as {action?:string}|null)?.action??"").startsWith("执行已中断")){phase="interrupted";message=String((task.unblockDescriptor as {action:string}).action);}
  let startup:null|{stage:string;startedAt:string;elapsedSeconds:number;steps:Array<{stage:string;at:string;elapsedSeconds:number}>}=null;
  if(authorized&&record){
   const [request]=await db.select().from(activityLog).where(and(eq(activityLog.companyId,agent.companyId),eq(activityLog.agentId,agent.id),eq(activityLog.action,"dsp7.seat.command.requested"),sql`${activityLog.details}->>'taskId' = ${task.id}`)).orderBy(desc(activityLog.createdAt)).limit(1);
   if(request&&request.createdAt>=record.createdAt){
    const results=await db.select().from(activityLog).where(and(eq(activityLog.companyId,agent.companyId),eq(activityLog.agentId,agent.id),eq(activityLog.action,"dsp7.seat.command.result"),eq(activityLog.entityId,request.entityId)));
    results.sort((a,b)=>Number(a.details?.sequence??0)-Number(b.details?.sequence??0));
    const last=results.at(-1);const state=String(last?.details?.status??"queued");
    const failed=["failed","denied","expired","cancelled"].includes(state)||(["queued","awaiting_local","accepted"].includes(state)&&Date.parse(String(request.details?.expiresAt))<=Date.now());
    const seen=new Set<string>();const steps=[{stage:"authorized",at:record.createdAt.toISOString(),elapsedSeconds:0},{stage:"command_created",at:request.createdAt.toISOString(),elapsedSeconds:Math.max(0,(request.createdAt.getTime()-record.createdAt.getTime())/1000)}];
    for(const event of results){
     const stage=String(event.details?.stage??({awaiting_local:"received",accepted:"validating",running:"terminal_connected"} as Record<string,string>)[String(event.details?.status)]??"");
     if(!stage||seen.has(stage))continue;seen.add(stage);
     steps.push({stage,at:event.createdAt.toISOString(),elapsedSeconds:Math.max(0,(event.createdAt.getTime()-record.createdAt.getTime())/1000)});
    }
    const current=failed?"failed":steps.at(-1)!.stage;
    const end=steps.find(step=>step.stage==="terminal_connected")?.at??(failed?last?.createdAt.toISOString():null);
    startup={stage:current,startedAt:record.createdAt.toISOString(),elapsedSeconds:Math.max(0,((end?Date.parse(end):Date.now())-record.createdAt.getTime())/1000),steps};
    if(!["done","cancelled","interrupted","reconnecting","waiting_decision","blocked","waiting_online"].includes(phase)){
     if(failed){phase="startup_failed";message=String(last?.details?.message??"启动请求已过期，请检查本机终端，取消后重新派单");}
     else if(state==="queued"){phase="command_pending";message="启动指令已生成，等待本机领取";}
     else if(state==="awaiting_local"){phase="opening_terminal";message=String(last?.details?.message??"本机已收到，正在打开可见终端");}
     else if(state==="accepted"){phase="starting";message=String(last?.details?.message??"正在核验本机并建立真实运行");}
    }
   }
  }
  if(record?.details?.automaticRetry&&["ready_to_start","preparing","waiting_online","queued"].includes(phase)){phase="retry_pending";message="旧进程已确认停止，已授权一次自动重试；正在等待本机重新核验并打开可见终端，尚未确认执行启动。";}
  const rule=dispatchRule(agent);
  const failedChecks=presence?.checks?.filter(check=>check.status==="fail")??[];
  const resumeBlockedReason=!online?"席位离线，请先在本机执行 harness online 并等待心跳":
   failedChecks.length||presence?.state==="config_error"?"本机配置检查未通过"+(failedChecks.length?"（"+failedChecks.map(check=>check.label).join("、")+"）":"")+"。请在席位的设备与诊断中刷新登记，等待检查通过后再恢复":
   presence?.acceptingWork===false?"本机已暂停接单，请在本机执行 harness online":
   !rule?.enabled||rule.intakePaused?"席位尚未启用或已暂停平台派单，请先恢复接单设置":
   ["paused","terminated","pending_approval"].includes(agent.status)?"席位已暂停或尚不可执行，请先处理席位状态":
   !seatCanAcceptWork(presence)?"席位配置异常或暂停接单，请检查设备":
   !presence?.tasks?.find(t=>t.taskId===task.id)?.stoppedRunId?"正在核验本机旧进程是否停止，请稍后再恢复":
   !authorized?"当前任务缺少有效的平台派单授权，请核对原派单和席位负责人":null;
  const retryStartupBlockedReason=phase==="startup_failed"?await startupRetryBlockedReason(db,agent,task):null;
  res.json({taskId:task.id,phase,message,authorized,canRetryStartup:phase==="startup_failed"&&!retryStartupBlockedReason,retryStartupBlockedReason,canResume:!resumeBlockedReason,resumeBlockedReason,authorizationId:record?.id??null,startup});
 });
 router.post("/agents/:id/dsp7-platform-dispatches",async(req,res)=>{
  const agent=await own(req);
  const records=await db.select().from(activityLog).where(and(eq(activityLog.companyId,agent.companyId),eq(activityLog.agentId,agent.id),eq(activityLog.action,"dsp7.platform.dispatch.changed"))).orderBy(desc(activityLog.createdAt));
  const seen=new Set<string>();const authorized=[];
  for(const record of records){if(seen.has(record.entityId))continue;seen.add(record.entityId);if(record.details?.state!=="authorized")continue;
   const [task]=await db.select().from(issues).where(and(eq(issues.id,record.entityId),eq(issues.companyId,agent.companyId)));
   if(!task||["done","cancelled"].includes(task.status))continue;
   try{await platformAuthorization(db,agent,task);authorized.push({taskId:task.id,authorizationId:record.id});}catch{/* Revoked scope is not execution authority. */}
  }res.json({tasks:authorized});
 });

 router.post("/companies/:companyId/dsp7-seats/:id/jira-dispatch/intake-preview",async(req,res)=>{
  const agent=await board(req);
  const parsed=z.object({jiraKey:z.string().regex(/^[A-Z][A-Z0-9_]*-\d+$/),projectId:z.string().uuid(),workspaceId:z.string().uuid().optional()}).strict().safeParse(req.body);
  if(!parsed.success)throw badRequest("请选择席位、项目并填写有效 Jira 工单号");
  const data=parsed.data;const rule=manualIntakeRule(agent,{jira_key:data.jiraKey,project_id:data.projectId,workspace_id:data.workspaceId});
  const target=new URL(rule.jiraBaseUrl);
  const allowed=(process.env.PAPERCLIP_JIRA_ALLOWED_ORIGINS??"http://jira.fingard.com:6001").split(",").map(v=>v.trim());
  if(!allowed.includes(target.origin))throw badRequest("此 Jira 地址尚未允许服务器预览，请管理员配置 PAPERCLIP_JIRA_ALLOWED_ORIGINS");
  const token=await secretService(db).resolveSecretValue(agent.companyId,rule.jiraSecretId!,"latest",{accessContext:{consumerType:"agent",consumerId:agent.id,configPath:"dsp7JiraDispatch.jiraSecretId",responsibleUserId:req.actor.userId,actorType:"user",actorId:req.actor.userId!}});
  let reply:Response;
  try{reply=await fetch(target.href.replace(/\/$/,"")+"/rest/api/2/issue/"+encodeURIComponent(data.jiraKey)+"?fields=summary,status,issuetype,assignee",{headers:{Authorization:"Bearer "+token,Accept:"application/json"},redirect:"error",signal:AbortSignal.timeout(10000)});}catch{throw badRequest("无法连接 Jira，请核对服务器 DNS、网络和 Jira 地址");}
  if(!reply.ok)throw badRequest(reply.status===401||reply.status===403?"Jira PAT 无效或没有查询权限":"Jira 工单查询失败（HTTP "+reply.status+"）");
  let issue;try{issue=await reply.json();}catch{throw badRequest("Jira 返回格式无效");}
  const f=issue.fields;
  if(!f?.status?.name||!f.issuetype?.name)throw badRequest("Jira 工单缺少状态或类型");
  if(f.status.statusCategory?.key==="done")throw conflict("已完成工单不能接入真实开发，请使用模拟入口");
  if(!rule.readyStatuses.includes(f.status.name))throw conflict("Jira 当前状态“"+f.status.name+"”不在席位允许状态内："+rule.readyStatuses.join("、")+"。请在席位接单设置中调整");
  if(!rule.issueTypes.includes(f.issuetype.name))throw conflict("当前工单类型“"+f.issuetype.name+"”不在席位接单范围内");
  res.setHeader("Cache-Control","no-store");res.json({jiraKey:data.jiraKey,status:f.status.name,issueType:f.issuetype.name,summary:String(f.summary??""),readyStatuses:rule.readyStatuses,revision:rule.revision});
 });
 router.get("/companies/:companyId/dsp7-seats/:id/jira-dispatch",async(req,res)=>res.json(publicRule(await board(req))));
 router.post("/companies/:companyId/dsp7-seats/:id/jira-dispatch/intake",async(req,res)=>{
  const agent=await board(req);const parsed=z.object({paused:z.boolean()}).strict().safeParse(req.body);
  if(!parsed.success)throw badRequest("接单状态无效");
  const result=await db.transaction(async tx=>{
   const [current]=await tx.select().from(agents).where(eq(agents.id,agent.id)).for("update");
   if(!canConfigureSeat(req,current.companyId,current.adapterConfig.dsp7Seat as Record<string,unknown>))throw forbidden("席位负责人已变化，请刷新页面");
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
  const matches=null;
  res.setHeader("Cache-Control","no-store");res.json({actorName:String(actor.displayName??actor.name??"Jira 用户"),statuses:Array.isArray(statuses)?statuses.map((s:{name:string})=>s.name):[],matches,verifiedAt:new Date().toISOString()});
 });
 router.post("/companies/:companyId/dsp7-seats/:id/jira-dispatch",async(req,res)=>{
  const agent=await board(req);const parsed=jiraDispatchSchema.extend({credentials:z.object({token:z.string().trim().min(1).max(4096).refine(v=>!/[\r\n\0]/.test(v))}).strict().optional()}).safeParse(req.body);if(!parsed.success)throw badRequest("请填写 Jira 经办人、项目、允许状态和工单类型");
  const {credentials,workspaceId:_legacyWorkspace,...data}=parsed.data;const [project]=await db.select().from(projects).where(and(eq(projects.id,data.projectId),eq(projects.companyId,agent.companyId)));
  if(!project||project.archivedAt)throw conflict("请选择本组织的有效项目");
  const users=(agent.adapterConfig.dsp7Seat as {intakeUserIds?:string[]}).intakeUserIds??[];
  const owner=users.includes(req.actor.userId??"")?req.actor.userId!:users[0];if(!owner)throw conflict("请先登记席位负责人的网站账号");
  const rule=await db.transaction(async tx=>{
   await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${agent.companyId+":jira-dispatch-rules"},0))`);
   const [current]=await tx.select().from(agents).where(eq(agents.id,agent.id)).for("update");
   if(!canConfigureSeat(req,current.companyId,current.adapterConfig.dsp7Seat as Record<string,unknown>))throw forbidden("席位负责人已变化，请刷新页面");
   let jiraSecretId=dispatchRule(current)?.jiraSecretId;
   if(!credentials&&jiraSecretId&&dispatchRule(current)?.jiraBaseUrl!==data.jiraBaseUrl)throw badRequest("更换 Jira 地址时请重新填写 PAT");
   if(credentials){
    const secrets=secretService(tx);
    if(jiraSecretId){await secrets.rotate(jiraSecretId,{value:credentials.token},{userId:req.actor.userId});}
    else {
     const existing=await secrets.getByName(agent.companyId,"DSP7 Jira PAT "+agent.id+" "+owner);
     if(existing){await secrets.rotate(existing.id,{value:credentials.token},{userId:req.actor.userId});jiraSecretId=existing.id;}
     else jiraSecretId=(await secrets.create(agent.companyId,{name:"DSP7 Jira PAT "+agent.id+" "+owner,provider:"local_encrypted",value:credentials.token},{userId:req.actor.userId})).id;
    }
   }
   if(data.enabled&&!jiraSecretId)throw badRequest("首次启用 Jira 自动接单，请填写 PAT；后续留空表示保留已有 PAT");
   const rule={...data,intakePaused:dispatchRule(current)?.intakePaused??false,jiraSecretId,revision:(dispatchRule(current)?.revision??0)+1,ownerUserId:owner,jiraAccountOwnerUserId:owner};
   await tx.update(agents).set({adapterConfig:{...current.adapterConfig,dsp7JiraDispatch:rule}}).where(eq(agents.id,agent.id));
   await tx.insert(activityLog).values({companyId:agent.companyId,agentId:agent.id,actorType:"user",actorId:req.actor.userId!,action:"dsp7.jira.dispatch.configured",entityType:"agent",entityId:agent.id,details:rule});
   return rule;
  });const {jiraSecretId,jiraAccountOwnerUserId: _accountOwner,...fields}=rule;res.json({...fields,jiraPatConfigured:!!jiraSecretId});
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
  if(!task)throw badRequest("任务不存在");const rule=await dispatchAuthorization(db,agent,task);if(req.body.start===true&&(rule.intakePaused||task.status==="blocked"))throw conflict("席位已暂停接单，当前运行可继续");res.json({rule:publicRule(agent)});
 });
 router.post("/agents/:id/dsp7-jira-dispatch/discover",async(req,_res)=>{
  await own(req);throw forbidden("Jira 指派不再自动创建执行任务，请在智研平台派单");
 });
 return router;
}
