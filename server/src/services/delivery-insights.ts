import { deliveryPhaseTimings } from "./delivery-phase-timings.js";
import type { DeliveryAcceptance, DeliveryDomain, DeliveryInsights, DeliverySeatInsight, DeliveryTaskInsight, DeliveryUsage } from "@paperclipai/shared";
import type { agents, issues, managedSessions, managedEvents, managedTaskFacts, managedQuality, costEvents, seatExecutionPermits, managedBindings, managedSeatSamples, deliverySnapshots, heartbeatRuns } from "@paperclipai/db";
import { executionIntervals, unionMs } from "./managed-sessions.js";

type Row<T extends { $inferSelect: unknown }> = T["$inferSelect"];
export interface InsightsInput {
  tasks: Row<typeof issues>[]; seats: Row<typeof agents>[]; sessions: Row<typeof managedSessions>[];
  events: Pick<Row<typeof managedEvents>,"id"|"sessionId"|"eventType"|"occurredAt"|"observedAt"|"payload">[];
  facts: Row<typeof managedTaskFacts>[]; qualities: Row<typeof managedQuality>[];
  costs: Row<typeof costEvents>[]; permits: Row<typeof seatExecutionPermits>[];
  bindings: Row<typeof managedBindings>[]; samples: Row<typeof managedSeatSamples>[];
  owners: {id:string;name:string}[]; parentIds: string[];
  runs?: Pick<Row<typeof heartbeatRuns>,"id"|"startedAt"|"createdAt"|"finishedAt">[];
}
export interface InsightsFilter { from:number; to:number; now:number; page:number; pageSize:number; projectId?:string; seatId?:string; ownerId?:string; domain?:DeliveryDomain; }
const terminal = new Set(["done","cancelled"]);
const ownerOf=(seat:Row<typeof agents>|undefined)=>{
  const value=seat?.adapterConfig.dsp7Seat as {ownerUserId?:string;intakeUserIds?:string[]}|undefined;
  return value?.ownerUserId??value?.intakeUserIds?.[0]??null;
};
export function sumDeliveryUsage(runIds: string[], costs: InsightsInput["costs"]): DeliveryUsage {
  const ids=new Set(runIds), relevant=costs.filter(c=>c.heartbeatRunId&&ids.has(c.heartbeatRunId));
  const measured=new Set(relevant.filter(c=>c.idempotencyKey?.startsWith("heartbeat-observed-")||c.idempotencyKey===`heartbeat-final-${c.heartbeatRunId}`).map(c=>c.heartbeatRunId!));
  const finals=relevant.filter(c=>c.idempotencyKey===`heartbeat-final-${c.heartbeatRunId}`);
  const accepted=relevant.filter(c=>measured.has(c.heartbeatRunId!));
  const priced=new Set(finals.filter(c=>c.costStatus==="reported").map(c=>c.heartbeatRunId!));
  const known=relevant.filter(c=>c.costStatus==="reported");
  return {runs:ids.size,measuredRuns:measured.size,finalRuns:new Set(finals.map(c=>c.heartbeatRunId!)).size,
    inputTokens:measured.size?accepted.reduce((s,c)=>s+c.inputTokens,0):null,
    outputTokens:measured.size?accepted.reduce((s,c)=>s+c.outputTokens,0):null,
    cachedInputTokens:measured.size?accepted.reduce((s,c)=>s+c.cachedInputTokens,0):null,
    reportedCostCents:known.length?known.reduce((s,c)=>s+c.costCents,0):null,unpricedRuns:ids.size-priced.size};
}
export function qualityFor(deliveries: InsightsInput["facts"], qualities: InsightsInput["qualities"], asOf:number): DeliverySeatInsight["quality"] {
  const eligible=deliveries.filter(d=>d.at.getTime()+14*86400000<=asOf);
  const linked=deliveries.flatMap(d=>{
    const q=qualities.find(q=>q.taskId===d.taskId&&q.ownerUserId===d.ownerUserId&&q.seatId===d.seatId&&q.observedAt.getTime()<=asOf&&q.windowDays===14);
    if(!q)return [];
    const defects=q.defects.filter(b=>Date.parse(b.createdAt)>=d.at.getTime()&&Date.parse(b.createdAt)<d.at.getTime()+14*86400000&&Date.parse(b.createdAt)<=q.observedAt.getTime());
    return [{d,q,defects}];
  });
  const mature=linked.filter(({d,q})=>q.observedAt.getTime()>=d.at.getTime()+14*86400000);
  const affected=mature.filter(q=>q.defects.length>0).length;
  return {linkedDefects:linked.length?new Set(linked.flatMap(q=>q.defects.map(b=>b.key))).size:null,matureEligible:eligible.length,measuredMature:mature.length,affectedMature:affected,observedDefectRate:mature.length?affected/mature.length:null,coverage:eligible.length?mature.length/eligible.length:null,attributedBugRate:null};
}
export function buildDeliveryInsights(input: InsightsInput, filter:InsightsFilter): DeliveryInsights {
  const {from,to,now}=filter, end=Math.min(to,now);
  const seatMap=new Map(input.seats.map(s=>[s.id,s])),permitMap=new Map(input.permits.map(p=>[p.runId,p]));
  const sessions=input.sessions.filter(s=>!s.simulated);
  function group<T>(items:T[],key:(item:T)=>string){const map=new Map<string,T[]>();for(const item of items){const k=key(item);const a=map.get(k)??[];a.push(item);map.set(k,a);}return map;}
  const eventsBySession=group(input.events,e=>e.sessionId),bindingsBySession=group(input.bindings,b=>b.sessionId),sessionsByTask=group(sessions,s=>s.taskId);
  const runsById=new Map(input.runs?.map(r=>[r.id,r]));
  const domainOf=(runId:string):DeliveryDomain=>{
    const kind=permitMap.get(runId)?.executionRoute?.capability.kind;
    return kind==="analysis"||kind==="development"||kind==="qa"?kind:"unknown";
  };
  const costs=input.costs.filter(c=>c.occurredAt.getTime()>=from&&c.occurredAt.getTime()<to&&c.occurredAt.getTime()<=now);
  const costRuns=new Set(costs.map(c=>c.heartbeatRunId));
  const runIdsFor=(ss:typeof sessions)=>[...new Set(ss.flatMap(s=>[s.runId,...(bindingsBySession.get(s.id)??[]).map(b=>b.runId)].filter(id=>{
    const run=runsById.get(id);
    return costRuns.has(id)||(run?(run.startedAt??run.createdAt).getTime()<end&&(!run.finishedAt||run.finishedAt.getTime()>from):s.startedAt.getTime()<end&&(!s.endedAt||s.endedAt.getTime()>from));
  })))];
  const sessionOwnerMatch=(s:typeof sessions[number])=>(!filter.ownerId||s.ownerUserId===filter.ownerId)&&(!filter.seatId||s.seatId===filter.seatId)&&(!filter.domain||domainOf(s.runId)===filter.domain);
  const rows:DeliveryTaskInsight[]=[];
  const selectedSessions:typeof sessions=[];
  for(const task of input.tasks){
    if(task.description?.includes("明确模式：replay"))continue;
    const all=sessionsByTask.get(task.id)??[];
    const visible=all.filter(sessionOwnerMatch);
    const seat=seatMap.get(task.assigneeAgentId??"");
    const currentProjectMatch=!filter.projectId||(filter.projectId==="__none__"?task.projectId===null:task.projectId===filter.projectId);
    const currentMatch=currentProjectMatch&&(!filter.ownerId||ownerOf(seat)===filter.ownerId)&&(!filter.seatId||task.assigneeAgentId===filter.seatId)&&(!filter.domain||filter.domain==="unknown"&&!all.length);
    // A pinned project's identity controls historic runs. Never silently move
    // their accounting when someone edits the current task's project.
    const ss=visible.filter(s=>{const p=permitMap.get(s.runId)?.ledgerScope?.projectId;
      return !filter.projectId||(filter.projectId==="__none__"?p===null:p===filter.projectId);});
    if(!ss.length&&!currentMatch)continue;
    if(filter.domain&&!ss.length&&!currentMatch)continue;
    const latest=[...ss].sort((a,b)=>Number(!!a.endedAt)-Number(!!b.endedAt)||b.startedAt.getTime()-a.startedAt.getTime())[0];
    const timeline=ss.flatMap(s=>{
      const events=(eventsBySession.get(s.id)??[]).filter(e=>e.occurredAt.getTime()<=now).map(e=>({...e,occurredAt:e.occurredAt.toISOString(),observedAt:e.observedAt.toISOString()}));
      return executionIntervals(s,events,now);
    });
    const busy=timeline.filter(t=>t.state==="executing"),waiting=timeline.filter(t=>t.state==="waiting");
    const executingMs=unionMs(busy,from,end),waitingMs=Math.max(0,unionMs(waiting,from,end)-unionMs(waiting.flatMap(w=>busy.map(b=>({start:Math.max(w.start,b.start),end:Math.min(w.end,b.end)}))),from,end));
    const elapsed=unionMs(timeline,from,end);
    const latestEvents=(eventsBySession.get(latest?.id??"")??[]).filter(e=>e.occurredAt.getTime()<=now).sort((a,b)=>a.occurredAt.getTime()-b.occurredAt.getTime()||a.id.localeCompare(b.id));
    const lastInterval=latest?executionIntervals(latest,latestEvents.map(e=>({...e,occurredAt:e.occurredAt.toISOString(),observedAt:e.observedAt.toISOString()})),now).at(-1):null;
    const state:DeliveryTaskInsight["state"]=!latest?"not_observed":latest.endedAt?"stopped":lastInterval?.state==="executing"?"executing":lastInterval?.state==="waiting"?"waiting":"unknown";
    const phase=latestEvents.filter(e=>e.eventType==="phase").at(-1);
    const taskRuns=runIdsFor(ss),q=input.qualities.find(q=>q.taskId===task.id&&q.observedAt.getTime()<=now&&ss.some(s=>s.ownerUserId===q.ownerUserId&&s.seatId===q.seatId));
    if(terminal.has(task.status)&&!taskRuns.length&&!input.facts.some(f=>!f.simulated&&f.taskId===task.id&&f.at.getTime()>=from&&f.at.getTime()<Math.min(to,now)))continue;
    rows.push({taskId:task.id,identifier:task.identifier,title:task.title,projectId:task.projectId,seatId:task.assigneeAgentId,ownerUserId:ownerOf(seat),historicalOwners:[...new Set(ss.map(s=>s.ownerUserId).filter((v):v is string=>!!v))],status:task.status,isLeaf:!input.parentIds.includes(task.id),simulated:false,
      domains:[...new Set(ss.map(s=>domainOf(s.runId)))].length?[...new Set(ss.map(s=>domainOf(s.runId)))]:["unknown"],state,stateSince:latest?.endedAt?.toISOString()??(lastInterval?new Date(lastInterval.start).toISOString():null),
      phase:phase?{name:String(phase.payload.phase??"未知阶段"),status:String(phase.payload.status??"observed"),at:phase.occurredAt.toISOString(),gateEvidence:["passed","skipped"].includes(String(phase.payload.status))&&!!phase.payload.evidence&&!!phase.payload.gateVersion}:null,
      phaseTimings:deliveryPhaseTimings(ss,ss.flatMap(s=>(eventsBySession.get(s.id)??[]).map(e=>({...e,occurredAt:e.occurredAt.toISOString(),observedAt:e.observedAt.toISOString()}))),from,end,now),
      conversation:{sessions:ss.length,gaps:ss.filter(s=>s.coverage==="known_gap"||s.collectionPaused).length,finalized:ss.filter(s=>s.finalizedAt).length,unavailable:ss.filter(s=>s.deletedAt).length},
      executingMs,waitingMs,unknownMs:Math.max(0,elapsed-executingMs-waitingMs),usage:sumDeliveryUsage(taskRuns,costs),linkedDefects:q?q.defects.length:null});
    selectedSessions.push(...ss);
  }
  const taskIds=new Set(rows.filter(r=>r.isLeaf).map(r=>r.taskId));
  const facts=input.facts.filter(f=>{
    if(f.simulated||!taskIds.has(f.taskId)||f.at.getTime()<from||f.at.getTime()>=to||f.at.getTime()>now||filter.seatId&&f.seatId!==filter.seatId||filter.ownerId&&f.ownerUserId!==filter.ownerId)return false;
    if(!filter.projectId&&!filter.domain)return true;
    const source=[...sessions].filter(s=>s.taskId===f.taskId&&s.seatId===f.seatId&&s.ownerUserId===f.ownerUserId&&s.startedAt.getTime()<=f.at.getTime()).sort((a,b)=>b.startedAt.getTime()-a.startedAt.getTime())[0];
    const project=source?permitMap.get(source.runId)?.ledgerScope?.projectId:undefined;
    return !!source&&(!filter.domain||domainOf(source.runId)===filter.domain)&&(!filter.projectId||(filter.projectId==="__none__"?project===null:project===filter.projectId));
  });
  const seats:DeliverySeatInsight[]=[];
  for(const seat of input.seats){
    if(filter.seatId&&seat.id!==filter.seatId)continue;
    const ss=selectedSessions.filter(s=>s.seatId===seat.id),sf=facts.filter(f=>f.seatId===seat.id);
    const ownerIds=new Set([ownerOf(seat),...ss.map(s=>s.ownerUserId),...sf.map(f=>f.ownerUserId)]);
    for(const ownerId of ownerIds){
      if(filter.ownerId&&ownerId!==filter.ownerId)continue;
      const own=ss.filter(s=>s.ownerUserId===ownerId),ownFacts=sf.filter(f=>f.ownerUserId===ownerId);
      const intervals=own.flatMap(s=>executionIntervals(s,(eventsBySession.get(s.id)??[]).filter(e=>e.eventType==="execution").map(e=>({...e,occurredAt:e.occurredAt.toISOString(),observedAt:e.observedAt.toISOString()})),now));
      const executing=intervals.filter(i=>i.state==="executing"),waiting=intervals.filter(i=>i.state==="waiting");
      const executingMs=unionMs(executing,from,end),waitingMs=Math.max(0,unionMs(waiting,from,end)-unionMs(waiting.flatMap(w=>executing.map(e=>({start:Math.max(w.start,e.start),end:Math.min(w.end,e.end)}))),from,end));
      const samples=input.samples.filter(s=>s.seatId===seat.id).sort((a,b)=>a.at.getTime()-b.at.getTime());
      const idle=samples.flatMap((s,i)=>s.ownerUserId===ownerId&&s.state==="idle"&&!s.taskId?[{start:s.at.getTime(),end:Math.min(s.through.getTime()+90000,samples[i+1]?.at.getTime()??end)}]:[]);
      const hasPresence=samples.some(s=>s.ownerUserId===ownerId&&s.at.getTime()<end&&s.through.getTime()+90000>from);
      const idleMs=filter.projectId||filter.domain||!hasPresence?null:Math.max(0,unionMs(idle,from,end)-unionMs(idle.flatMap(i=>[...executing,...waiting].map(b=>({start:Math.max(i.start,b.start),end:Math.min(i.end,b.end)}))),from,end));
      const currentOpen=rows.filter(r=>r.isLeaf&&r.seatId===seat.id&&r.ownerUserId===ownerId&&!terminal.has(r.status)&&(!filter.projectId||(filter.projectId==="__none__"?r.projectId===null:r.projectId===filter.projectId))).length;
      if(!own.length&&!ownFacts.length&&!currentOpen&&(filter.projectId||filter.domain||ownerId!==ownerOf(seat)))continue;
      // Historic owner windows must never claim unknown time for the entire
      // period on a device now assigned to someone else.
      const elapsed=unionMs(intervals,from,end);
      seats.push({seatId:seat.id,name:String((seat.adapterConfig.dsp7Seat as {name?:string})?.name??seat.name),ownerUserId:ownerId,ownerName:input.owners.find(o=>o.id===ownerId)?.name??null,currentOpen,started:ownFacts.filter(f=>f.kind==="started").length,delivered:ownFacts.filter(f=>f.kind==="delivered").length,cancelled:ownFacts.filter(f=>f.kind==="cancelled").length,runs:runIdsFor(own).length,executingMs,waitingMs,idleMs,unknownMs:Math.max(0,elapsed-executingMs-waitingMs),usage:sumDeliveryUsage(runIdsFor(own),costs),quality:qualityFor(ownFacts.filter(f=>f.kind==="delivered"),input.qualities,now)});
    }
  }
  const allRunIds=runIdsFor(selectedSessions),allLeaf=rows.filter(r=>r.isLeaf);
  return {methodologyVersion:"delivery-insights-v1",generatedAt:new Date(now).toISOString(),timezone:"Asia/Shanghai",from:new Date(from).toISOString(),to:new Date(to).toISOString(),simulatedExcluded:true,
    tasks:rows.slice((filter.page-1)*filter.pageSize,filter.page*filter.pageSize),totalTasks:rows.length,page:filter.page,pageSize:filter.pageSize,seats,
    totals:{currentOpen:allLeaf.filter(r=>!terminal.has(r.status)&&(!filter.ownerId||r.ownerUserId===filter.ownerId)&&(!filter.seatId||r.seatId===filter.seatId)&&(!filter.projectId||(filter.projectId==="__none__"?r.projectId===null:r.projectId===filter.projectId))).length,started:facts.filter(f=>f.kind==="started").length,delivered:facts.filter(f=>f.kind==="delivered").length,cancelled:facts.filter(f=>f.kind==="cancelled").length,usage:sumDeliveryUsage(allRunIds,costs)},
    options:{seats:input.seats.map(s=>({id:s.id,name:s.name})),owners:input.owners},
    completeness:{sessionsWithGaps:selectedSessions.filter(s=>s.coverage==="known_gap"||s.collectionPaused).length,tasksWithoutSessions:rows.filter(r=>!r.conversation.sessions).length,unclassifiedTasks:rows.filter(r=>r.domains.includes("unknown")).length,tracker:"not_integrated",confirmedDefectAttribution:"not_integrated"},
    notes:["当前在手按当前叶子任务去重；首次开始、交付及取消按所选期间的不可变业务事件计算。未采集事件不推定为已发生。","时间按 Asia/Shanghai 裁剪；同席位/负责人并行区间取并集，执行优先于等待。项目/领域筛选下，席位空闲无法可靠分配，显示未归属。历史运行按执行时负责人统计。","Token 按本期去重账本的计量事件时间统计；部分观测不等于完整用量，未知不显示为零。已知费用只汇总实际 reported 记录，未计价部分单列。","领域仅依据运行固定的 Harness 路由，旧运行无固定路由时显示未分类；项目/领域筛选不分摊缺少固定归属证据的历史事件，筛选结果可能少于全部。不会根据标题或聊天猜测。Tracker 领域工时尚未统一接入。","关联缺陷发生率沿用交付后14天观测窗口，展示成熟样本和覆盖分母；不是负责人确认归因后的编码 bug 率，后者尚未接入。"]};
}

