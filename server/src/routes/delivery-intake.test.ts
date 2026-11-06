import express from "express";
import request from "supertest";
import { describe, expect, it } from "vitest";
import type { Db } from "@paperclipai/db";
import { deliveryIntakeRoutes } from "./delivery-intake.js";
import { normalizeDeliverySnapshot } from "../services/delivery-intake.js";
import { fixture } from "../services/delivery-intake.fixture.js";
const companyId="11111111-1111-4111-8111-111111111111";
function appFor(results:unknown[][],actor:Record<string,unknown>={type:"board",source:"local_implicit",userId:"admin"}){
 const writes:unknown[]=[];const db={select:()=>{const value=results.shift();const c:any={then:(r:any,j:any)=>Promise.resolve(value).then(r,j)};for(const n of ["from","where","orderBy","limit","offset","for","leftJoin"])c[n]=()=>c;return c;},execute:async()=>{},transaction:async(fn:any)=>fn(db),insert:()=>({values:(v:any)=>{writes.push(v);return {returning:async()=>[{...v,id:"saved"}],then:(r:any)=>Promise.resolve().then(r)};}})};
 const app=express();app.use(express.json({limit:"2mb"}));app.use((req,_res,next)=>{Object.assign(req,{actor});next();});app.use(deliveryIntakeRoutes(db as unknown as Db));app.use((e:any,_req:any,res:any,_next:any)=>res.status(e.status??500).json({error:e.message}));return {app,writes};
}
describe("read-only delivery routes",()=>{
 const base=`/companies/${companyId}/delivery-intake`;
 it("lists distinct latest entries with validated filters and no writes",async()=>{
   const rows=Array.from({length:21},(_,i)=>({id:String(i)}));
   const ok=appFor([rows]);const r=await request(ok.app).get(base+"/entries?q=ATS3&attention=differences");
   expect(r.status).toBe(200);expect(r.body.items).toHaveLength(20);expect(r.body.hasMore).toBe(true);expect(ok.writes).toEqual([]);
   for(const query of ["page=0","projectId=invalid","attention=unknown","extra=1"]){expect((await request(appFor([]).app).get(base+"/entries?"+query)).status).toBe(400);}
 });
 it("blocks anonymous, agent and cross-company access to entry reads",async()=>{
   for(const actor of [{type:"none"},{type:"agent",companyId},{type:"board",source:"session",companyIds:[]}]){
     for(const path of ["/entries","/entries/22222222-2222-4222-8222-222222222222"]){const denied=appFor([],actor);expect([401,403]).toContain((await request(denied.app).get(base+path)).status);expect(denied.writes).toEqual([]);}
   }
 });
 it("only associates registered Jira identities and keeps analysis, business and run states separate",async()=>{
   const input=fixture(),plan=normalizeDeliverySnapshot(input),snapshotId="22222222-2222-4222-8222-222222222222";
   const snapshot={id:snapshotId,projectId:input.projectId,demandNo:plan.demandNo,plan};
   const task={id:"task",title:"title",status:"done",runStatus:"running",description:'<!-- DSP7-JIRA-INTAKE '+JSON.stringify({project_id:input.projectId,jira_key:"ATSES-2"})+' -->'};
   const ok=appFor([[snapshot],[{id:input.projectId}],[{id:"analysis",state:"waiting"}],[task,{...task,id:"wrong-project",description:task.description.replace(input.projectId,companyId)},{...task,id:"bad-json",description:"<!-- DSP7-JIRA-INTAKE broken -->"}],[],[],[]]);
   const r=await request(ok.app).get(base+"/entries/"+snapshotId);expect(r.status).toBe(200);expect(r.body.tasks).toEqual([expect.objectContaining({id:"task",jiraKey:"ATSES-2",status:"done",runStatus:"running"})]);expect(r.body.tasks[0]).not.toHaveProperty("description");expect(r.body.analyses[0].state).toBe("waiting");expect(ok.writes).toEqual([]);
   expect((await request(appFor([[]]).app).get(base+"/entries/"+snapshotId)).status).toBe(404);
 });
 it("records comparison notes as audit only and refuses unauthorized writes",async()=>{
   const baselineId="22222222-2222-4222-8222-222222222222",snapshotId="33333333-3333-4333-8333-333333333333";
   const plan=normalizeDeliverySnapshot(fixture()),row={id:baselineId,companyId,projectId:fixture().projectId,sourceOrigin:fixture().sourceOrigin,demandNo:plan.demandNo,fingerprint:plan.fingerprint,plan};
   const ok=appFor([[row],[{...row,id:snapshotId}],[{id:row.projectId}]]);
   const r=await request(ok.app).post(`${base}/${snapshotId}/comparison-note`).send({baselineId,note:"核对后保留原执行授权范围"});
   expect(r.status).toBe(200);expect(r.body).toMatchObject({recorded:true,executionAllowed:false,formalApproval:false});expect(ok.writes).toEqual([expect.objectContaining({action:"delivery.comparison.noted",details:expect.objectContaining({baselineId,snapshotId,formalApproval:false})})]);
   const denied=appFor([],{type:"board",source:"session",companyIds:[companyId],memberships:[]});expect((await request(denied.app).post(`${base}/${snapshotId}/comparison-note`).send({baselineId,note:"test"})).status).toBe(403);expect(denied.writes).toEqual([]);
   const missing=appFor([]);expect((await request(missing.app).post(`${base}/${snapshotId}/comparison-note`).send({baselineId,note:" "})).status).toBe(400);expect(missing.writes).toEqual([]);
 });
 it("compares authorized versions without writes and rejects mixed scopes",async()=>{
   const baselineId="22222222-2222-4222-8222-222222222222",snapshotId="33333333-3333-4333-8333-333333333333";
   const plan=normalizeDeliverySnapshot(fixture());const row={id:baselineId,companyId,projectId:fixture().projectId,sourceOrigin:fixture().sourceOrigin,demandNo:plan.demandNo,collectedAt:new Date(),plan};
   const next={...row,id:snapshotId,plan:{...plan,status:"changed"}};
   const ok=appFor([[row],[next],[{id:row.projectId}]]);const r=await request(ok.app).get(`${base}/${snapshotId}/compare?baselineId=${baselineId}`);
   expect(r.status).toBe(200);expect(r.body.changes).toEqual([expect.objectContaining({field:"status",after:"changed"})]);expect(ok.writes).toEqual([]);
   const mixed=appFor([[row],[{...next,demandNo:"OTHER-1"}],[{id:row.projectId}]]);expect((await request(mixed.app).get(`${base}/${snapshotId}/compare?baselineId=${baselineId}`)).status).toBe(409);
   const inaccessible=appFor([[]]);expect((await request(inaccessible.app).get(`${base}/${snapshotId}/compare?baselineId=${baselineId}`)).status).toBe(404);
 });
 it("denies agent and cross-company access before reading",async()=>{
   for(const actor of [{type:"agent",companyId},{type:"board",source:"session",companyIds:[]}]){const {app,writes}=appFor([],actor);expect((await request(app).get(base+"?projectId="+fixture().projectId)).status).toBe(403);expect(writes).toEqual([]);}
 });
 it("requires manager for preview and validates project ownership",async()=>{
   const {app}=appFor([],{type:"board",source:"session",companyIds:[companyId],memberships:[]});expect((await request(app).post(base+"/preview").send(fixture())).status).toBe(403);
   const denied=appFor([[]]);expect((await request(denied.app).post(base+"/preview").send(fixture())).status).toBe(403);
 });
 it("previews without writes or execution",async()=>{
   const {app,writes}=appFor([[{id:fixture().projectId}]]);const r=await request(app).post(base+"/preview").send(fixture());expect(r.status).toBe(200);expect(r.body.executionAllowed).toBe(false);expect(writes).toEqual([]);
 });
 it("rejects changed input before saving",async()=>{
   const {app,writes}=appFor([]);expect((await request(app).post(base+"/import").send({...fixture(),fingerprint:"0".repeat(64)})).status).toBe(409);expect(writes).toEqual([]);
 });
 it("reuses duplicates and audits new snapshots without dispatch",async()=>{
   const input=fixture(),fingerprint=normalizeDeliverySnapshot(input).fingerprint;
   const prior=appFor([[{id:input.projectId}],[{id:"prior"}]]);const r=await request(prior.app).post(base+"/import").send({...input,fingerprint});expect(r.body.existing).toBe(true);expect(prior.writes).toEqual([]);
   const fresh=appFor([[{id:input.projectId}],[]]);const saved=await request(fresh.app).post(base+"/import").send({...input,fingerprint});expect(saved.status).toBe(200);expect(fresh.writes).toHaveLength(2);expect(fresh.writes[1]).toMatchObject({action:"delivery.snapshot.imported",details:{executionGranted:false}});
 });
});
