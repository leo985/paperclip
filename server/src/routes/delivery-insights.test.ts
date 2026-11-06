import {randomUUID} from "node:crypto";
import express from "express";
import request from "supertest";
import {beforeAll,afterAll,describe,expect,it} from "vitest";
import {createDb,companies,agents,issues,heartbeatRuns,managedSessions,managedEvents,projects,deliverySnapshots} from "@paperclipai/db";
import {deliveryInsightsRoutes} from "./delivery-insights.js";
import {getEmbeddedPostgresTestSupport,startEmbeddedPostgresTestDatabase} from "../__tests__/helpers/embedded-postgres.js";
import {fixture} from "../services/delivery-intake.fixture.js";
import {normalizeDeliverySnapshot} from "../services/delivery-intake.js";
const support=await getEmbeddedPostgresTestSupport();
(support.supported?describe:describe.skip)("delivery insights database authorization",()=>{
 let database:Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>,db:ReturnType<typeof createDb>;
 const cid=randomUUID(),other=randomUUID(),pid=randomUUID(),sid=randomUUID(),tid=randomUUID(),run=randomUUID(),session=randomUUID();
 function appFor(role="member",userId="owner",companyIds=[cid]){
  const app=express();app.use(express.json());app.use((req,_res,next)=>{req.actor={type:"board",source:"session",userId,companyIds,memberships:[{companyId:cid,membershipRole:role,status:"active"}]} as any;next();});app.use(deliveryInsightsRoutes(db));app.use((e:any,_req:any,res:any,_next:any)=>res.status(e.status??500).json({error:e.message}));return app;
 }
 beforeAll(async()=>{
  database=await startEmbeddedPostgresTestDatabase("delivery-insights-");db=createDb(database.connectionString);
  await db.insert(companies).values([{id:cid,name:"Insights",issuePrefix:"T"+cid.slice(0,6)},{id:other,name:"Other",issuePrefix:"T"+other.slice(0,6)}]);
  await db.insert(projects).values({id:pid,companyId:cid,name:"Project"});
  await db.insert(agents).values({id:sid,companyId:cid,name:"Seat",role:"engineer",adapterType:"claude_local",adapterConfig:{dsp7WebJiraIntake:true,dsp7Seat:{ownerUserId:"owner"},env:{API_KEY:"private-secret-not-for-report"}}});
  await db.insert(issues).values({id:tid,companyId:cid,title:"Observable task",projectId:pid,assigneeAgentId:sid,status:"in_progress"});
  await db.insert(heartbeatRuns).values({id:run,companyId:cid,agentId:sid,status:"failed",startedAt:new Date(),finishedAt:new Date()});
  await db.insert(managedSessions).values({id:session,companyId:cid,taskId:tid,seatId:sid,runId:run,nativeSessionId:randomUUID(),machineId:randomUUID(),machineFingerprint:"a".repeat(64),ownerUserId:"owner",endedAt:new Date()});
  await db.insert(managedEvents).values({companyId:cid,sessionId:session,eventId:randomUUID(),streamId:"main",sequence:1,eventType:"content.part",occurredAt:new Date(),observedAt:new Date(),sourceGeneration:"1",sourceOffset:0,digest:"fixture",payload:{data:"private-conversation-body"}});
  const p=normalizeDeliverySnapshot(fixture());await db.insert(deliverySnapshots).values({companyId:cid,projectId:pid,sourceOrigin:fixture().sourceOrigin,demandNo:p.demandNo,fingerprint:p.fingerprint,collectedAt:new Date(),createdByUserId:"owner",plan:p});
 },30000);
 afterAll(async()=>{await database?.cleanup();});
 it("returns only the execution owner's sessions and never bodies or adapter credentials",async()=>{
  const r=await request(appFor()).get(`/companies/${cid}/delivery-insights?scope=company`);expect(r.status).toBe(200);expect(r.body.tasks[0].conversation.sessions).toBe(1);expect(JSON.stringify(r.body)).not.toContain("private-conversation-body");expect(JSON.stringify(r.body)).not.toContain("private-secret");
  const otherUser=await request(appFor("member","different")).get(`/companies/${cid}/delivery-insights?scope=company`);expect(otherUser.status).toBe(200);expect(otherUser.body.tasks).toEqual([]);
 });
 it("allows a manager to view organization data but rejects cross-company and impersonated scopes",async()=>{
  expect((await request(appFor("admin","admin")).get(`/companies/${cid}/delivery-insights?scope=company`)).body.tasks).toHaveLength(1);
  expect((await request(appFor()).get(`/companies/${other}/delivery-insights`)).status).toBe(403);
  expect((await request(appFor()).get(`/companies/${cid}/delivery-insights?ownerId=other-user`)).status).toBe(403);
  expect((await request(appFor()).get(`/companies/${cid}/delivery-insights?projectId=${randomUUID()}`)).status).toBe(403);
 });
 it("validates calendar boundaries, pages and report periods",async()=>{
  for(const query of ["date=2026-02-30","period=invalid","page=0"]){expect((await request(appFor()).get(`/companies/${cid}/delivery-insights?${query}`)).status).toBe(400);}
  for(const period of ["day","week","month","quarter","year"]){const r=await request(appFor()).get(`/companies/${cid}/delivery-insights?period=${period}`);expect(r.status).toBe(200);expect(r.body.methodologyVersion).toBe("delivery-insights-v1");}
 });
 it("keeps acceptance source-version scoped and unverified",async()=>{
  const r=await request(appFor()).get(`/companies/${cid}/delivery-insights/acceptance?projectId=${pid}`);expect(r.status).toBe(200);expect(r.body.items[0]).toMatchObject({formalAcceptance:"unverified",readyForAcceptance:null});
  expect((await request(appFor()).get(`/companies/${other}/delivery-insights/acceptance?projectId=${pid}`)).status).toBe(403);
 });
});
