import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { agents, companies, createDb, heartbeatRuns, issues, seatExecutionPermits } from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "../__tests__/helpers/embedded-postgres.js";
const transport = vi.hoisted(() => ({ pending: vi.fn(), claim: vi.fn(), job: vi.fn() }));
vi.mock("../services/dsp7-outbound.js", () => ({ pendingOutbound: transport.pending, claimOutbound: transport.claim,
  outboundJob: transport.job, receiveOutbound: vi.fn() }));
import { harnessValidationService } from "../services/harness-validation.js";
import { dsp7QuickSeatRoutes } from "./dsp7-quick-seats.js";
const support = await getEmbeddedPostgresTestSupport();
(support.supported ? describe : describe.skip)("observer attachment outbound admission", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>, db: ReturnType<typeof createDb>;
  beforeAll(async () => { database = await startEmbeddedPostgresTestDatabase("observer-dispatch-"); db = createDb(database.connectionString); });
  afterAll(async () => { await database?.cleanup(); });
  afterEach(() => { vi.unstubAllEnvs(); vi.clearAllMocks(); });
  async function fixture() {
    const companyId=randomUUID(), agentId=randomUUID(), runId=randomUUID(), taskId=randomUUID(), machineId=randomUUID();
    const bundle={ protocolVersion:1, bundleDigest:"a".repeat(64), project:"history-pilot", mode:"candidate",
      packages:[{id:"runtime",layer:"L3",version:"1.0.0",skills:[],manifestDigest:"b".repeat(64)},
        {id:"methods",layer:"L4",version:"1.0.0",skills:["harness-v2-history-pilot"],manifestDigest:"c".repeat(64)}] };
    await db.insert(companies).values({id:companyId,name:"Observer dispatch",issuePrefix:`O${companyId.slice(0,6)}`});
    await db.insert(agents).values({id:agentId,companyId,name:"Seat",role:"engineer",status:"idle",adapterType:"claude_local",
      adapterConfig:{dsp7Transport:"outbound",dsp7Seat:{machineId,ownerUserId:"owner",machineFingerprint:"a".repeat(64)},dsp7SeatRuntime:{revision:1},
        dsp7HarnessBundles:{version:1,revision:2,items:[{...bundle,checkedAt:new Date().toISOString(),validation:"seat-reported-local-files",executionReady:false,loadState:"unconfirmed"}]}}});
    await db.insert(issues).values({id:taskId,companyId,assigneeAgentId:agentId,title:"Isolated dispatch",status:"in_progress"});
    await db.insert(heartbeatRuns).values({id:runId,companyId,agentId,status:"running",nativeIssueId:taskId});
    vi.stubEnv("DSP7_HARNESS_OBSERVER_BINDINGS_ENABLED","true");
    vi.stubEnv("DSP7_HARNESS_OBSERVATION_ENABLED","true");vi.stubEnv("DSP7_HARNESS_BUNDLES_ENABLED","true");
    vi.stubEnv("DSP7_HARNESS_V2_SEATS",JSON.stringify([{companyId,seatId:agentId}]));
    vi.stubEnv("DSP7_HARNESS_OBSERVER_BINDINGS",JSON.stringify([{companyId,seatId:agentId,taskId,projectId:null,bundleDigest:bundle.bundleDigest}]));
    transport.pending.mockReturnValue({ctx:{runId},packet:{taskId,executionKind:"development"},resolve:vi.fn()});
    transport.claim.mockResolvedValue({runId,taskId,companyId,agentId,lease:randomUUID()});
    const app=express();app.use(express.json());app.use((req,_res,next)=>{Object.assign(req,{actor:{type:"agent",source:"agent_key",agentId,companyId}});next();});
    app.use(dsp7QuickSeatRoutes(db));app.use((err:any,_req:any,res:any,_next:any)=>res.status(err.status??500).json({error:err.message}));
    return {app,runId,agentId,companyId,taskId,bundle,body:{seat_id:agentId,machine_id:machineId,machine_fingerprint:"a".repeat(64),revision:1}};
  }
  it("negotiates validation before one-use claim and freezes it in the original permit", async () => {
    const f=await fixture(),dispatchId=randomUUID(),scope={companyId:f.companyId,seatId:f.agentId,taskId:f.taskId};
    vi.stubEnv("PAPERCLIP_DEPLOYMENT_MODE","local_trusted");vi.stubEnv("DSP7_HARNESS_VALIDATION_ENABLED","true");
    vi.stubEnv("DSP7_HARNESS_VALIDATION_TASKS",JSON.stringify([{...scope,projectId:null,bundleDigest:f.bundle.bundleDigest}]));
    await db.update(heartbeatRuns).set({contextSnapshot:{issueId:f.taskId,harnessValidationDispatchId:dispatchId}}).where(eq(heartbeatRuns.id,f.runId));
    await harnessValidationService(db).authorize(scope,dispatchId,f.bundle.bundleDigest,"local-board");
    await harnessValidationService(db).dispatch(scope,dispatchId,"local-board",vi.fn().mockResolvedValue({id:f.runId}));
    transport.pending.mockReturnValue({ctx:{runId:f.runId},packet:{taskId:f.taskId,executionKind:"validation"},resolve:vi.fn()});
    const endpoint=`/agents/${f.agentId}/dsp7-outbound-poll`, protocols={...f.body,permitProtocol:1,supervisionProtocol:2,observerProtocol:1};
    await request(f.app).post(endpoint).send(protocols).expect(409);
    expect(transport.claim).not.toHaveBeenCalled();
    const response=await request(f.app).post(endpoint).send({...protocols,validationProtocol:1}).expect(200);
    expect(response.body.job.permit.harnessValidation).toMatchObject({dispatchId,runId:f.runId,purpose:"synthetic-history"});
    expect(response.body.job.permit.treeProofRequired).toBe(true);
    expect(response.body.job.executionRoute).toBeNull();
  });
  it("rejects legacy clients before consuming one-use dispatch, then sends the frozen attachment in the original permit", async () => {
    const f=await fixture(), endpoint=`/agents/${f.agentId}/dsp7-outbound-poll`;
    for(const protocol of [{},{permitProtocol:1,supervisionProtocol:2},{permitProtocol:1,supervisionProtocol:2,observerProtocol:"1"}]) {
      const response=await request(f.app).post(endpoint).send({...f.body,...protocol});
      expect(response.status).toBe(409);expect(transport.claim).not.toHaveBeenCalled();
    }
    const response=await request(f.app).post(endpoint).send({...f.body,permitProtocol:1,supervisionProtocol:2,observerProtocol:1});
    expect(response.status).toBe(200);
    expect(response.body.job.permit.harnessObserver).toMatchObject({runId:f.runId,purpose:"observation-only",executionReady:false,registryRevision:2});
    expect(response.body.job.executionRoute).toBeNull();
    const [stored]=await db.select().from(seatExecutionPermits).where(eq(seatExecutionPermits.runId,f.runId));
    expect(stored.ledgerScope?.harnessObserver).toEqual(response.body.job.permit.harnessObserver);
  });
  it("ends the original live job on a verified no-start receipt, rejecting a wrong lease before settlement", async () => {
    const f=await fixture();
    const claimed=await request(f.app).post(`/agents/${f.agentId}/dsp7-outbound-poll`)
      .send({...f.body,permitProtocol:1,supervisionProtocol:2,observerProtocol:1}).expect(200);
    const resolve=vi.fn(), lease=claimed.body.job.lease;
    transport.job.mockReturnValue({ctx:{agent:{id:f.agentId,companyId:f.companyId}},lease,resolve});
    const proof={protocolVersion:1,runId:f.runId,isolation:"not-started",remaining:0,observations:2,
      firstObservedAt:new Date(Date.now()-500).toISOString(),observedAt:new Date().toISOString()};
    const endpoint=`/agents/${f.agentId}/dsp7-outbound-runs/${f.runId}/stopped`;
    await request(f.app).post(endpoint).send({...f.body,lease:randomUUID(),exitObserved:true,treeProof:proof}).expect(409);
    expect(resolve).not.toHaveBeenCalled();
    await request(f.app).post(endpoint).send({...f.body,lease,exitObserved:true,treeProof:proof}).expect(200);
    expect(resolve).toHaveBeenCalledWith(expect.objectContaining({exitCode:1,timedOut:false,errorCode:"dsp7_local_prepare_failed"}));
    const [stored]=await db.select().from(seatExecutionPermits).where(eq(seatExecutionPermits.runId,f.runId));
    expect(stored.processExitObservedAt).not.toBeNull();expect(stored.treeStopProof?.isolation).toBe("not-started");
    transport.job.mockReturnValue(undefined);
    await request(f.app).post(endpoint).send({...f.body,lease,exitObserved:true,treeProof:proof}).expect(200);
    expect(resolve).toHaveBeenCalledTimes(1);
  });
  it("does not turn a normal process-tree exit proof into a preparation failure", async () => {
    const f=await fixture();
    const claimed=await request(f.app).post(`/agents/${f.agentId}/dsp7-outbound-poll`)
      .send({...f.body,permitProtocol:1,supervisionProtocol:2,observerProtocol:1}).expect(200);
    const resolve=vi.fn(),lease=claimed.body.job.lease;
    transport.job.mockReturnValue({ctx:{agent:{id:f.agentId,companyId:f.companyId}},lease,resolve});
    await request(f.app).post(`/agents/${f.agentId}/dsp7-outbound-runs/${f.runId}/stopped`).send({...f.body,lease,exitObserved:true,
      treeProof:{protocolVersion:1,runId:f.runId,isolation:"windows-job",remaining:0,observations:2,
        firstObservedAt:new Date(Date.now()-500).toISOString(),observedAt:new Date().toISOString()}}).expect(200);
    expect(resolve).not.toHaveBeenCalled();
    // A conflicting replay cannot replace the first accepted process proof
    // or turn an already-executed model into a no-model preparation failure.
    await request(f.app).post(`/agents/${f.agentId}/dsp7-outbound-runs/${f.runId}/stopped`).send({...f.body,lease,exitObserved:true,
      treeProof:{protocolVersion:1,runId:f.runId,isolation:"not-started",remaining:0,observations:2,
        firstObservedAt:new Date(Date.now()-500).toISOString(),observedAt:new Date().toISOString()}}).expect(200);
    expect(resolve).not.toHaveBeenCalled();
    const [stored]=await db.select().from(seatExecutionPermits).where(eq(seatExecutionPermits.runId,f.runId));
    expect(stored.treeStopProof?.isolation).toBe("windows-job");
  });
  it.each(["windows-job","posix-sessions"])("fails only the original unfinished validation on verified %s exit",async(isolation)=>{
    const f=await fixture();
    const claimed=await request(f.app).post(`/agents/${f.agentId}/dsp7-outbound-poll`).send({...f.body,permitProtocol:1,supervisionProtocol:2,observerProtocol:1}).expect(200);
    const resolve=vi.fn(),lease=claimed.body.job.lease;
    const job={ctx:{agent:{id:f.agentId,companyId:f.companyId}},packet:{executionKind:"validation"},lease,resolve,receipts:Promise.resolve(),settled:false};
    transport.job.mockReturnValue(job);
    const proof={protocolVersion:1,runId:f.runId,isolation,remaining:0,observations:2,firstObservedAt:new Date(Date.now()-500).toISOString(),observedAt:new Date().toISOString()};
    const endpoint=`/agents/${f.agentId}/dsp7-outbound-runs/${f.runId}/stopped`;
    await request(f.app).post(endpoint).send({...f.body,lease:randomUUID(),exitObserved:true,treeProof:proof}).expect(409);
    expect(resolve).not.toHaveBeenCalled();
    await request(f.app).post(endpoint).send({...f.body,lease,exitObserved:true,treeProof:proof}).expect(200);
    expect(resolve).toHaveBeenCalledWith(expect.objectContaining({exitCode:1,timedOut:false,errorCode:"dsp7_validation_worker_exited",resultJson:{validationInterrupted:true,processTreeExitVerified:true}}));
    job.settled=true;
    await request(f.app).post(endpoint).send({...f.body,lease,exitObserved:true,treeProof:{...proof,isolation:"not-started"}}).expect(200);
    expect(resolve).toHaveBeenCalledTimes(1);
  });
  it.each(["received-result","cancelled","replaced-job"])("preserves %s while waiting for original result receipts",async(scenario)=>{
    const f=await fixture();
    const claimed=await request(f.app).post(`/agents/${f.agentId}/dsp7-outbound-poll`).send({...f.body,permitProtocol:1,supervisionProtocol:2,observerProtocol:1}).expect(200);
    const resolve=vi.fn(),lease=claimed.body.job.lease,controller=new AbortController();
    const job={ctx:{agent:{id:f.agentId,companyId:f.companyId},signal:controller.signal},packet:{executionKind:"validation"},lease,resolve,settled:false,receipts:undefined as unknown as Promise<void>};
    transport.job.mockReturnValue(job);
    job.receipts={then:(done:()=>void)=>{if(scenario==="received-result")job.settled=true;else if(scenario==="cancelled")controller.abort();else transport.job.mockReturnValue(undefined);done();}} as unknown as Promise<void>;
    await request(f.app).post(`/agents/${f.agentId}/dsp7-outbound-runs/${f.runId}/stopped`).send({...f.body,lease,exitObserved:true,treeProof:{protocolVersion:1,runId:f.runId,isolation:"windows-job",remaining:0,observations:2,firstObservedAt:new Date(Date.now()-500).toISOString(),observedAt:new Date().toISOString()}}).expect(200);
    expect(resolve).not.toHaveBeenCalled();
  });

  it("drains a result appended while an earlier log receipt is blocked",async()=>{
    const f=await fixture();
    const claimed=await request(f.app).post(`/agents/${f.agentId}/dsp7-outbound-poll`).send({...f.body,permitProtocol:1,supervisionProtocol:2,observerProtocol:1}).expect(200);
    const {receiveOutbound}=await vi.importActual<typeof import('../services/dsp7-outbound.js')>('../services/dsp7-outbound.js');
    let release!:()=>void,entered!:()=>void;
    const logGate=new Promise<void>(r=>release=r),awaiting=new Promise<void>(r=>entered=r);
    const lease=claimed.body.job.lease;
    const job:any={ctx:{agent:{id:f.agentId,companyId:f.companyId},onLog:()=>logGate},packet:{executionKind:"validation"},lease,settled:false,sequence:0,receipts:Promise.resolve()};
    job.resolve=vi.fn(()=>{job.settled=true;});
    const log=receiveOutbound(job,{sequence:1,stream:"stdout",chunk:"bounded log"});
    let tail=job.receipts;
    Object.defineProperty(job,'receipts',{get(){entered();return tail;},set(v){tail=v;},configurable:true});
    transport.job.mockReturnValue(job);
    const stopped=request(f.app).post(`/agents/${f.agentId}/dsp7-outbound-runs/${f.runId}/stopped`).send({...f.body,lease,exitObserved:true,treeProof:{protocolVersion:1,runId:f.runId,isolation:"windows-job",remaining:0,observations:2,firstObservedAt:new Date(Date.now()-500).toISOString(),observedAt:new Date().toISOString()}}).then(r=>r);
    await awaiting;
    const success={exitCode:0,signal:null,timedOut:false};
    const result=receiveOutbound(job,{sequence:2,result:success});
    release();await Promise.all([log,result]);expect((await stopped).status).toBe(200);
    expect(job.resolve).toHaveBeenCalledTimes(1);expect(job.resolve).toHaveBeenCalledWith(success);
  });

});
