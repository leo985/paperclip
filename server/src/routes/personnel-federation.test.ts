import express from "express";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";
import { getTableName } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { personnelFederationRoutes } from "./personnel-federation.js";
import { errorHandler } from "../middleware/index.js";
const initialize = vi.hoisted(()=>vi.fn(async()=>({initialized:0})));
vi.mock("../services/personnel-directory.js",()=>({personnelDirectoryService:()=>({sync:vi.fn(),initializePasswords:initialize})}));
vi.mock("../services/secrets.js",()=>({secretService:()=>({})}));
const company="10000000-0000-4000-8000-000000000001";
const personId="20000000-0000-4000-8000-000000000001";
const sourceId="30000000-0000-4000-8000-000000000001";
function fixture(results:unknown[][], admin=true){
 const writes:Array<{table:string;value:any}>=[];
 const filters:unknown[]=[];
 const db:any={
  select:()=>{const result=results.shift();if(!result)throw Error("Unexpected query");const q:any={then:(yes:any,no:any)=>Promise.resolve(result).then(yes,no)};for(const name of ["from","for","limit"])q[name]=()=>q;q.where=(v:unknown)=>{filters.push(v);return q;};return q;},
  insert:(table:any)=>({values:(value:any)=>{writes.push({table:getTableName(table),value});return {onConflictDoNothing:async()=>{}};}}),
  update:(table:any)=>({set:(value:any)=>({where:async()=>{writes.push({table:getTableName(table),value});}})}),
  execute:async()=>{},transaction:async(fn:any)=>fn(db),
 };
 const app=express();app.use(express.json());app.use((req,_res,next)=>{req.actor={type:"board",source:"session",userId:"admin",isInstanceAdmin:admin,companyIds:[company],memberships:[]};next();});app.use(personnelFederationRoutes(db as Db));app.use(errorHandler);
 return {app,writes,filters};
}
describe("instance personnel directory",()=>{
 it("rejects company administrators without instance authority",async()=>{
  const {app}=fixture([],false);expect((await request(app).get("/instance/personnel-federation")).status).toBe(403);
 });
 it("reuses existing directory rows from all organizations without exposing secrets",async()=>{
  const {app,filters}=fixture([[{id:sourceId,companyId:company,secretId:"secret",leaseUntil:null}],[{id:personId,companyId:"other",activationHash:"private",activationExpires:new Date(),userId:"member"}],[{userId:"member"}],[{id:"member"}],[]]);
  const response=await request(app).get("/instance/personnel-federation");expect(response.status).toBe(200);expect(response.body.people[0]).toMatchObject({id:personId,companyId:"other",loginConfigured:true});expect(JSON.stringify(response.body)).not.toContain("activationHash");expect(response.body.sources[0].secretId).toBeUndefined();expect(filters).toHaveLength(2);
 });
 it("prevents creating the same enterprise again from another organization",async()=>{
  const {app,writes}=fixture([[{id:sourceId}]]);
  const response=await request(app).post("/instance/personnel-federation").send({auditCompanyId:company,type:"DingTalk",name:"Duplicate",corpId:"corp",appKey:"app",syncScope:"1",enabled:true,autoSync:false,syncInterval:3600});
  expect(response.status).toBe(409);expect(writes).toEqual([]);
 });
 it("explicitly adds an existing shared identity as an ordinary member",async()=>{
  const {app,writes}=fixture([[{id:company}],[{id:personId,companyId:"legacy-origin",active:true,userId:"member",sourceId}],[{id:sourceId,enabled:true}],[]]);
  const response=await request(app).post(`/instance/personnel-federation/people/${personId}/membership`).send({companyId:company});
  expect(response.status).toBe(200);expect(writes.find(w=>w.table==="company_memberships")?.value).toMatchObject({companyId:company,principalId:"member",status:"active",membershipRole:"operator"});expect(writes.find(w=>w.table==="activity_log")?.value.action).toBe("personnel.membership.added");
 });
 it("preserves an existing administrator role and does not reactivate suspended members",async()=>{
  for(const status of ["active","inactive"]){
   const {app,writes}=fixture([[{id:company}],[{id:personId,active:true,userId:"member",sourceId}],[{id:sourceId,enabled:true}],[{status,membershipRole:"admin"}]]);
   const response=await request(app).post(`/instance/personnel-federation/people/${personId}/membership`).send({companyId:company});expect(response.status).toBe(status==="active"?200:409);expect(writes).toEqual([]);
  }
 });
});

describe("repair generated personnel account links",()=>{
 const person={id:personId,sourceId,companyId:company,userId:"generated",managedAccount:true,active:true};
 const source={id:sourceId,type:"DingTalk",corpId:"corp",enabled:true,leaseUntil:null};
 const body={userId:"original",expectedUserId:"generated",reason:"已核对同一人的原账号及席位",confirm:true};
 const url=`/instance/personnel-federation/people/${personId}/relink`;
 it("requires instance administrator authority and explicit confirmation",async()=>{
  expect((await request(fixture([],false).app).post(url).send(body)).status).toBe(403);
  expect((await request(fixture([]).app).post(url).send({...body,confirm:false})).status).toBe(400);
 });
 it("repairs an initialized duplicate without transferring memberships or seats",async()=>{
  const {app,writes}=fixture([[person],[source],[person],[],[{id:"original"}],[{id:"credential"}],[{id:sourceId}],[]]);
  expect((await request(app).post(url).send(body)).status).toBe(200);
  expect(writes.map(w=>w.table)).toEqual(["account","personnel_people","activity_log"]);
  expect(writes[0].value.password).toBeNull();
  expect(writes[1].value).toMatchObject({userId:"original",managedAccount:false,requirePasswordChange:false,activationHash:null});
  expect(writes[2].value).toMatchObject({action:"personnel.account.relinked",details:{previousUserId:"generated",userId:"original",reason:body.reason,accessTransferred:false}});
 });
 it("rejects stale forms, manual bindings, missing people and paused or syncing sources",async()=>{
  for(const rows of [[[]],[[person],[]],[[person],[{...source,enabled:false}]],[[person],[{...source,leaseUntil:new Date(Date.now()+60000)}]],[[person],[source],[{...person,userId:"changed"}]],[[person],[source],[{...person,managedAccount:false}]],[[person],[source],[{...person,active:false}]]]){
   const {app,writes}=fixture(rows);
   const response=await request(app).post(url).send(body);
   expect([404,409]).toContain(response.status);expect(writes).toEqual([]);
  }
 });
 it("rejects active sessions, same-account selection, missing targets and duplicate enterprise bindings",async()=>{
  for(const [rows,input,status] of [
   [[[person],[source],[person],[{id:"session"}]],body,409],
   [[[person],[source],[person]],{...body,userId:"generated"},400],
   [[[person],[source],[person],[],[]],body,404],
   [[[person],[source],[person],[],[{id:"original"}],[]],body,409],
   [[[person],[source],[person],[],[{id:"original"}],[{id:"credential"}],[{id:sourceId}],[{id:"other-person"}]],body,409],
  ] as const){
   const {app,writes}=fixture(rows.map(row=>[...row]));
   expect((await request(app).post(url).send(input)).status).toBe(status);expect(writes).toEqual([]);
  }
 });
});
