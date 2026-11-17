import express from "express";
import request from "supertest";
import { describe, expect, it, vi, afterEach } from "vitest";
import { agents, heartbeatRuns, managedParts, managedStreams, managedSessions, managedEvents, type Db } from "@paperclipai/db";
import { managedSessionRoutes } from "../routes/managed-sessions.js";
import { HttpError } from "../errors.js";

const company = "10000000-0000-4000-8000-000000000002";
const sessionId = "10000000-0000-4000-8000-000000000004";
const path = `/api/companies/${company}/managed-sessions/${sessionId}/harness-observations?stream=harness:stream-1`;
const actor = { type: "board", source: "session", userId: "owner", companyIds: [company], memberships: [{companyId:company,membershipRole:"member",status:"active"}] };
function app(db: Db, who: unknown = actor) {
  const a = express(); a.use(express.json());
  a.use((req,_res,next)=>{req.actor=who as Express.Request["actor"];next();});
  a.use("/api",managedSessionRoutes(db));
  a.use((err:HttpError,_req:express.Request,res:express.Response,_next:express.NextFunction)=>res.status(err.status??500).json({error:err.message}));
  return a;
}
function dbFor(owner="owner", deleted=false) {
  const touched: unknown[]=[];
  const rows=Array.from({length:51},(_,i)=>({sequence:i+1,observedAt:new Date(),payload:{schema:"harness.v2.observation-summary/1"}}));
  const db={select:()=>({from:(table:unknown)=>{
    touched.push(table);
    const result=table===managedSessions?[{id:sessionId,companyId:company,ownerUserId:owner,deletedAt:deleted?new Date():null}]:rows;
    const q={where:()=>q,orderBy:()=>q,limit:()=>q,then:(resolve:(v:unknown)=>unknown)=>Promise.resolve(result).then(resolve)};
    return q;
  }})} as unknown as Db;
  return {db,touched};
}
describe("Harness observation query authorization",()=>{
  it("rejects agent and cross-company reads before storage",async()=>{
    const db=new Proxy({}, {get(){throw new Error("Unexpected storage access");}}) as Db;
    await request(app(db,{type:"agent",source:"agent_key",agentId:"agent",companyId:company})).get(path).expect(403);
    await request(app(db)).get(path.replace(company,"10000000-0000-4000-8000-000000000099")).expect(403);
  });
  it("hides another owner's session",async()=>{
    const {db,touched}=dbFor("someone-else");await request(app(db)).get(path).expect(404);
    expect(touched).toEqual([managedSessions]);
  });
  it("returns bounded pages with no-store headers",async()=>{
    const {db,touched}=dbFor();const response=await request(app(db)).get(path).expect(200);
    expect(response.body.items).toHaveLength(50);expect(response.body.next).toBe(50);
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(touched).toEqual([managedSessions,managedEvents]);
  });
  it("rejects malformed stream and cursor",async()=>{
    const {db,touched}=dbFor();await request(app(db)).get(path+"&after=-1").expect(400);
    expect(touched).toEqual([managedSessions]);
  });
  it("deleted session never exposes retained metadata",async()=>{
    const {db,touched}=dbFor("owner",true);const response=await request(app(db)).get(path).expect(200);
    expect(response.body).toEqual({items:[],next:null});expect(touched).toEqual([managedSessions]);
  });
});

