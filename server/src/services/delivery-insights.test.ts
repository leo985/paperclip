import { describe,expect,it } from "vitest";
import { acceptanceFor, buildDeliveryInsights,qualityFor,sumDeliveryUsage, type InsightsInput } from "./delivery-insights.js";
import { normalizeDeliverySnapshot } from "./delivery-intake.js";
import { fixture } from "./delivery-intake.fixture.js";
const at=(s:string)=>new Date(s),start=Date.parse("2026-10-01T00:00:00Z"),now=Date.parse("2026-10-25T00:00:00Z");
function data():InsightsInput{return {tasks:[{id:"task",companyId:"company",identifier:"T-1",title:"Task",projectId:"project",assigneeAgentId:"seat",status:"in_progress"}],seats:[{id:"seat",name:"Seat",createdAt:new Date(start),adapterConfig:{dsp7Seat:{ownerUserId:"owner"}}}],sessions:[{id:"session",taskId:"task",seatId:"seat",ownerUserId:"owner",runId:"run",startedAt:new Date(now-180000),endedAt:null,simulated:false,coverage:"from_start",finalizedAt:null,deletedAt:null}],events:[],facts:[],qualities:[],costs:[],bindings:[],permits:[{runId:"run",ledgerScope:{projectId:"project"},executionRoute:{capability:{kind:"analysis"}}}],samples:[],owners:[{id:"owner",name:"Owner"}],parentIds:[]} as unknown as InsightsInput;}
const filters={from:start,to:now+86400000,now,page:1,pageSize:25};
describe("delivery insights read models",()=>{
 it("keeps missing sessions/usage unknown, classifies only pinned routes and clips stale execution evidence",()=>{
   const d=data();d.events=[{id:"e",sessionId:"session",eventType:"execution",occurredAt:new Date(now-180000),observedAt:new Date(now-180000),payload:{state:"executing"}}];
   const r=buildDeliveryInsights(d,filters);expect(r.seats[0].idleMs).toBeNull();expect(r.tasks[0]).toMatchObject({domains:["analysis"],state:"unknown",executingMs:90000,unknownMs:90000,usage:{inputTokens:null,measuredRuns:0}});
   d.sessions=[];expect(buildDeliveryInsights(d,{...filters,domain:"unknown"}).tasks[0].state).toBe("not_observed");
 });
 it("unions concurrent sessions and deduplicates shared runs without counting parent deliveries twice",()=>{
   const d=data();d.sessions[0]!.endedAt=new Date(now);d.sessions.push({...d.sessions[0]!,id:"child"});
   d.events=d.sessions.map(s=>({id:s.id,sessionId:s.id,eventType:"execution",occurredAt:new Date(now-60000),observedAt:new Date(now-60000),payload:{state:"executing"}}));
   d.facts=[{taskId:"task",seatId:"seat",ownerUserId:"owner",kind:"delivered",at:new Date(now-1),simulated:false}] as any;
   const r=buildDeliveryInsights(d,filters);expect(r.seats[0]).toMatchObject({executingMs:60000,runs:1,delivered:1});expect(r.totals.usage.runs).toBe(1);
   d.parentIds=["task"];expect(buildDeliveryInsights(d,filters).totals.delivered).toBe(0);
 });
 it("preserves historical project and owner attribution after reassignment",()=>{
   const d=data();d.tasks[0]!.projectId="new-project";(d.seats[0]!.adapterConfig.dsp7Seat as any).ownerUserId="new-owner";
   d.facts=[{taskId:"task",seatId:"seat",ownerUserId:"owner",kind:"started",at:new Date(now-100000),simulated:false}] as any;
   const r=buildDeliveryInsights(d,{...filters,projectId:"project",ownerId:"owner"});expect(r.totals.started).toBe(1);expect(r.totals.currentOpen).toBe(0);expect(r.seats[0]!.idleMs).toBeNull();expect(r.seats[0]!.ownerUserId).toBe("owner");
   const next=buildDeliveryInsights(d,{...filters,projectId:"new-project"});expect(next.totals.started).toBe(0);expect(next.totals.usage.runs).toBe(0);
 });
 it("keeps totals independent of task pagination and excludes simulated events",()=>{
   const d=data();d.tasks.push({...d.tasks[0]!,id:"other"});d.facts=[{taskId:"task",seatId:"seat",ownerUserId:"owner",kind:"delivered",at:new Date(now-1),simulated:true}] as any;
   const r=buildDeliveryInsights(d,{...filters,pageSize:1});expect(r.tasks).toHaveLength(1);expect(r.totalTasks).toBe(2);expect(r.totals.currentOpen).toBe(2);expect(r.totals.delivered).toBe(0);
 });
 it("prefers a still-active session to a more recent completed one",()=>{
   const d=data();d.sessions.push({...d.sessions[0]!,id:"later",startedAt:new Date(now-60000),endedAt:new Date(now-10000)});
   d.events=[{id:"e",sessionId:"session",eventType:"execution",occurredAt:new Date(now-1000),observedAt:new Date(now-1000),payload:{state:"waiting"}}];
   expect(buildDeliveryInsights(d,filters).tasks[0].state).toBe("waiting");
 });
 it("uses ledger deltas once; partial and unpriced remain explicit",()=>{
   const costs=[{heartbeatRunId:"run",idempotencyKey:"heartbeat-observed-run-1",inputTokens:100,outputTokens:10,cachedInputTokens:5,costStatus:"unpriced",costCents:0},{heartbeatRunId:"run",idempotencyKey:"heartbeat-final-run",inputTokens:50,outputTokens:2,cachedInputTokens:0,costStatus:"unpriced",costCents:0}] as InsightsInput["costs"];
   expect(sumDeliveryUsage(["run","run","missing"],costs)).toMatchObject({runs:2,measuredRuns:1,finalRuns:1,inputTokens:150,outputTokens:12,cachedInputTokens:5,reportedCostCents:null,unpricedRuns:2});
 });
 it("exposes actual quality denominators and excludes pre-delivery or out-of-window bugs",()=>{
   const delivered=at("2026-10-01T00:00:00Z");
   const facts=["a","b","c"].map(taskId=>({taskId,seatId:"seat",ownerUserId:"owner",at:delivered})) as InsightsInput["facts"];
   const qualities=[{taskId:"a",seatId:"seat",ownerUserId:"owner",windowDays:14,observedAt:at("2026-10-20T00:00:00Z"),defects:[{key:"BUG-1",createdAt:"2026-10-02T00:00:00Z"},{key:"OLD",createdAt:"2026-09-30T00:00:00Z"},{key:"LATE",createdAt:"2026-10-18T00:00:00Z"}]},{taskId:"b",seatId:"seat",ownerUserId:"owner",windowDays:14,observedAt:at("2026-10-20T00:00:00Z"),defects:[]}] as InsightsInput["qualities"];
   expect(qualityFor(facts,qualities,now)).toEqual({linkedDefects:1,matureEligible:3,measuredMature:2,affectedMature:1,observedDefectRate:0.5,coverage:2/3,attributedBugRate:null});
 });
 it("never promotes source completed statuses to formal acceptance",()=>{
   const p=normalizeDeliverySnapshot(fixture());const a=acceptanceFor({id:"snapshot",collectedAt:new Date(now),plan:p} as any);
   expect(a.formalAcceptance).toBe("unverified");expect(a.readyForAcceptance).toBeNull();expect(a.checks.find(c=>c.key==="coding")!.status).toBe("unverified");
 });
});
