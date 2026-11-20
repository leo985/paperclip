import express from "express";
import request from "supertest";
import { describe, expect, it } from "vitest";
import type { Db } from "@paperclipai/db";
import { harnessCapabilityRoutes } from "./harness-capabilities.js";
const companyId="11111111-1111-4111-8111-111111111111",agentId="22222222-2222-4222-8222-222222222222",machineId="33333333-3333-4333-8333-333333333333";
const capability={kind:"analysis",repository:"git.example.com/team/analysis",root:"/local/analysis",profile:"dsp",commit:"a".repeat(40),manifestDigest:"b".repeat(64),roles:["requirements-analysis"],protocolVersion:1};
const input={seat_id:agentId,machine_id:machineId,machine_fingerprint:"c".repeat(64),expectedRevision:0,capability};
const agent={id:agentId,companyId,status:"idle",adapterConfig:{dsp7Seat:{machineId,machineFingerprint:"c".repeat(64)},legacySetting:"preserve"}};
function fixture(results:unknown[][],actor:Record<string,unknown>={type:"agent",source:"agent_key",agentId,companyId}){
 const writes:any[]=[];const db={select:()=>{const value=results.shift();const c:any={then:(r:any,j:any)=>Promise.resolve(value).then(r,j)};for(const n of ["from","where","for"])c[n]=()=>c;return c;},execute:async()=>{},transaction:async(fn:any)=>fn(db),update:()=>({set:(v:any)=>({where:async()=>{writes.push(v);}})}),insert:()=>({values:async(v:any)=>{writes.push(v);}})};
 const app=express();app.use(express.json());app.use((req,_res,next)=>{Object.assign(req,{actor});next();});app.use(harnessCapabilityRoutes(db as unknown as Db));app.use((e:any,_req:any,res:any,_next:any)=>res.status(e.status??500).json({error:e.message}));return {app,writes};
}
describe("machine bound Harness capabilities",()=>{
 const url=`/agents/${agentId}/dsp7-harness-capabilities`;
 it("backfills default development capabilities only at the machine's enrolled runtime root",async()=>{
  const development={...capability,kind:"development",profile:"default",root:"D:\\harness\\base",roles:["coding","system-design"]};
  const enrolled={...agent,defaultEnvironmentId:"env",adapterConfig:{...agent.adapterConfig,dsp7SeatRuntime:{harnessRoot:development.root,environmentId:"env"}}};
  const f=fixture([[enrolled],[]]);
  const r=await request(f.app).post(url).send({...input,automatic:true,capability:development});
  expect(r.status).toBe(200);expect(r.body.revision).toBe(1);
  expect(f.writes[1].details).toMatchObject({automatic:true,initialDevelopment:true,executionGranted:false});
  for(const change of [{root:"D:\\other"},{kind:"analysis",roles:["requirements-analysis"]},{profile:"other"}]){
   const denied=fixture([[enrolled]]);
   expect((await request(denied.app).post(url).send({...input,automatic:true,capability:{...development,...change}})).status).toBe(409);
   expect(denied.writes).toHaveLength(0);
  }
  const busy=fixture([[enrolled],[{id:"running"}]]);
  expect((await request(busy.app).post(url).send({...input,automatic:true,capability:development})).status).toBe(409);
  expect(busy.writes).toHaveLength(0);
  const current={...enrolled,adapterConfig:{...enrolled.adapterConfig,dsp7HarnessCapabilities:r.body}};
  const replacement=fixture([[current]]);
  expect((await request(replacement.app).post(url).send({...input,expectedRevision:1,automatic:true,capability:{...development,repository:"git.example.com/team/other"}})).status).toBe(409);
  const wrongEnv=fixture([[{...enrolled,defaultEnvironmentId:"other"}]]);
  expect((await request(wrongEnv.app).post(url).send({...input,automatic:true,capability:development})).status).toBe(409);
 });
 it("automatically refreshes only enrolled content and audits the old and new fingerprints",async()=>{
  const first=fixture([[agent],[]]);const registry=(await request(first.app).post(url).send(input)).body;
  const current={...agent,adapterConfig:{...agent.adapterConfig,dsp7HarnessCapabilities:registry}};
  const updated={...capability,commit:"d".repeat(40),manifestDigest:"e".repeat(64)};
  const f=fixture([[current],[]]);const r=await request(f.app).post(url).send({...input,expectedRevision:1,automatic:true,capability:updated});
  expect(r.status).toBe(200);expect(r.body.revision).toBe(2);
  expect(f.writes[1].details).toMatchObject({automatic:true,previousCommit:capability.commit,commit:updated.commit,previousManifestDigest:capability.manifestDigest,manifestDigest:updated.manifestDigest,executionGranted:false});
  for(const change of [{root:"/other"},{repository:"git.example.com/team/other"},{profile:"other"},{roles:["coding"],kind:"development"}]){
   const denied=fixture([[current]]);expect((await request(denied.app).post(url).send({...input,expectedRevision:1,automatic:true,capability:{...updated,...change}})).status).toBe(409);expect(denied.writes).toHaveLength(0);
  }
  const missing=fixture([[agent]]);expect((await request(missing.app).post(url).send({...input,automatic:true})).status).toBe(409);expect(missing.writes).toHaveLength(0);
  const busy=fixture([[current],[{id:"running"}]]);expect((await request(busy.app).post(url).send({...input,expectedRevision:1,automatic:true,capability:updated})).status).toBe(409);expect(busy.writes).toHaveLength(0);
 });
 it("cannot be registered by board users or other machines",async()=>{
  const board=fixture([],{type:"board",source:"local_implicit"});expect((await request(board.app).post(url).send(input)).status).toBe(403);
  const other=fixture([{...agent,adapterConfig:{dsp7Seat:{machineId:"different"}}} as any].map(x=>[x]));expect((await request(other.app).post(url).send(input)).status).toBe(403);expect(other.writes).toHaveLength(0);
 });
 it("preserves legacy execution configuration and does not grant execution",async()=>{
  const f=fixture([[agent],[]]);const r=await request(f.app).post(url).send(input);expect(r.status).toBe(200);expect(r.body).toMatchObject({version:1,revision:1,items:[{kind:"analysis",executionReady:false,validation:"local-files"}]});expect(f.writes[0].adapterConfig.legacySetting).toBe("preserve");expect(f.writes[1].details.executionGranted).toBe(false);
 });
 it("rejects changed registry revision, active executions and invalid roles",async()=>{
  const stale=fixture([[agent]]);expect((await request(stale.app).post(url).send({...input,expectedRevision:5})).status).toBe(409);
  const busy=fixture([[agent],[{id:"running"}]]);expect((await request(busy.app).post(url).send(input)).status).toBe(409);expect(busy.writes).toHaveLength(0);
  const wrong=fixture([]);expect((await request(wrong.app).post(url).send({...input,capability:{...capability,roles:["coding"]}})).status).toBe(400);
 });
 it("refreshes unchanged inspection during a run without changing revision or granting authority",async()=>{
  const first=fixture([[agent],[]]);
  const registered=(await request(first.app).post(`/agents/${agentId}/dsp7-harness-capabilities`).send(input)).body;
  const current={...agent,adapterConfig:{...agent.adapterConfig,dsp7HarnessCapabilities:registered}};
  const same=fixture([[current]]);
  const response=await request(same.app).post(url).send({...input,expectedRevision:1});
  expect(response.status).toBe(200);expect(response.body.revision).toBe(1);
  expect(response.body.items[0].executionReady).toBe(false);expect(same.writes).toHaveLength(1);
 });
 it("blocks metadata changes while the online machine is waiting for a decision",async()=>{
  const waiting={...agent,adapterConfig:{...agent.adapterConfig,dsp7SeatPresence:{state:"waiting_decision",lastSeenAt:new Date().toISOString()}}};
  const f=fixture([[waiting],[]]);expect((await request(f.app).post(url).send(input)).status).toBe(409);expect(f.writes).toHaveLength(0);
 });
 it("rejects delegated run keys and unrelated agent keys",async()=>{
  for(const actor of [{type:"agent",source:"agent_key",agentId,companyId,keyScope:{kind:"run"}},{type:"agent",source:"agent_key",agentId:machineId,companyId}]){
   const f=fixture([],actor);expect((await request(f.app).post(url).send(input)).status).toBe(403);expect(f.writes).toHaveLength(0);
  }
 });
 it("rejects token-bearing repository URLs",async()=>{
  const f=fixture([]);expect((await request(f.app).post(url).send({...input,capability:{...capability,repository:"https://user:secret@git.example.com/team/a"}})).status).toBe(400);
 });
});

