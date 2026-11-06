import { Router, type Request } from "express";
import { and, asc, desc, eq, gte, lt, lte, inArray, isNull, notInArray, or } from "drizzle-orm";
import { agents, authUsers, costEvents, deliverySnapshots, issues, managedBindings, managedEvents, managedQuality, managedSeatSamples, managedSessions, managedTaskFacts, projects, seatExecutionPermits, heartbeatRuns, type Db } from "@paperclipai/db";
import { z } from "zod";
import { assertBoard, assertCompanyAccess } from "./authz.js";
import { isSeatManager, seatOwnerId } from "./dsp7-seat-owners.js";
import { badRequest, forbidden } from "../errors.js";
import { periodBounds } from "./managed-session-reports.js";
import { acceptanceFor, buildDeliveryInsights, type InsightsInput } from "../services/delivery-insights.js";

const querySchema=z.object({period:z.enum(["day","week","month","quarter","year"]).default("week"),date:z.string().default(()=>new Date(Date.now()+8*3600000).toISOString().slice(0,10)),projectId:z.union([z.string().uuid(),z.literal("__none__")]).optional(),seatId:z.string().uuid().optional(),ownerId:z.string().min(1).max(200).optional(),domain:z.enum(["analysis","development","qa","unknown"]).optional(),scope:z.enum(["mine","company"]).default("mine"),page:z.coerce.number().int().min(1).max(10000).default(1),pageSize:z.coerce.number().int().min(1).max(100).default(25)}).strict();
/** Hard limits fail the whole report instead of presenting truncated totals. */
function complete<T>(rows:T[],max=20000):T[]{if(rows.length>max)throw badRequest("统计数据超过当前查询上限，请缩小周期或项目范围；未返回部分统计");return rows;}
export function deliveryInsightsRoutes(db:Db){
  const router=Router(),base="/companies/:companyId/delivery-insights";
  function access(req:Request){const companyId=String(req.params.companyId);assertBoard(req);assertCompanyAccess(req,companyId);return companyId;}
  router.get(base,async(req,res)=>{
    const companyId=access(req),parsed=querySchema.safeParse(req.query);if(!parsed.success)throw badRequest("统计筛选参数无效");
    const q=parsed.data,{from,to}=periodBounds(q.period,q.date),now=Date.now(),manager=isSeatManager(req,companyId),ownOnly=!manager||q.scope==="mine";
    const ownerId=ownOnly?req.actor.userId??"local-board":q.ownerId;
    if(ownOnly&&q.ownerId&&q.ownerId!==ownerId)throw forbidden("只能查看本人执行记录");
    if(q.projectId&&q.projectId!=="__none__"){
      const [p]=await db.select({id:projects.id}).from(projects).where(and(eq(projects.companyId,companyId),eq(projects.id,q.projectId)));
      if(!p)throw forbidden("项目不属于当前组织");
    }
    const allSeats=complete(await db.select().from(agents).where(eq(agents.companyId,companyId)).limit(20001));
    const registered=allSeats.filter(a=>a.adapterConfig.dsp7Seat&&a.adapterConfig.dsp7WebJiraIntake===true);
    const currentSeats=registered.filter(a=>!ownOnly||seatOwnerId(a.adapterConfig.dsp7Seat as Record<string,unknown>)===ownerId);
    const current= currentSeats.length?complete(await db.select().from(issues).where(and(eq(issues.companyId,companyId),inArray(issues.assigneeAgentId,currentSeats.map(s=>s.id)),notInArray(issues.status,["done","cancelled"]))).orderBy(desc(issues.updatedAt)).limit(20001)):[];
    const facts=complete(await db.select().from(managedTaskFacts).where(and(eq(managedTaskFacts.companyId,companyId),eq(managedTaskFacts.simulated,false),gte(managedTaskFacts.at,new Date(from)),lt(managedTaskFacts.at,new Date(to)),lte(managedTaskFacts.at,new Date(now)),ownerId?eq(managedTaskFacts.ownerUserId,ownerId):undefined,q.seatId?eq(managedTaskFacts.seatId,q.seatId):undefined)).limit(20001));
    const costs=complete(await db.select().from(costEvents).where(and(eq(costEvents.companyId,companyId),gte(costEvents.occurredAt,new Date(from)),lt(costEvents.occurredAt,new Date(to)),lte(costEvents.occurredAt,new Date(now)))).limit(20001));
    const costRunIds=[...new Set(costs.map(c=>c.heartbeatRunId).filter((v):v is string=>!!v))];
    const taskIds=[...new Set([...current.map(t=>t.id),...facts.map(f=>f.taskId)])];
    const sessions=complete(await db.select().from(managedSessions).where(and(eq(managedSessions.companyId,companyId),eq(managedSessions.simulated,false),lte(managedSessions.startedAt,new Date(now)),ownerId?eq(managedSessions.ownerUserId,ownerId):undefined,q.seatId?eq(managedSessions.seatId,q.seatId):undefined,
      or(isNull(managedSessions.endedAt),gte(managedSessions.endedAt,new Date(from)),taskIds.length?inArray(managedSessions.taskId,taskIds):undefined,costRunIds.length?inArray(managedSessions.runId,costRunIds):undefined))).orderBy(desc(managedSessions.startedAt)).limit(20001));
    const selectedTaskIds=[...new Set([...taskIds,...sessions.map(s=>s.taskId)])];
    const tasks=selectedTaskIds.length?complete(await db.select().from(issues).where(and(eq(issues.companyId,companyId),inArray(issues.id,selectedTaskIds))).orderBy(desc(issues.updatedAt),desc(issues.id)).limit(20001)):[];
    const sessionIds=sessions.map(s=>s.id);
    const bindings=sessionIds.length?complete(await db.select().from(managedBindings).where(and(eq(managedBindings.companyId,companyId),inArray(managedBindings.sessionId,sessionIds))).limit(20001)):[];
    const runIds=[...new Set([...sessions.map(s=>s.runId),...bindings.map(b=>b.runId)])];
    const permits=runIds.length?complete(await db.select().from(seatExecutionPermits).where(and(eq(seatExecutionPermits.companyId,companyId),inArray(seatExecutionPermits.runId,runIds))).limit(20001)):[];
    const runs=runIds.length?complete(await db.select({id:heartbeatRuns.id,startedAt:heartbeatRuns.startedAt,createdAt:heartbeatRuns.createdAt,finishedAt:heartbeatRuns.finishedAt}).from(heartbeatRuns).where(and(eq(heartbeatRuns.companyId,companyId),inArray(heartbeatRuns.id,runIds))).limit(20001)):[];
    // Metadata only: never read content manifests, private bodies or tool output.
    const events=sessionIds.length?complete(await db.select({id:managedEvents.id,sessionId:managedEvents.sessionId,eventType:managedEvents.eventType,occurredAt:managedEvents.occurredAt,observedAt:managedEvents.observedAt,payload:managedEvents.payload}).from(managedEvents).where(and(eq(managedEvents.companyId,companyId),inArray(managedEvents.sessionId,sessionIds),inArray(managedEvents.eventType,["phase","execution"]),lte(managedEvents.occurredAt,new Date(now)))).orderBy(asc(managedEvents.occurredAt)).limit(200001),200000):[];
    const visibleSeatIds=[...new Set([...currentSeats.map(s=>s.id),...sessions.map(s=>s.seatId),...facts.map(f=>f.seatId)])];
    const seats=registered.filter(s=>visibleSeatIds.includes(s.id));
    const samples=visibleSeatIds.length&&!q.projectId&&!q.domain?complete(await db.select().from(managedSeatSamples).where(and(eq(managedSeatSamples.companyId,companyId),inArray(managedSeatSamples.seatId,visibleSeatIds),gte(managedSeatSamples.through,new Date(from-90000)),lt(managedSeatSamples.at,new Date(Math.min(to,now))),ownerId?eq(managedSeatSamples.ownerUserId,ownerId):undefined)).orderBy(asc(managedSeatSamples.at)).limit(20001)):[];
    const qualities=selectedTaskIds.length?complete(await db.select().from(managedQuality).where(and(eq(managedQuality.companyId,companyId),inArray(managedQuality.taskId,selectedTaskIds),ownerId?eq(managedQuality.ownerUserId,ownerId):undefined)).limit(20001)):[];
    const ownersIds=[...new Set([...seats.map(s=>seatOwnerId(s.adapterConfig.dsp7Seat as Record<string,unknown>)),...sessions.map(s=>s.ownerUserId),...facts.map(f=>f.ownerUserId)].filter((v):v is string=>!!v))].filter(id=>!ownOnly||id===ownerId);
    const owners=ownersIds.length?await db.select({id:authUsers.id,name:authUsers.name}).from(authUsers).where(inArray(authUsers.id,ownersIds)):[];
    const parents=selectedTaskIds.length?complete(await db.select({parentId:issues.parentId}).from(issues).where(and(eq(issues.companyId,companyId),inArray(issues.parentId,selectedTaskIds))).limit(20001)):[];
    const input:InsightsInput={tasks,seats,sessions,events,facts,qualities,costs,permits,bindings,samples,owners,runs,parentIds:[...new Set(parents.map(p=>p.parentId!))]};
    const report=buildDeliveryInsights(input,{...q,from,to,now,ownerId});
    res.setHeader("Cache-Control","no-store");res.json(report);
  });
  router.get(base+"/acceptance",async(req,res)=>{
    const companyId=access(req);const parsed=z.object({projectId:z.string().uuid(),page:z.coerce.number().int().min(1).max(10000).default(1)}).strict().safeParse(req.query);if(!parsed.success)throw badRequest("请选择项目");
    const {projectId,page}=parsed.data;
    const [p]=await db.select({id:projects.id}).from(projects).where(and(eq(projects.companyId,companyId),eq(projects.id,projectId)));if(!p)throw forbidden("项目不属于当前组织");
    const snapshots=await db.select().from(deliverySnapshots).where(and(eq(deliverySnapshots.companyId,companyId),eq(deliverySnapshots.projectId,projectId))).orderBy(desc(deliverySnapshots.createdAt),desc(deliverySnapshots.id)).limit(21).offset((page-1)*20);
    res.setHeader("Cache-Control","no-store");res.json({items:snapshots.slice(0,20).map(acceptanceFor),hasMore:snapshots.length>20,page,methodologyVersion:"acceptance-materials-v1"});
  });
  return router;
}