export function acceptanceFor(snapshot:Row<typeof deliverySnapshots>):DeliveryAcceptance {
  const p=snapshot.plan;
  return {snapshotId:snapshot.id,demandNo:p.demandNo,title:p.title,sourceMode:p.sourceMode,collectedAt:snapshot.collectedAt.toISOString(),mainCount:p.mains.length,childCount:p.items.filter(i=>i.parentKey).length,differences:p.differences.length,readyForAcceptance:null,formalAcceptance:"unverified",sourceUrl:"https://proj.fingard.com:1888",
    checks:[{key:"scope",label:"条目及主子单范围",status:p.differences.length?"attention":"recorded",detail:`已记录 ${p.mains.length} 个主单、${p.items.filter(i=>i.parentKey).length} 个子单；${p.differences.length} 项结构差异。快照范围不等于执行授权。`},
      {key:"freshness",label:"来源新鲜度",status:p.sourceMode==="manual_snapshot"?"attention":"recorded",detail:p.sourceMode==="manual_snapshot"?"手工采集时间为上传人声明，需在正式来源核对最新版本。":"已保留在线读取时版本；不是持续同步，仍需核对当前版本。"},
      ...[["analysis","分析交接与正式需求评审"],["design","设计交付与人工评审"],["coding","编码交付及代码评审版本"],["build","待测构建与环境"],["testcases","测试用例与人工评审"],["qa","功能测试覆盖与结论"],["risk","缺陷归因与正式风险接受"],["tracker","Tracker 领域交付状态"],["acceptance","正式验收结论"]].map(([key,label])=>({key:key!,label:label!,status:"unverified" as const,detail:"尚未接入可核验的版本化正式证据；来源状态或平台完成不代替此项核验。"}))]};
}
