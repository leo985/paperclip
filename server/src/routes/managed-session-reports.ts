import { Router } from "express";
import { and, asc, eq, gte, lt, inArray } from "drizzle-orm";
import { agents, authUsers, managedSessions, managedEvents, managedSeatSamples, managedQuality, managedTaskFacts, managedJiraWorkloads, managedSeatReportSettings, activityLog, type Db } from "@paperclipai/db";
import { DEFAULT_SEAT_WORK_SCHEDULE, seatWorkScheduleSchema, type SeatPeriodReport } from "@paperclipai/shared";
import { assertBoard, assertCompanyAccess } from "./authz.js";
import { isSeatManager, seatOwnerId } from "./dsp7-seat-owners.js";
import { badRequest, forbidden } from "../errors.js";
import { executionIntervals, unionMs } from "../services/managed-sessions.js";
import { seatOnlineIntervals, worktimeFor, type TimeInterval } from "../services/seat-worktime.js";
import { intervalOverlapMs } from "../services/interval-overlap.js";
import { qualityFor } from "../services/delivery-insights.js";
import { readSeatMonthlyReport } from "../services/seat-monthly-report.js";

export function periodBounds(period:string,date:string) {
  if(!/^\d{4}-\d{2}-\d{2}$/.test(date))throw badRequest("请选择有效日期");
  const day=new Date(date+"T00:00:00+08:00");if(!Number.isFinite(day.getTime()))throw badRequest("日期无效");
  const [y,m,d]=date.split("-").map(Number) as [number,number,number];
  let from=day.getTime(),to=from+86400000;
  const midnight=(year:number,month:number,dayOfMonth:number)=>Date.UTC(year,month,dayOfMonth)-8*3600000;
  if(period==="week"){const dow=new Date(from+8*3600000).getUTCDay();from-=(dow+6)%7*86400000;to=from+7*86400000;}
  else if(period==="month"){from=midnight(y,m-1,1);to=midnight(y,m,1);}
  else if(period==="quarter"){const q=Math.floor((m-1)/3)*3;from=midnight(y,q,1);to=midnight(y,q+3,1);}
  else if(period==="year"){from=midnight(y,0,1);to=midnight(y+1,0,1);}
  else if(period!=="day")throw badRequest("周期应为日、周、月、季度或年");
  if(new Date(day.getTime()+8*3600000).toISOString().slice(0,10)!==date||d<1||m<1||m>12||y<2020||y>2100)throw badRequest("日期超出范围");return {from,to};
}
export function managedReportRoutes(db:Db) {
  const router=Router();
  router.get("/companies/:companyId/managed-seat-report/monthly-delivery", async (req, res) => {
    const companyId = String(req.params.companyId);
    assertBoard(req);
    assertCompanyAccess(req, companyId);
    const { month } = req.query;
    if (typeof month !== "string") throw badRequest("请选择有效月份");
    periodBounds("month", month + "-01");
    const report = await readSeatMonthlyReport(db, companyId, month, isSeatManager(req, companyId), req.actor.userId);
    res.setHeader("Cache-Control", "no-store");
    res.json(report);
  });
  router.put("/companies/:companyId/managed-seat-report/work-schedule", async (req, res) => {
    const companyId = String(req.params.companyId);
    assertBoard(req); assertCompanyAccess(req, companyId);
    if (!isSeatManager(req, companyId)) throw forbidden("只有管理员可以修改工作时段");
    const parsed = seatWorkScheduleSchema.safeParse(req.body);
    if (!parsed.success) throw badRequest("请选择工作日和有效、不重叠的工作时段");
    const workSchedule = {
      days: [...parsed.data.days].sort((a, b) => a - b),
      periods: [...parsed.data.periods].sort((a, b) => a.start.localeCompare(b.start)),
    };
    await db.transaction(async tx => {
      await tx.insert(managedSeatReportSettings).values({ companyId, workSchedule })
        .onConflictDoUpdate({ target: managedSeatReportSettings.companyId, set: { workSchedule, updatedAt: new Date() } });
      await tx.insert(activityLog).values({ companyId, actorType: "user", actorId: req.actor.userId ?? "local-board",
        action: "dsp7.seat.work_schedule.updated", entityType: "company", entityId: companyId, details: { workSchedule } });
    });
    res.json(workSchedule);
  });
  router.get("/companies/:companyId/managed-seat-report",async(req,res)=>{
    const companyId=String(req.params.companyId);assertBoard(req);assertCompanyAccess(req,companyId);
    const period=String(req.query.period??"week"),date=String(req.query.date??new Date(Date.now()+8*3600000).toISOString().slice(0,10));
    const {from,to}=periodBounds(period,date),now=Math.max(from,Math.min(to,Date.now())),manager=isSeatManager(req,companyId);
    const [settings] = await db.select().from(managedSeatReportSettings).where(eq(managedSeatReportSettings.companyId, companyId));
    const workSchedule = settings?.workSchedule ?? DEFAULT_SEAT_WORK_SCHEDULE;
    const allSeats=await db.select().from(agents).where(eq(agents.companyId,companyId));
    const sessions=await db.select().from(managedSessions).where(and(eq(managedSessions.companyId,companyId),lt(managedSessions.startedAt,new Date(to)),manager?undefined:eq(managedSessions.ownerUserId,req.actor.userId??"")));
    const seats=allSeats.filter(a=>a.adapterConfig.dsp7WebJiraIntake===true&&(manager||seatOwnerId(a.adapterConfig.dsp7Seat as Record<string,unknown>)===req.actor.userId||sessions.some(s=>s.seatId===a.id)));
    const facts=await db.select().from(managedTaskFacts).where(and(eq(managedTaskFacts.companyId,companyId),eq(managedTaskFacts.simulated,false),gte(managedTaskFacts.at,new Date(from)),lt(managedTaskFacts.at,new Date(to)),manager?undefined:eq(managedTaskFacts.ownerUserId,req.actor.userId??"")));
    const sessionIds=sessions.filter(s=>!s.simulated).map(s=>s.id);
    const events=sessionIds.length?await db.select().from(managedEvents).where(and(inArray(managedEvents.sessionId,sessionIds),eq(managedEvents.eventType,"execution"),gte(managedEvents.occurredAt,new Date(from-90000)),lt(managedEvents.occurredAt,new Date(to)))).orderBy(asc(managedEvents.occurredAt)):[];
    const samples=seats.length?await db.select().from(managedSeatSamples).where(and(eq(managedSeatSamples.companyId,companyId),inArray(managedSeatSamples.seatId,seats.map(s=>s.id)),gte(managedSeatSamples.through,new Date(from-90000)),lt(managedSeatSamples.at,new Date(to)))).orderBy(asc(managedSeatSamples.at)):[];
    const workloads=await db.select().from(managedJiraWorkloads).where(and(eq(managedJiraWorkloads.companyId,companyId),gte(managedJiraWorkloads.at,new Date(from-900000)),lt(managedJiraWorkloads.at,new Date(to)))).orderBy(asc(managedJiraWorkloads.at));
    const qualities=await db.select().from(managedQuality).where(and(eq(managedQuality.companyId,companyId),manager?undefined:eq(managedQuality.ownerUserId,req.actor.userId??"")));
    const ownerIds=new Set([...seats.map(a=>seatOwnerId(a.adapterConfig.dsp7Seat as Record<string,unknown>)),...facts.map(f=>f.ownerUserId),...sessions.map(s=>s.ownerUserId)].filter((v):v is string=>!!v));
    const owners=ownerIds.size?await db.select({id:authUsers.id,name:authUsers.name}).from(authUsers).where(inArray(authUsers.id,[...ownerIds])):[];
    const report:SeatPeriodReport={timezone:"Asia/Shanghai",from:new Date(from).toISOString(),to:new Date(to).toISOString(),period,simulatedExcluded:true,workSchedule,canConfigureWorkSchedule:Boolean(manager),seats:[],people:[],note:"仅统计平台已接入工单，模拟任务排除。开始／交付为首次业务事件，转交不改历史归属；平台在手为期末 90 秒内快照，Jira 在手为配置经办人／项目／类型范围内未完成工单的 15 分钟内快照。缺陷按交付后 14 天、Jira 显式关联及最新采集快照计算，未成熟样本不进入发生率分母。工作时段在线仅累计心跳证明的连接时长，不代表人员工时；心跳未覆盖的工作时段标记统计不完整，不推算为离线。"};
    const personIntervals=new Map<string,{executing:Array<{start:number;end:number}>;waiting:Array<{start:number;end:number}>;idle:Array<{start:number;end:number}>;online:TimeInterval[];from:number}>();
    for(const seat of seats){
      const relevant=sessions.filter(s=>s.seatId===seat.id&&!s.simulated&&(s.endedAt===null||s.endedAt.getTime()>=from));
      const scopeOwners=new Set<string|null>([seatOwnerId(seat.adapterConfig.dsp7Seat as Record<string,unknown>),...relevant.map(s=>s.ownerUserId),...facts.filter(f=>f.seatId===seat.id).map(f=>f.ownerUserId),...samples.filter(s=>s.seatId===seat.id).map(s=>s.ownerUserId)]);
      const seatSamples=samples.filter(s=>s.seatId===seat.id);
      for(const ownerId of scopeOwners){
        if(!manager&&ownerId!==req.actor.userId)continue;
        const online = seatOnlineIntervals(seatSamples, ownerId, now);
        const onlineFrom = Math.max(from, seat.createdAt.getTime());
        const ownSessions=relevant.filter(s=>s.ownerUserId===ownerId);
        const intervals=ownSessions.flatMap(s=>executionIntervals(s,events.filter(e=>e.sessionId===s.id).map(e=>({...e,occurredAt:e.occurredAt.toISOString(),observedAt:e.observedAt.toISOString()}))));
        const executing=intervals.filter(i=>i.state==="executing"),waiting=intervals.filter(i=>i.state==="waiting");
        const idle=seatSamples.flatMap((s,i)=>s.ownerUserId===ownerId&&s.state==="idle"&&!s.taskId?[{start:s.at.getTime(),end:Math.min(s.through.getTime()+90000,seatSamples[i+1]?.at.getTime()??now)}]:[]);
        const executingMs=unionMs(executing,from,now),waitingMs=Math.max(0,unionMs(waiting,from,now)-intervalOverlapMs(waiting,executing,from,now));
        const idleMs=Math.max(0,unionMs(idle,from,now)-intervalOverlapMs(idle,[...executing,...waiting],from,now));
        const observable=Math.max(0,now-from),unknownMs=Math.max(0,observable-executingMs-waitingMs-idleMs);
        const ownFacts=facts.filter(f=>f.seatId===seat.id&&f.ownerUserId===ownerId);
        const deliveries=ownFacts.filter(f=>f.kind==="delivered");
        const quality=qualityFor(deliveries,qualities,Date.now());
        const defects=quality.linkedDefects,defectRate=quality.observedDefectRate;
        const lastSample=seatSamples.at(-1);
        const workload=workloads.filter(w=>w.seatId===seat.id&&w.ownerUserId===ownerId).at(-1);
        report.seats.push({seatId:seat.id,ownerUserId:ownerId,name:String((seat.adapterConfig.dsp7Seat as Record<string,unknown>)?.name??seat.name),ownerName:owners.find(o=>o.id===ownerId)?.name??null,
          backlog:lastSample?.ownerUserId===ownerId&&now-lastSample.through.getTime()<90000?lastSample.backlog:null,
          jiraBacklog:workload&&now-workload.at.getTime()<900000?workload.total:null,jiraScope:workload?.scope??null,
          started:ownFacts.filter(f=>f.kind==="started").length,delivered:deliveries.length,cancelled:ownFacts.filter(f=>f.kind==="cancelled").length,
          ...worktimeFor(online, workSchedule, onlineFrom, now),
          executingMs,waitingMs,idleMs,unknownMs,coverage:observable?(executingMs+waitingMs+idleMs)/observable:0,defects,qualityCoverage:quality.coverage??0,matureDeliveries:quality.measuredMature,matureEligible:quality.matureEligible,affectedMature:quality.affectedMature,defectRate});
        if(ownerId){const aggregate=personIntervals.get(ownerId)??{executing:[],waiting:[],idle:[],online:[],from:onlineFrom};aggregate.from=Math.min(aggregate.from,onlineFrom);aggregate.online.push(...online);aggregate.executing.push(...executing);aggregate.waiting.push(...waiting);aggregate.idle.push(...idle);personIntervals.set(ownerId,aggregate);}
      }
    }
    for(const [ownerId,intervals] of personIntervals){
      const executingMs=unionMs(intervals.executing,from,now);
      const overlap=intervalOverlapMs(intervals.waiting,intervals.executing,from,now);
      const waitingMs=Math.max(0,unionMs(intervals.waiting,from,now)-overlap);
      const busy=[...intervals.executing,...intervals.waiting];
      const idleMs=Math.max(0,unionMs(intervals.idle,from,now)-intervalOverlapMs(intervals.idle,busy,from,now));
      report.people.push({ownerUserId:ownerId,name:owners.find(o=>o.id===ownerId)?.name??ownerId,...worktimeFor(intervals.online,workSchedule,intervals.from,now),executingMs,waitingMs,idleMs,unknownMs:Math.max(0,now-from-executingMs-waitingMs-idleMs)});
    }
    res.setHeader("Cache-Control","no-store");res.json(report);
  });
  return router;
}
