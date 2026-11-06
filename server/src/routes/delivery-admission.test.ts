import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { afterAll,beforeAll,describe,expect,it } from "vitest";
import { agents,analysisExecutions,issues,companies,createDb,deliverySnapshots,projects } from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport,startEmbeddedPostgresTestDatabase } from "../__tests__/helpers/embedded-postgres.js";
import { deliveryIntakeRoutes } from "./delivery-intake.js";
import { normalizeDeliverySnapshot } from "../services/delivery-intake.js";
import { fixture } from "../services/delivery-intake.fixture.js";
import { assertDeliveryCodingAdmission,deliveryAdmission } from "../services/delivery-admission.js";
const support=await getEmbeddedPostgresTestSupport();
(support.supported?describe:describe.skip)("version-bound delivery admission",()=>{
  let database:Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>,db:ReturnType<typeof createDb>;
  beforeAll(async()=>{database=await startEmbeddedPostgresTestDatabase("delivery-admission-");db=createDb(database.connectionString);});
  afterAll(async()=>{await database?.cleanup();});
  async function seed(){
    const companyId=randomUUID(),projectId=randomUUID();await db.insert(companies).values({id:companyId,name:"Admission",issuePrefix:"A"+companyId.slice(0,6)});await db.insert(projects).values({id:projectId,companyId,name:"Project"});
    const f=fixture();const j=JSON.parse(f.jiraJson);j.issues[1].fields.status.name="待开发";j.issues[2].fields.status.name="待开发";f.jiraJson=JSON.stringify(j);
    const schedules=f.scheduleJsons.map(raw=>{const s=JSON.parse(raw);const children=s.data[0].children[0].children;children.push({...children[0],urid:"1846022152414969858",issueNo:"ATSES-3"});return JSON.stringify(s);});
    const plan=normalizeDeliverySnapshot({...f,scheduleJsons:schedules});
    // Remove only the fixture's deliberate void issue discrepancy; both Jira children now appear in schedule.
    expect(plan.differences).toEqual([]);
    const [snapshot]=await db.insert(deliverySnapshots).values({companyId,projectId,sourceOrigin:f.sourceOrigin,demandNo:f.demandNo,createdByUserId:"admin",collectedAt:new Date(),fingerprint:plan.fingerprint,plan}).returning();
    function app(actor:any={type:"board",source:"local_implicit",userId:"admin"}){const app=express();app.use(express.json());app.use((req,_res,next)=>{Object.assign(req,{actor});next();});app.use(deliveryIntakeRoutes(db));app.use((e:any,_req:any,res:any,_next:any)=>res.status(e.status??500).json({error:e.message}));return app;}
    const url=`/companies/${companyId}/delivery-intake/entries/${snapshot.id}/admission`;
    const evidence={fingerprint:plan.fingerprint,analysisReference:"https://proj.fingard.com:1888/analysis/123",designRequired:false,designReference:"",note:"已核对正式分析版本，范围无需独立设计评审"};
    return {companyId,projectId,snapshot,app,url,evidence};
  }
  it("blocks coding before evidence, permits verified external analysis without duplicate platform analysis",async()=>{
    const f=await seed();await expect(assertDeliveryCodingAdmission(db,f.companyId,f.projectId,"ATSES-2")).rejects.toMatchObject({status:409});
    // Unmanaged tasks are not pulled into this entry's workflow.
    await expect(assertDeliveryCodingAdmission(db,f.companyId,f.projectId,"OTHER-1")).resolves.toBeUndefined();
    const r=await request(f.app()).post(f.url).send(f.evidence);expect(r.status).toBe(200);expect(r.body.ready).toBe(true);expect(r.body.evidence.checkedBy).toBe("admin");
    await expect(assertDeliveryCodingAdmission(db,f.companyId,f.projectId,"ATSES-2")).resolves.toBeUndefined();
    const detail=await request(f.app()).get(f.url.replace("/admission",""));expect(detail.body.admission.ready).toBe(true);
  });
  it("requires design evidence and rejects foreign actors, unsafe references and stale version",async()=>{
    const f=await seed();expect((await request(f.app()).post(f.url).send({...f.evidence,designRequired:true})).status).toBe(400);
    expect((await request(f.app()).post(f.url).send({...f.evidence,analysisReference:"javascript:alert(1)"})).status).toBe(400);
    expect((await request(f.app({type:"board",source:"session",companyIds:[]})).post(f.url).send(f.evidence)).status).toBe(403);
    expect((await request(f.app()).post(f.url).send({...f.evidence,fingerprint:"f".repeat(64)})).status).toBe(409);
  });
  it("new source version invalidates older evidence and blocks dispatch until rechecked",async()=>{
    const f=await seed();expect((await request(f.app()).post(f.url).send(f.evidence)).status).toBe(200);
    const {id:_id,createdAt:_created,...prior}=f.snapshot;
    const [next]=await db.insert(deliverySnapshots).values({...prior,fingerprint:"b".repeat(64),plan:{...prior.plan,fingerprint:"b".repeat(64)},collectedAt:new Date(Date.now()+1000)}).returning();
    expect((await deliveryAdmission(db,next)).ready).toBe(false);
    await expect(assertDeliveryCodingAdmission(db,f.companyId,f.projectId,"ATSES-2")).rejects.toMatchObject({status:409});
    expect((await request(f.app()).post(f.url).send(f.evidence)).status).toBe(409);
  });
  it("a newer platform analysis revision invalidates external evidence until formally published and rechecked",async()=>{
    const f=await seed();expect((await request(f.app()).post(f.url).send(f.evidence)).status).toBe(200);
    const [agent]=await db.insert(agents).values({companyId:f.companyId,name:"Analysis",role:"engineer",adapterType:"claude_local"}).returning();
    const [issue]=await db.insert(issues).values({companyId:f.companyId,projectId:f.projectId,title:"New analysis"}).returning();
    await db.insert(analysisExecutions).values({id:issue.id,companyId:f.companyId,projectId:f.projectId,seatId:agent.id,ownerUserId:"admin",requestId:randomUUID(),createdBy:"admin",title:"Analysis",brief:"Updated scope",demandNo:f.snapshot.demandNo,state:"draft"});
    const admission=await deliveryAdmission(db,f.snapshot);expect(admission.ready).toBe(false);expect(admission.evidence).toBeNull();
    expect((await request(f.app()).post(f.url).send(f.evidence)).status).toBe(409);
    await expect(assertDeliveryCodingAdmission(db,f.companyId,f.projectId,"ATSES-2")).rejects.toMatchObject({status:409});
  });

});