describe("Harness ingestion uses existing session/outbox protocol",()=>{
  afterEach(()=>vi.unstubAllEnvs());
  it("negotiates capability, rejects foreign scope, deduplicates and leaves timing untouched",async()=>{
    const run="10000000-0000-4000-8000-000000000001", task="10000000-0000-4000-8000-000000000003";
    const seat="10000000-0000-4000-8000-000000000005", machine="10000000-0000-4000-8000-000000000006";
    const fingerprint="a".repeat(64);
    const session={id:sessionId,companyId:company,runId:run,taskId:task,seatId:seat,machineId:machine,machineFingerprint:fingerprint,
      ownerUserId:"owner",endedAt:null,deletedAt:null,finalizedAt:null,coverage:"partial",lastObservation:{queuedBytes:7}};
    const stream={id:"stream",streamId:"harness:stream-1",ackSequence:0};
    const persisted:Record<string,unknown>[]=[];
    const rows=new Map<unknown,unknown[]>([
      [agents,[{id:seat,companyId:company,status:"active",adapterConfig:{dsp7WebJiraIntake:true,dsp7Seat:{machineId:machine,machineFingerprint:fingerprint,ownerUserId:"owner"}}}]],
      [managedSessions,[session]],[heartbeatRuns,[{id:run,finishedAt:null}]],
      [managedParts,[{bytes:0}]],[managedStreams,[stream]],[managedEvents,persisted],
    ]);
    const store:any={
      select:()=>({from:(table:unknown)=>{
        const q:any={where:()=>q,for:()=>q,then:(resolve:any)=>Promise.resolve(rows.get(table)??[]).then(resolve)};return q;
      }}),
      insert:(table:unknown)=>({values:(value:Record<string,unknown>)=>{
        if(table===managedEvents)persisted.push(value);
        return {onConflictDoNothing:async()=>undefined};
      }}),
      update:(table:unknown)=>({set:(value:Record<string,unknown>)=>({where:async()=>{
        if(table===managedStreams)Object.assign(stream,value);
        if(table===managedSessions)Object.assign(session,value);
      }})}),
    };
    store.transaction=async(fn:any)=>fn(store);
    const a=app(store,{type:"agent",source:"agent_key",agentId:seat,companyId:company});
    const ident={seat_id:seat,machine_id:machine,machine_fingerprint:fingerprint};
    const endpoint=`/api/agents/${seat}/managed-sessions/${sessionId}`;
    const payload={schema:"harness.v2.observation-summary/1",runId:run,companyId:company,taskId:task,streamId:"stream-1",sourceDigest:"a".repeat(64),resourceDigest:"b".repeat(64),observedEvents:3,droppedEvents:0,observedSessionEnd:true,pendingObservedCalls:0,hostSessionConfirmed:false,processExitConfirmed:false,platformAccepted:false,durationMinutes:null};
    const stamp=new Date().toISOString();
    const event={eventId:"10000000-0000-4000-8000-000000000007",streamId:"harness:stream-1",sequence:1,eventType:"harness.observation",occurredAt:stamp,observedAt:stamp,sourceGeneration:"harness.observation/1",sourceOffset:0,parserVersion:1,payload};
    const batch={...ident,protocolVersion:1,events:[event]};
    vi.stubEnv("DSP7_HARNESS_OBSERVATION_ENABLED","false");
    expect((await request(a).post(endpoint+"/receipts").send(ident).expect(200)).body.capabilities).toEqual([]);
    await request(a).post(endpoint+"/events").send(batch).expect(409);expect(persisted).toHaveLength(0);
    vi.stubEnv("DSP7_HARNESS_OBSERVATION_ENABLED","true");
    vi.stubEnv("DSP7_HARNESS_V2_SEATS",JSON.stringify([{companyId:company,seatId:machine}]));
    expect((await request(a).post(endpoint+"/receipts").send(ident).expect(200)).body.capabilities).toEqual([]);
    await request(a).post(endpoint+"/events").send(batch).expect(409);expect(persisted).toHaveLength(0);
    vi.stubEnv("DSP7_HARNESS_V2_SEATS",JSON.stringify([{companyId:company,seatId:seat}]));
    expect((await request(a).post(endpoint+"/receipts").send(ident).expect(200)).body.capabilities).toEqual(["harness.observation/1"]);
    await request(a).post(endpoint+"/events").send({...batch,events:[{...event,payload:{...payload,companyId:task}}]}).expect(400);
    await request(a).post(endpoint+"/events").send(batch).expect(200);
    await request(a).post(endpoint+"/events").send(batch).expect(200);
    expect(persisted).toHaveLength(1);expect(stream.ackSequence).toBe(1);
    expect(session.endedAt).toBeNull();expect(session.lastObservation).toEqual({queuedBytes:7});
    expect(persisted[0]!.eventType).toBe("harness.observation");
    await request(a).post(endpoint+"/events").send({...batch,events:[{...event,payload:{...payload,observedEvents:4}}]}).expect(409);
    // Native state evidence deliberately uses the existing phase/observed
    // contract. A native completed ledger must never become a passed gate.
    persisted.length=0;stream.streamId="harness-native";stream.ackSequence=0;
    const native={...event,eventId:"10000000-0000-4000-8000-000000000008",streamId:"harness-native",
      eventType:"phase",sourceGeneration:"harness.native-state/1",payload:{phase:"P3",status:"observed",
        source:"Harness native state /1",evidence:`sha256:${"b".repeat(64)}`,
        note:"nativeStatus=completed; revision=unknown; identity/gate/reporting/run-causality not verified"}};
    vi.stubEnv("DSP7_HARNESS_OBSERVATION_ENABLED","false");
    await request(a).post(endpoint+"/events").send({...batch,events:[native]}).expect(200);
    await request(a).post(endpoint+"/events").send({...batch,events:[native]}).expect(200);
    expect(persisted).toHaveLength(1);expect(stream.ackSequence).toBe(1);
    expect(session.endedAt).toBeNull();expect(session.lastObservation).toEqual({queuedBytes:7});
    expect(persisted[0]!.payload).toEqual(native.payload);
  });
});