const postgres = await import("../__tests__/helpers/embedded-postgres.js");
const support = await postgres.getEmbeddedPostgresTestSupport();
(support.supported ? describe : describe.skip)("Harness registry database concurrency", () => {
 it("serializes machine registration revisions and preserves active execution metadata", async()=>{
  const {randomUUID}=await import("node:crypto");
  const {agents,companies,heartbeatRuns,createDb}=await import("@paperclipai/db");
  const {eq}=await import("drizzle-orm");
  const temp=await postgres.startEmbeddedPostgresTestDatabase("harness-registry-");
  try{
   const db=createDb(temp.connectionString),cid=randomUUID(),aid=randomUUID(),mid=randomUUID();
   await db.insert(companies).values({id:cid,name:"Capabilities",issuePrefix:`H${cid.slice(0,6)}`});
   await db.insert(agents).values({id:aid,companyId:cid,name:"Seat",role:"engineer",adapterType:"claude_local",adapterConfig:{dsp7Seat:{machineId:mid,machineFingerprint:"c".repeat(64)},legacySetting:"preserve"}});
   const app=express();app.use(express.json());app.use((req,_res,next)=>{Object.assign(req,{actor:{type:"agent",source:"agent_key",agentId:aid,companyId:cid}});next();});app.use(harnessCapabilityRoutes(db));app.use((e:any,_req:any,res:any,_next:any)=>res.status(e.status??500).json({error:e.message}));
   const endpoint=`/agents/${aid}/dsp7-harness-capabilities`;
   const body={...input,seat_id:aid,machine_id:mid};
   const responses=await Promise.all([request(app).post(endpoint).send(body),request(app).post(endpoint).send({...body,capability:{...capability,profile:"other"}})]);
   expect(responses.map(r=>r.status).sort()).toEqual([200,409]);
   const registered=responses.find(r=>r.status===200)!.body;
   const [stored]=await db.select().from(agents).where(eq(agents.id,aid));
   expect(stored!.adapterConfig.legacySetting).toBe("preserve");
   expect(registered.items).toHaveLength(1);expect(registered.revision).toBe(1);
   await db.insert(heartbeatRuns).values({companyId:cid,agentId:aid,status:"running"});
   const {id:_id,checkedAt:_at,validation:_validation,executionReady:_ready,...same}=registered.items[0];
   expect((await request(app).post(endpoint).send({...body,expectedRevision:1,capability:same})).status).toBe(200);
   const denied=await request(app).post(endpoint).send({...body,expectedRevision:1,capability:{...same,commit:"d".repeat(40)}});
   expect(denied.status).toBe(409);
   const read=await request(app).get(endpoint);expect(read.body.revision).toBe(1);expect(read.body.items[0].executionReady).toBe(false);
  }finally{await temp.cleanup();}
 },20_000);
 it("lets the owner choose a registered domain route, refusing stale, active or unauthorized changes",async()=>{
  const first=fixture([[agent],[]]);const registered=(await request(first.app).post(`/agents/${agentId}/dsp7-harness-capabilities`).send(input)).body;
  const current={...agent,adapterConfig:{...agent.adapterConfig,dsp7Seat:{...agent.adapterConfig.dsp7Seat,ownerUserId:"owner"},dsp7HarnessCapabilities:registered}};
  const route=`/companies/${companyId}/dsp7-seats/${agentId}/harness-routing`;
  const body={expectedRevision:1,kind:"analysis",capabilityId:registered.items[0].id};
  const owner={type:"board",source:"session",userId:"owner",companyIds:[companyId],memberships:[{companyId,status:"active",membershipRole:"member"}]};
  const allowed=fixture([[current],[]],owner);const result=await request(allowed.app).put(route).send(body);expect(result.status).toBe(200);expect(result.body.routing.analysis).toBe(body.capabilityId);expect(result.body.revision).toBe(2);expect(allowed.writes[1].details.executionGranted).toBe(false);
  const denied=fixture([[current]],{...owner,userId:"other"});expect((await request(denied.app).put(route).send(body)).status).toBe(403);
  const busy=fixture([[current],[{id:"active"}]],owner);expect((await request(busy.app).put(route).send(body)).status).toBe(409);
  const stale=fixture([[current]],owner);expect((await request(stale.app).put(route).send({...body,expectedRevision:0})).status).toBe(409);
  const wrong=fixture([[current]],owner);expect((await request(wrong.app).put(route).send({...body,kind:"qa"})).status).toBe(409);
  const cross=fixture([],{...owner,companyIds:[]});expect((await request(cross.app).put(route).send(body)).status).toBe(403);
 });

});
