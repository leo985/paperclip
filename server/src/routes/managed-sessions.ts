import { assertHarnessValidationRun } from "../services/harness-validation.js";
import { harnessV2Enabled } from "../services/harness-v2-rollout.js";
import { HARNESS_OBSERVATION_CAPABILITY, parseBoundHarnessObservation } from "@paperclipai/shared";
import { analysisExecutions } from "@paperclipai/db";
import { Router, type Request } from "express";
import { and, asc, desc, eq, gt, inArray, sql } from "drizzle-orm";
import { activityLog, agents, heartbeatRuns, issues, managedSessions, managedBindings, managedStreams, managedEvents, managedContents, managedParts, managedQuality, managedTaskFacts, managedJiraWorkloads, type Db } from "@paperclipai/db";
import { MANAGED_BATCH_BYTES, MANAGED_PART_BYTES, managedBatchSchema, managedRegisterSchema, managedControlSchema, managedIdentitySchema, managedPartSchema, managedManifestSchema, managedMetadataSchemas } from "@paperclipai/shared";
import { z } from "zod";
import { assertBoard, assertCompanyAccess } from "./authz.js";
import { isSeatManager, seatOwnerId } from "./dsp7-seat-owners.js";
import { badRequest, conflict, forbidden, notFound } from "../errors.js";
import { containsCredential, contentBody, digest, purgeSessionBodies, timelineFor, timingFor } from "../services/managed-sessions.js";
import { managedReportRoutes } from "./managed-session-reports.js";

