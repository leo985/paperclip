import express from "express";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";
import { agents, heartbeatRuns, type Db } from "@paperclipai/db";
import { seatUpgradeRoutes, seatUpgradeState } from "./dsp7-seat-upgrades.js";
import { errorHandler } from "../middleware/error-handler.js";
vi.mock("../services/seat-client-release.js", () => ({ publishedSeatDigest: async () => "b".repeat(64) }));
const companyId="c7bcc01e-0741-4dca-8ff6-825e25f706da", id="a8661763-c814-4116-bee6-70ef4025e727";
const body={requestId:"d4c88894-3d80-4f96-8d94-b222f7ef6131",targetSha256:"b".repeat(64)};
const url=`/companies/${companyId}/dsp7-seats/${id}/client-upgrade`, machine=`/agents/${id}/dsp7-seat-upgrade`;
function fixture({admin=true, busy=false, capability=true}={}) {
  const agent:any={id,companyId,status:"idle",adapterConfig:{dsp7SeatPresence:{bridgeVersion:"a".repeat(64),capabilities:capability?["seat-admin-upgrade-v1"]:[]}}};
  const events:any[]=[];
  const db:any={execute:async()=>{},select:()=>{
    let table:any;const chain:any={from:(value:any)=>{table=value;return chain;},where:()=>chain,for:()=>chain,then:(ok:any)=>Promise.resolve(table===agents?[agent]:table===heartbeatRuns?(busy?[{id:"run"}]:[]):[]).then(ok)};return chain;
  },update:()=>({set:(value:any)=>({where:async()=>Object.assign(agent,value)})}),insert:()=>({values:async(value:any)=>events.push(value)}),transaction:async(fn:any)=>fn(db)};
  const app=express();app.use(express.json());app.use((req,_res,next)=>{req.actor={type:"board",source:"local_implicit",isInstanceAdmin:admin} as any;if(!admin)req.actor.source="session";next();});
  const own=async()=>agent,board=async()=>agent;
  app.use(seatUpgradeRoutes(db as Db,own,board));app.use(errorHandler);
  return {app,agent,events};
}
describe("administrator client upgrade dispatch",()=>{
  it("publication never creates a request; admin queues one exact version with audit",async()=>{
    const {app,events,agent}=fixture();expect((await request(app).get(url)).body).toBeNull();expect(events).toHaveLength(0);
    const response=await request(app).post(url).send(body);expect(response.status).toBe(200);expect(response.body.status).toBe("queued");expect(agent.adapterConfig.dsp7SeatUpgrade.targetSha256).toBe(body.targetSha256);expect(events[0].action).toBe("dsp7.seat.upgrade.requested");
    expect((await request(app).post(url).send(body)).status).toBe(200);expect(events).toHaveLength(1);
  });
  it("denies non-admins, unsupported clients and changed releases",async()=>{
    expect((await request(fixture({admin:false}).app).post(url).send(body)).status).toBe(403);
    expect((await request(fixture({capability:false}).app).post(url).send(body)).status).toBe(409);
    expect((await request(fixture().app).post(url).send({...body,targetSha256:"c".repeat(64)})).status).toBe(409);
  });
  it("busy seats cannot claim and cancellation prevents later claim",async()=>{
    const {app}=fixture({busy:true});await request(app).post(url).send(body);
    expect((await request(app).post(machine+"/claim").send(body)).status).toBe(409);
    expect((await request(app).post(url+"/cancel").send(body)).body.status).toBe("cancelled");
    expect((await request(app).post(machine+"/claim").send(body)).status).toBe(409);
  });
  it("requires claim, keeps installed result verifying until a fresh version heartbeat",async()=>{
    const {app,agent}=fixture();await request(app).post(url).send(body);
    expect((await request(app).post(machine+"/result").send({...body,status:"installed"})).status).toBe(409);
    expect((await request(app).post(machine+"/claim").send(body)).body.status).toBe("claimed");
    expect((await request(app).post(url+"/cancel").send(body)).status).toBe(409);
    expect((await request(app).post(machine+"/result").send({...body,status:"installed"})).body.status).toBe("verifying");
    agent.adapterConfig.dsp7SeatPresence={bridgeVersion:body.targetSha256,lastSeenAt:new Date(Date.now()+1).toISOString()};
    expect((await request(app).get(url)).body.status).toBe("succeeded");
  });
  it("expired requests cannot be claimed and stale heartbeats cannot report success",async()=>{
    const {app,agent}=fixture();await request(app).post(url).send(body);
    agent.adapterConfig.dsp7SeatUpgrade.expiresAt=new Date(0).toISOString();
    agent.adapterConfig.dsp7SeatPresence={bridgeVersion:body.targetSha256,lastSeenAt:new Date(0).toISOString()};
    expect(seatUpgradeState(agent)?.status).toBe("expired");
    expect((await request(app).post(machine+"/claim").send(body)).status).toBe(409);
  });
});
