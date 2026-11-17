import express from "express";
import request from "supertest";
import { beforeEach,afterEach,describe,expect,it,vi } from "vitest";
import { agents,heartbeatRuns,type Db } from "@paperclipai/db";
import { harnessBundleRoutes } from "./harness-bundles.js";
const companyId="11111111-1111-4111-8111-111111111111",agentId="22222222-2222-4222-8222-222222222222",machineId="33333333-3333-4333-8333-333333333333";
const bundle={protocolVersion:1,bundleDigest:"a".repeat(64),project:"base-harness-infrastructure",mode:"candidate",
  packages:[{id:"harness-v2-runtime",version:"0.1.0",layer:"L3",manifestDigest:"b".repeat(64),skills:["harness-runtime-inspect"]},
    {id:"fingard-history-methods",version:"0.1.0",layer:"L4",manifestDigest:"c".repeat(64),skills:["git-history-analyzer"]}]};
const body={seat_id:agentId,machine_id:machineId,machine_fingerprint:"d".repeat(64),expectedRevision:0,bundle};
const endpoint=`/agents/${agentId}/dsp7-harness-bundles`;
const boardPath=`/companies/${companyId}/dsp7-seats/${agentId}/harness-bundles`;
const board={type:"board",source:"session",userId:"owner",companyIds:[companyId],memberships:[{companyId,status:"active",membershipRole:"member"}]};
function fixture(actor:unknown={type:"agent",source:"agent_key",companyId,agentId}){
  const agent:any={id:agentId,companyId,status:"idle",adapterConfig:{dsp7Seat:{machineId,machineFingerprint:"d".repeat(64),ownerUserId:"owner"},dsp7HarnessCapabilities:{version:1,revision:9,items:[]}}};
  const state={agent,active:false,audits:[] as any[],writes:0};
  const db:any={execute:async()=>{},select:()=>({from:(table:unknown)=>{
    const q:any={where:()=>q,for:()=>q,then:(resolve:any)=>Promise.resolve(table===agents?[state.agent]:table===heartbeatRuns&&state.active?[{id:"run"}]:[]).then(resolve)};return q;
  }}),update:()=>({set:(value:any)=>({where:async()=>{state.writes++;Object.assign(state.agent,value);}})}),insert:()=>({values:async(value:any)=>state.audits.push(value)})};
  db.transaction=async(fn:any)=>fn(db);
  const app=express();app.use(express.json());app.use((req,_res,next)=>{req.actor=actor as Express.Request["actor"];next();});
  app.use(harnessBundleRoutes(db as Db));app.use((err:any,_req:any,res:any,_next:any)=>res.status(err.status??500).json({error:err.message}));
  return {app,state};
}
describe("bundle registry routes",()=>{
  beforeEach(()=>vi.stubEnv("DSP7_HARNESS_V2_SEATS",JSON.stringify([{companyId,seatId:agentId}])));
  afterEach(()=>vi.unstubAllEnvs());
  it("defaults to unsupported and preserves legacy state",async()=>{
    vi.stubEnv("DSP7_HARNESS_BUNDLES_ENABLED","false");const {app,state}=fixture();
    const response=await request(app).get(endpoint).expect(200);expect(response.body.registrationSupported).toBe(false);
    await request(app).post(endpoint).send(body).expect(409);expect(state.writes).toBe(0);
  });
  it("does not advertise or write outside the pilot scope",async()=>{
    vi.stubEnv("DSP7_HARNESS_BUNDLES_ENABLED","true");
    vi.stubEnv("DSP7_HARNESS_V2_SEATS",JSON.stringify([{companyId,seatId:machineId}]));
    const {app,state}=fixture();
    expect((await request(app).get(endpoint).expect(200)).body.registrationSupported).toBe(false);
    expect((await request(fixture(board).app).get(boardPath).expect(200)).body.registrationSupported).toBe(false);
    await request(app).post(endpoint).send(body).expect(409);
    expect(state.writes).toBe(0);expect(state.audits).toHaveLength(0);
  });
  it("registers and deduplicates without granting execution or changing old routes",async()=>{
    vi.stubEnv("DSP7_HARNESS_BUNDLES_ENABLED","true");const {app,state}=fixture();
    const response=await request(app).post(endpoint).send(body).expect(200);
    expect(response.body.revision).toBe(1);expect(response.body.items[0]).toMatchObject({executionReady:false,loadState:"unconfirmed",validation:"seat-reported-local-files"});
    state.active=true;
    await request(app).post(endpoint).send({...body,expectedRevision:1}).expect(200);
    expect(state.writes).toBe(1);expect(state.audits).toHaveLength(1);
    expect(state.agent.adapterConfig.dsp7HarnessCapabilities).toEqual({version:1,revision:9,items:[]});
    expect(state.audits[0].details.executionGranted).toBe(false);
  });
  it("rejects stale revisions, immutable digest conflicts and busy changes",async()=>{
    vi.stubEnv("DSP7_HARNESS_BUNDLES_ENABLED","true");const {app,state}=fixture();
    await request(app).post(endpoint).send(body).expect(200);
    await request(app).post(endpoint).send(body).expect(409);
    await request(app).post(endpoint).send({...body,expectedRevision:1,bundle:{...bundle,project:"another"}}).expect(409);
    state.active=true;
    await request(app).post(endpoint).send({...body,expectedRevision:1,bundle:{...bundle,bundleDigest:"e".repeat(64)}}).expect(409);
    expect(state.writes).toBe(1);
  });
  it("rejects foreign credentials and mismatched devices",async()=>{
    vi.stubEnv("DSP7_HARNESS_BUNDLES_ENABLED","true");
    const foreign=fixture({type:"agent",source:"agent_key",companyId,agentId:machineId});await request(foreign.app).post(endpoint).send(body).expect(403);
    const own=fixture();await request(own.app).post(endpoint).send({...body,machine_id:agentId}).expect(403);expect(own.state.writes).toBe(0);
  });
  it("restricts board reads to company and seat owner/manager",async()=>{
    await request(fixture({...board,companyIds:[]}).app).get(boardPath).expect(403);
    await request(fixture({...board,userId:"other"}).app).get(boardPath).expect(404);
    const response=await request(fixture(board).app).get(boardPath).expect(200);expect(response.headers["cache-control"]).toBe("no-store");
  });
  it("rejects paths and hidden authority fields before persistence",async()=>{
    vi.stubEnv("DSP7_HARNESS_BUNDLES_ENABLED","true");const {app,state}=fixture();
    await request(app).post(endpoint).send({...body,bundle:{...bundle,root:"/private"}}).expect(400);expect(state.writes).toBe(0);
  });
});