const uuid=(v:unknown)=>{const parsed=z.string().uuid().safeParse(v);if(!parsed.success)throw badRequest("无效的会话或任务编号");return parsed.data;};
export function managedSessionRoutes(db:Db) {
  const router=Router();
  // Emergency write gate leaves existing private reads and the domain executor intact.
  router.use((req,_res,next)=>{
    if(process.env.DSP7_MANAGED_SESSIONS_ENABLED==="false"&&req.method==="POST"&&/^\/agents\/[^/]+\/managed-/.test(req.path))throw conflict("平台已暂停会话采集写入；本机保留队列");
    next();
  });
  router.use(managedReportRoutes(db));
  async function own(req:Request, store:Db=db) {
    const id=uuid(req.params.id);
    if(req.actor.type!=="agent"||req.actor.source!=="agent_key"||req.actor.agentId!==id||(req.actor.keyScope&&req.actor.keyScope.kind!=="standard"))throw forbidden("请使用本席位设备凭证");
    assertCompanyAccess(req,req.actor.companyId!);
    const parsed=managedIdentitySchema.safeParse(req.body);if(!parsed.success)throw badRequest("设备身份无效");
    const [agent]=await store.select().from(agents).where(and(eq(agents.id,id),eq(agents.companyId,req.actor.companyId!))).for("update");
    const seat=agent?.adapterConfig.dsp7Seat as Record<string,unknown>|undefined;
    if(!agent||!seat||agent.adapterConfig.dsp7WebJiraIntake!==true||seat.machineId!==parsed.data.machine_id||seat.machineFingerprint!==parsed.data.machine_fingerprint||id!==parsed.data.seat_id||agent.status==="terminated")throw forbidden("设备登记已撤销或身份不匹配");
    return agent;
  }
  async function sourceSession(req:Request,store:Db=db,allowDeleted=false) {
    const agent=await own(req,store);
    const [session]=await store.select().from(managedSessions).where(and(eq(managedSessions.id,uuid(req.params.sessionId)),eq(managedSessions.seatId,agent.id),eq(managedSessions.companyId,agent.companyId))).for("update");
    if(!session||session.machineId!==req.body.machine_id||session.machineFingerprint!==req.body.machine_fingerprint)throw notFound("受管会话不存在");
    if(session.deletedAt){if(allowDeleted)return session;throw conflict("会话正文已删除，禁止重新上传");}
    const [run]=await store.select().from(heartbeatRuns).where(eq(heartbeatRuns.id,session.runId));
    const boundEnd=session.endedAt?.getTime()??run?.finishedAt?.getTime();
    if(boundEnd&&Date.now()-boundEnd>7*86400000)throw forbidden("会话补传期限已结束");
    // A device may append the original ended scope during its seven-day backfill window.
    // It gains no execution authority or access to the successor's conversations.
    if(session.ownerUserId!==seatOwnerId(agent.adapterConfig.dsp7Seat as Record<string,unknown>)&&!session.endedAt)throw forbidden("负责人已变更，禁止扩展未冻结会话");
    return session;
  }
  async function readable(req:Request) {
    const companyId=uuid(req.params.companyId);assertBoard(req);assertCompanyAccess(req,companyId);
    const [session]=await db.select().from(managedSessions).where(and(eq(managedSessions.id,uuid(req.params.sessionId)),eq(managedSessions.companyId,companyId)));
    if(!session||(!isSeatManager(req,companyId)&&session.ownerUserId!==req.actor.userId))throw notFound("会话不存在或无权查看");
    return session;
  }
  function noCache(res:{setHeader:(k:string,v:string)=>unknown}){res.setHeader("Cache-Control","no-store");res.setHeader("X-Content-Type-Options","nosniff");}
  async function audit(req:Request,session:typeof managedSessions.$inferSelect,action:string,store:Db=db) {
    await store.insert(activityLog).values({companyId:session.companyId,agentId:session.seatId,actorType:req.actor.type==="agent"?"agent":"user",actorId:req.actor.agentId??req.actor.userId??"local-board",action,entityType:"managed_session",entityId:session.id,details:{taskId:session.taskId}});
  }
  router.post("/agents/:id/managed-jira-workload",async(req,res)=>{
    const data=z.object({revision:z.number().int().positive(),total:z.number().int().min(0).max(10000000)}).safeParse(req.body);if(!data.success)throw badRequest("Jira 工作量快照无效");
    await db.transaction(async tx=>{
      const agent=await own(req,tx as unknown as Db),rule=agent.adapterConfig.dsp7JiraDispatch as {revision:number;jiraSecretId?:string;ownerUserId:string;jiraProjectKey:string;jiraAssignee:string;issueTypes:string[]}|undefined;
      if(!rule||rule.revision!==data.data.revision||!rule.jiraSecretId||rule.ownerUserId!==seatOwnerId(agent.adapterConfig.dsp7Seat as Record<string,unknown>))throw conflict("Jira 查询范围或负责人已变化");
      await tx.insert(managedJiraWorkloads).values({companyId:agent.companyId,seatId:agent.id,ownerUserId:rule.ownerUserId,total:data.data.total,revision:rule.revision,scope:{project:rule.jiraProjectKey,assignee:rule.jiraAssignee,issueTypes:rule.issueTypes,status:"statusCategory != Done"}});
    });res.json({ok:true});
  });
  router.post("/agents/:id/managed-task-quality",async(req,res)=>{
    const data=z.object({taskId:z.string().uuid(),jiraKey:z.string().regex(/^[A-Z][A-Z0-9_]*-\d+$/),windowDays:z.literal(14),source:z.literal("jira-explicit-links"),defects:z.array(z.object({key:z.string().regex(/^[A-Z][A-Z0-9_]*-\d+$/),createdAt:z.string().datetime({offset:true}),severity:z.string().max(100)})).max(1000)}).safeParse(req.body);
    if(!data.success)throw badRequest("质量关联字段无效");
    await db.transaction(async tx=>{
      const agent=await own(req,tx as unknown as Db),v=data.data;
      const [task]=await tx.select().from(issues).where(and(eq(issues.id,v.taskId),eq(issues.companyId,agent.companyId),eq(issues.assigneeAgentId,agent.id)));
      if(!task||!task.completedAt||task.description?.includes("明确模式：replay")||!task.description?.includes("DSP7-PILOT:"+v.jiraKey))throw forbidden("质量采集必须绑定本席位已交付的正式工单");
      const [session]=await tx.select().from(managedSessions).where(and(eq(managedSessions.taskId,task.id),eq(managedSessions.seatId,agent.id))).orderBy(desc(managedSessions.startedAt)).limit(1);
      if(!session)throw conflict("该工单没有可归属的受管会话");
      const [delivery]=await tx.select().from(managedTaskFacts).where(and(eq(managedTaskFacts.companyId,agent.companyId),eq(managedTaskFacts.taskId,task.id),eq(managedTaskFacts.kind,"delivered")));
      if(!delivery)throw conflict("缺少正式交付事件，不能计算缺陷观察窗口");
      const defects=v.defects.filter(d=>Date.parse(d.createdAt)>=delivery.at.getTime()&&Date.parse(d.createdAt)<delivery.at.getTime()+14*86400000);
      const values={companyId:agent.companyId,seatId:agent.id,taskId:task.id,ownerUserId:session.ownerUserId,jiraKey:v.jiraKey,source:v.source,windowDays:v.windowDays,defects,observedAt:new Date()};
      await tx.insert(managedQuality).values(values).onConflictDoUpdate({target:[managedQuality.companyId,managedQuality.taskId],set:{defects,observedAt:values.observedAt}});
    });res.json({ok:true});
  });
  router.post("/agents/:id/managed-sessions",async(req,res)=>{
    const body=managedRegisterSchema.safeParse(req.body);if(!body.success)throw badRequest("采集协议或绑定字段无效");
    const session=await db.transaction(async tx=>{
      const store=tx as unknown as Db,agent=await own(req,store),data=body.data;
      const [run]=await tx.select().from(heartbeatRuns).where(and(eq(heartbeatRuns.id,data.runId),eq(heartbeatRuns.agentId,agent.id),eq(heartbeatRuns.companyId,agent.companyId)));
      const [task]=await tx.select().from(issues).where(and(eq(issues.id,data.taskId),eq(issues.companyId,agent.companyId)));
      const context=run?.contextSnapshot as Record<string,unknown>|null;
      const [analysis]=task?await tx.select({id:analysisExecutions.id}).from(analysisExecutions).where(and(eq(analysisExecutions.id,task.id),eq(analysisExecutions.companyId,agent.companyId),eq(analysisExecutions.seatId,agent.id),eq(analysisExecutions.activeRunId,run?.id??"00000000-0000-0000-0000-000000000000"))):[];
      const [existing]=await tx.select().from(managedSessions).where(and(eq(managedSessions.seatId,agent.id),eq(managedSessions.machineId,data.machine_id),eq(managedSessions.nativeSessionId,data.nativeSessionId)));
      // The native permit validator verifies the exact selected task, manager grant,
      // registry pin and one-run binding. A context marker alone grants no collection.
      let validation = false;
      if (run && task && context?.harnessValidationDispatchId !== undefined) {
        if (!existing) await assertHarnessValidationRun(store, { companyId: agent.companyId, seatId: agent.id, taskId: task.id }, run.id);
        validation = true;
      }
      if(!run||!task||(context?.issueId!==task.id&&context?.taskId!==task.id)||task.assigneeAgentId!==agent.id||(!analysis&&!validation&&!task.description?.includes("DSP7-PILOT:")))throw forbidden("采集必须绑定本席位已登记的真实运行和工单");
      if(existing){
        if(existing.taskId!==task.id||existing.ownerUserId!==seatOwnerId(agent.adapterConfig.dsp7Seat as Record<string,unknown>)||existing.deletedAt||existing.runId!==run.id)throw conflict("禁止跨任务、负责人或未声明轮次复用会话");
        return existing;
      }
      if(!["running","queued"].includes(run.status))throw conflict("新采集会话只能在活动运行中绑定");
      const ownerUserId=seatOwnerId(agent.adapterConfig.dsp7Seat as Record<string,unknown>);if(!ownerUserId)throw conflict("请先指定席位负责人");
      const [created]=await tx.insert(managedSessions).values({companyId:agent.companyId,taskId:task.id,seatId:agent.id,runId:run.id,nativeSessionId:data.nativeSessionId,machineId:data.machine_id,machineFingerprint:data.machine_fingerprint,ownerUserId,simulated:!!task.description?.includes("明确模式：replay"),startedAt:run.startedAt??new Date()}).returning();
      await tx.insert(managedBindings).values({sessionId:created.id,companyId:created.companyId,runId:run.id});
      await tx.insert(managedTaskFacts).values({companyId:created.companyId,taskId:created.taskId,seatId:created.seatId,ownerUserId:created.ownerUserId,kind:"started",at:created.startedAt,simulated:created.simulated}).onConflictDoNothing();
      await audit(req,created,"dsp7.session.bound",store);return created;
    });
    noCache(res);res.json({sessionId:session.id,protocolVersion:1,collectionPaused:session.collectionPaused,uploadPaused:session.uploadPaused,policy:"full-visible-redacted-v1",partBytes:MANAGED_PART_BYTES});
  });
  router.post("/agents/:id/managed-sessions/:sessionId/receipts",async(req,res)=>{
    const result=await db.transaction(async tx=>{
      const session=await sourceSession(req,tx as unknown as Db,true);
      const streams=await tx.select({streamId:managedStreams.streamId,ackSequence:managedStreams.ackSequence}).from(managedStreams).where(eq(managedStreams.sessionId,session.id));
      return {sessionId:session.id,deleted:!!session.deletedAt,streams,collectionPaused:session.collectionPaused,uploadPaused:session.uploadPaused,finalized:!!session.finalizedAt, capabilities: harnessV2Enabled("observation",session.companyId,session.seatId) ? [HARNESS_OBSERVATION_CAPABILITY] : []};
    });noCache(res);res.json(result);
  });
  router.post("/agents/:id/managed-sessions/:sessionId/events",async(req,res)=>{
    const parsed=managedBatchSchema.safeParse(req.body);if(!parsed.success||Buffer.byteLength(JSON.stringify(req.body))>MANAGED_BATCH_BYTES+4096)throw badRequest("采集事件字段无效或批次过大");
    // Reject content with recognizable credentials before persisting or echoing it.
    if(containsCredential(JSON.stringify(parsed.data.events)))throw badRequest("采集内容未通过二次脱敏检查，请更新本机规则");
    const result=await db.transaction(async tx=>{
      const store=tx as unknown as Db,session=await sourceSession(req,store);
      if(session.uploadPaused)throw conflict("已暂停上传；本机队列保留");
      if(session.finalizedAt)throw conflict("会话已收尾，不能追加未知内容");
      const [seatNow]=await tx.select().from(agents).where(eq(agents.id,session.seatId));
      const transferred=session.ownerUserId!==seatOwnerId(seatNow?.adapterConfig.dsp7Seat as Record<string,unknown>);
      const [stored]=await tx.select({bytes:sql<number>`coalesce(sum(octet_length(${managedParts.data})),0)::float8`}).from(managedParts).where(eq(managedParts.sessionId,session.id));
      let bodyBytes=Number(stored?.bytes??0);
      let coverage=session.coverage,endedAt=session.endedAt,observation=session.lastObservation;
      let harnessAppended=false;
      for(const event of parsed.data.events){
        if(event.eventType === "harness.observation") {
          if(!harnessV2Enabled("observation",session.companyId,session.seatId)) throw conflict("Harness observation capability is disabled");
          try { parseBoundHarnessObservation(event.payload, session, event.streamId); }
          catch { throw badRequest("Invalid Harness observation scope or payload"); }
        }
        if(event.eventType!=="content.part"&&event.eventType!=="content.manifest") {
          const schema=managedMetadataSchemas[event.eventType];
          if(!schema.safeParse(event.payload).success||Buffer.byteLength(JSON.stringify(event.payload))>16384)throw badRequest("状态事件字段无效或过大");
        }
        if(Date.parse(event.observedAt)>Date.now()+300000||Date.parse(event.occurredAt)>Date.now()+300000)throw badRequest("设备时钟超前，请校准后重传");
        if(transferred&&(!session.endedAt||Date.parse(event.occurredAt)>session.endedAt.getTime()))throw forbidden("转交后仅允许冻结边界内的原会话补传");
        await tx.insert(managedStreams).values({sessionId:session.id,companyId:session.companyId,streamId:event.streamId}).onConflictDoNothing();
        const [stream]=await tx.select().from(managedStreams).where(and(eq(managedStreams.sessionId,session.id),eq(managedStreams.streamId,event.streamId))).for("update");
        const hash=digest(event);
        if(event.sequence<=stream.ackSequence){const [prior]=await tx.select({digest:managedEvents.digest}).from(managedEvents).where(and(eq(managedEvents.sessionId,session.id),eq(managedEvents.streamId,event.streamId),eq(managedEvents.sequence,event.sequence)));if(prior?.digest!==hash)throw conflict("相同事件身份存在不同内容");continue;}
        if(event.sequence!==stream.ackSequence+1)throw conflict("事件序号存在缺口，请读取确认位置后补传");
        if(event.eventType==="content.part"){
          const part=managedPartSchema.safeParse(event.payload);if(!part.success||Buffer.byteLength(part.data.data)>MANAGED_PART_BYTES)throw badRequest("正文分块无效");
          // Binary attachments require a format-specific DLP adapter; protocol v1 accepts text only.
          if(part.data.encoding!=="utf8")throw badRequest("当前采集器仅接收已脱敏文本；二进制附件请报告不可用原因");
          bodyBytes+=Buffer.byteLength(part.data.data);
          if(bodyBytes>2*1024*1024*1024)throw conflict("该会话正文超过 2 GiB 配额，请处理保留策略后继续上传");
          await tx.insert(managedParts).values({sessionId:session.id,companyId:session.companyId,streamId:event.streamId,...part.data}).onConflictDoNothing();
        }
        if(event.eventType==="content.manifest"){
          const parsedManifest=managedManifestSchema.safeParse(event.payload);if(!parsedManifest.success)throw badRequest("正文清单无效");
          const manifest=parsedManifest.data;
          const values={sessionId:session.id,companyId:session.companyId,streamId:event.streamId,contentId:manifest.contentId,revision:manifest.revision,sequence:event.sequence,occurredAt:new Date(event.occurredAt),manifest};
          const [content]=await tx.insert(managedContents).values(values).onConflictDoUpdate({target:[managedContents.sessionId,managedContents.streamId,managedContents.contentId],set:{revision:values.revision,sequence:values.sequence,manifest:values.manifest}}).returning();
          const complete=manifest.unavailableReason===null && await contentBody(store,session.id,content)!==null;
          if(!complete&&!manifest.unavailableReason)throw conflict("正文分块不完整或摘要校验失败");
          await tx.update(managedContents).set({complete}).where(eq(managedContents.id,content.id));
          if(manifest.unavailableReason||manifest.sourceTruncated)coverage="known_gap";
        }
        if(event.eventType==="coverage")coverage="known_gap";
        if(event.eventType==="phase"){
          if(!["started","passed","failed","reopened","skipped","observed"].includes(String(event.payload.status)))throw badRequest("阶段事件状态无效");
          if(["passed","skipped"].includes(String(event.payload.status))&&(!event.payload.evidence||!event.payload.gateVersion))throw badRequest("阶段完成或跳过必须提供门禁版本与证据");
        }
        if(event.eventType==="lifecycle"&&event.payload.state==="exited")endedAt=new Date(event.occurredAt);
        if(event.eventType==="observation")observation=event.payload;
        await tx.insert(managedEvents).values({sessionId:session.id,companyId:session.companyId,streamId:event.streamId,sequence:event.sequence,eventId:event.eventId,eventType:event.eventType,occurredAt:new Date(event.occurredAt),observedAt:new Date(event.observedAt),sourceGeneration:event.sourceGeneration,sourceOffset:event.sourceOffset,digest:hash,payload:event.payload});
        if(event.eventType === "harness.observation") harnessAppended=true;
        await tx.update(managedStreams).set({ackSequence:event.sequence}).where(eq(managedStreams.id,stream.id));
      }
      if(harnessAppended) await audit(req,session,"dsp7.session.harness_observation.appended",store);
      await tx.update(managedSessions).set({coverage,endedAt,lastObservation:observation,lastReceivedAt:new Date(),syncState:endedAt?"backfilling":"collecting"}).where(eq(managedSessions.id,session.id));
      return {streams:await tx.select({streamId:managedStreams.streamId,ackSequence:managedStreams.ackSequence}).from(managedStreams).where(eq(managedStreams.sessionId,session.id)),missing:[]};
    });noCache(res);res.json(result);
  });
  router.post("/agents/:id/managed-sessions/:sessionId/finalize",async(req,res)=>{
    const endpoints=z.array(z.object({streamId:z.string().max(160),sequence:z.number().int().nonnegative()})).max(1000).safeParse(req.body.streams);if(!endpoints.success)throw badRequest("流终点清单无效");
    await db.transaction(async tx=>{
      const session=await sourceSession(req,tx as unknown as Db);
      if(session.finalizedAt)return;
      const streams=await tx.select().from(managedStreams).where(eq(managedStreams.sessionId,session.id));
      if(!session.endedAt||endpoints.data.length!==streams.length||streams.some(s=>!endpoints.data.some(end=>end.streamId===s.streamId&&end.sequence===s.ackSequence)))throw conflict("会话仍在运行或补传未完成");
      await tx.update(managedSessions).set({finalizedAt:new Date(),syncState:"ended"}).where(eq(managedSessions.id,session.id));
      await audit(req,session,"dsp7.session.finalized",tx as unknown as Db);
    });res.json({ok:true});
  });
  router.get("/companies/:companyId/issues/:taskId/managed-sessions",async(req,res)=>{
    const companyId=uuid(req.params.companyId);assertBoard(req);assertCompanyAccess(req,companyId);noCache(res);
    const rows=await db.select().from(managedSessions).where(and(eq(managedSessions.companyId,companyId),eq(managedSessions.taskId,uuid(req.params.taskId)),isSeatManager(req,companyId)?undefined:eq(managedSessions.ownerUserId,req.actor.userId??""))).orderBy(desc(managedSessions.startedAt));
    res.json(rows.map(({machineFingerprint:_fp,machineId:_machine,...session})=>session));
  });
  router.get("/companies/:companyId/managed-sessions/:sessionId",async(req,res)=>{
    const session=await readable(req);noCache(res);const timeline=await timelineFor(db,session.id);
    const {machineFingerprint:_fp,machineId:_mid,...safe}=session;
    const health=session.collectionPaused?"collection_paused":session.uploadPaused?"upload_paused":session.finalizedAt?"ended":Date.now()-session.lastReceivedAt.getTime()>90000?"disconnected":Number(session.lastObservation.queuedBytes??0)>262144?"backlogged":"normal";
    const [quality]=await db.select().from(managedQuality).where(and(eq(managedQuality.taskId,session.taskId),eq(managedQuality.companyId,session.companyId),eq(managedQuality.ownerUserId,session.ownerUserId??"")));
    res.json({session:safe,health,quality:quality?{observedAt:quality.observedAt,windowDays:quality.windowDays,defects:quality.defects,source:quality.source}:null,streams:await db.select({streamId:managedStreams.streamId,ackSequence:managedStreams.ackSequence}).from(managedStreams).where(eq(managedStreams.sessionId,session.id)),phases:timeline.filter(e=>e.eventType!=="execution"),timing:timingFor(session,timeline)});
  });
  router.get("/companies/:companyId/managed-sessions/:sessionId/harness-observations",async(req,res)=>{
    const session=await readable(req);noCache(res);
    const query=z.object({stream:z.string().regex(/^harness:[a-zA-Z0-9_-]{1,128}$/),after:z.coerce.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).default(0)}).strict().safeParse(req.query);
    if(!query.success)throw badRequest("Invalid observation cursor");
    if(session.deletedAt){res.json({items:[],next:null});return;}
    const rows=await db.select({sequence:managedEvents.sequence,observedAt:managedEvents.observedAt,payload:managedEvents.payload}).from(managedEvents)
      .where(and(eq(managedEvents.sessionId,session.id),eq(managedEvents.companyId,session.companyId),eq(managedEvents.eventType,"harness.observation"),eq(managedEvents.streamId,query.data.stream),gt(managedEvents.sequence,query.data.after)))
      .orderBy(asc(managedEvents.sequence)).limit(51);
    res.json({items:rows.slice(0,50),next:rows.length>50?rows[49]!.sequence:null});
  });
  router.get("/companies/:companyId/managed-sessions/:sessionId/messages",async(req,res)=>{
    const session=await readable(req);noCache(res);if(session.deletedAt){res.json({items:[],next:null});return;}
    const after=Number(req.query.after)||0;
    const limit=Math.min(50,Math.max(1,Number(req.query.limit)||30));
    const rows=await db.select().from(managedContents).where(and(eq(managedContents.sessionId,session.id),after?gt(managedContents.position,after):undefined)).orderBy(asc(managedContents.position)).limit(limit+1);
    // Database position is stable under revisions; new messages append after the cursor.
    res.json({items:rows.slice(0,limit),next:rows.length>limit?rows[limit-1]!.position:null});
  });
  router.get("/companies/:companyId/managed-sessions/:sessionId/messages/:contentId",async(req,res)=>{
    const session=await readable(req);noCache(res);if(session.deletedAt)throw notFound("正文已删除或到期");
    const [content]=await db.select().from(managedContents).where(and(eq(managedContents.id,uuid(req.params.contentId)),eq(managedContents.sessionId,session.id)));
    if(!content||!content.complete)throw notFound("正文尚未完整上传或已被排除");
    const from=Math.floor(Math.max(0,Number(req.query.from)||0));
    const parts=await db.select({partIndex:managedParts.partIndex,data:managedParts.data,encoding:managedParts.encoding}).from(managedParts).where(and(eq(managedParts.sessionId,session.id),eq(managedParts.streamId,content.streamId),eq(managedParts.contentId,content.contentId),eq(managedParts.revision,content.revision),sql`${managedParts.partIndex} >= ${from}`)).orderBy(asc(managedParts.partIndex)).limit(8);
    await audit(req,session,"dsp7.session.body.read");
    const total=Number(content.manifest.parts);res.json({parts,next:from+parts.length<total?from+parts.length:null,revision:content.revision});
  });
  router.post("/companies/:companyId/managed-sessions/:sessionId/control",async(req,res)=>{
    const session=await readable(req),parsed=managedControlSchema.safeParse(req.body);if(!parsed.success)throw badRequest("无效采集操作");
    await db.transaction(async tx=>{
      const [locked]=await tx.select().from(managedSessions).where(eq(managedSessions.id,session.id)).for("update");
      if(!locked)throw notFound("会话不存在");
      const action=parsed.data.action;
      if(action==="delete"){
        await tx.update(managedSessions).set({deletedAt:new Date(),syncState:"deleted",collectionPaused:true,uploadPaused:true,lastObservation:{}}).where(eq(managedSessions.id,session.id));
        await purgeSessionBodies(tx as unknown as Db,session.id);
      }else{
        if(locked.deletedAt||locked.finalizedAt)throw conflict("已删除或结束的会话不能修改采集策略");
        await tx.update(managedSessions).set(action.includes("collection")?{collectionPaused:action==="pause_collection",coverage:"known_gap"}:{uploadPaused:action==="pause_upload"}).where(eq(managedSessions.id,session.id));
      }
      await audit(req,session,"dsp7.session."+action,tx as unknown as Db);
    });res.json({ok:true});
  });
  return router;
}
