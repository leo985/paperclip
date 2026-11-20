import { createHash, randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { activityLog, agents, analysisExecutions, companies, companySecrets, createDb, deliveryConnections, deliverySnapshots, issues, projects, seatQingzhouAccounts, type Db } from "@paperclipai/db";
import type { AnalysisDelivery } from "@paperclipai/shared";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "../__tests__/helpers/embedded-postgres.js";
import { analysisQingzhouHtml, buildQingzhouAnalysisForm, qingzhouAnalysisFields, writeAnalysisToQingzhou } from "./analysis-qingzhou-writeback.js";
import { validateAnalysisDelivery } from "./analysis-executions.js";
import { normalizeDeliverySnapshot } from "./delivery-intake.js";
import { fixture } from "./delivery-intake.fixture.js";
import { secretService } from "./secrets.js";

const markdown = "# 分析结论\n\n需求范围 <script>alert(1)</script> & 验收条件";
const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const demandId = "1828643972046290945", demandNo = "ATS3-00156";
function detail(body = "", metadata: Record<string, unknown> = {}) {
  return { demandDto: { urid: demandId, demandNo, theme: "条目主题", demandState: 3, reviewer: "456", requirementer: "123" }, demandAnalysisDetailsDTO: { estimateAnalysisWorkHour: 2, functionPackage:"原功能包", demandAnalysisDto: { analysisResult: body, workGenerality: 2, workHour: 3, startDate:"2026-11-01",endDate:"2026-11-02",associateOtherFunctions:"关联功能",isAcrossSubProduct:"否",planAttributes:"增强",...metadata } } };
}
describe("Qingzhou analysis payload", () => {
  it("escapes active markup and preserves existing business metadata", () => {
    const fields = buildQingzhouAnalysisForm(qingzhouAnalysisFields(detail(), demandId, demandNo), markdown, {}, new Date(), new Date());
    expect(fields["demandAnalysisDto.analysisResult"]).not.toContain("<script>");
    expect(fields["demandAnalysisDto.analysisResult"]).toContain("&lt;script&gt;");
    expect(fields).toMatchObject({"demandAnalysisDto.functionPackage":"原功能包","demandAnalysisDto.workHour":"3","demandAnalysisDto.workGenerality":"2","demandAnalysisDto.startDate":"2026-11-01","demandAnalysisDto.endDate":"2026-11-02","demandAnalysisDto.associateOtherFunctions":"关联功能","demandAnalysisDto.estimateAnalysisWorkHour":"2"});
    expect(Object.keys(fields)).not.toContain("reviewer");
  });
  it("uses configured fields before source values and rejects reversed dates", () => {
    const source = qingzhouAnalysisFields(detail(),demandId,demandNo);
    expect(buildQingzhouAnalysisForm(source,markdown,{workGenerality:"1",workHour:"4.5"},new Date(),new Date())).toMatchObject({"demandAnalysisDto.workGenerality":"1","demandAnalysisDto.workHour":"4.5"});
    expect(()=>buildQingzhouAnalysisForm(source,markdown,{startDate:"2026-12-01"},new Date(),new Date())).toThrow("起止日期");
  });
  it("uses Shanghai run dates and explicit defaults only for missing source metadata", () => {
    const source = qingzhouAnalysisFields({...detail(),demandAnalysisDetailsDTO:null},demandId,demandNo);
    const fields = buildQingzhouAnalysisForm(source,markdown,{},new Date("2026-11-01T16:00:00Z"),new Date("2026-11-02T16:00:00Z"));
    expect(fields).toMatchObject({"demandAnalysisDto.workGenerality":"1","demandAnalysisDto.workHour":"1","demandAnalysisDto.startDate":"2026-11-02","demandAnalysisDto.endDate":"2026-11-03"});
  });
  it("rejects unbound readback identities and analysis content outside the approved manifest", () => {
    expect(()=>qingzhouAnalysisFields(detail(),"other",demandNo)).toThrow();
    const delivery = {protocolVersion:1,binding:{companyId:"c",taskId:"t",revision:1,nativeId:"pc-t-r1"},phase:"P4",nativeStatus:"completed",completedPhases:["P0","P1","P2","P3","P4"],localCompleted:true,gateErrors:[],analysisMarkdown:markdown,handoffDigest:"b".repeat(64),artifacts:["intake.md","evidence.json","requirements.json","analysis.md","review.json","handoff.md","state.json"].map(path=>({path,sha256:path==="handoff.md"?"b".repeat(64):"a".repeat(64)}))} as unknown as AnalysisDelivery;
    expect(()=>validateAnalysisDelivery(delivery,{id:"t",companyId:"c",revision:1} as any)).toThrow("正文");
  });
});

const support = await getEmbeddedPostgresTestSupport();
(support.supported ? describe : describe.skip)("durable analysis writeback", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>, db: Db;
  beforeAll(async()=>{database=await startEmbeddedPostgresTestDatabase("analysis-writeback-");db=createDb(database.connectionString);},30000);
  afterAll(async()=>{await database?.cleanup();});
  async function seed() {
    const companyId=randomUUID(),projectId=randomUUID(),seatId=randomUUID(),id=randomUUID(),secretId=randomUUID();
    await db.insert(companies).values({id:companyId,name:"Writeback",issuePrefix:"Q"+companyId.slice(0,6)});
    await db.insert(projects).values({id:projectId,companyId,name:"Project"});
    await db.insert(agents).values({id:seatId,companyId,name:"Analyst",role:"engineer",adapterType:"claude_local",adapterConfig:{dsp7Seat:{ownerUserId:"admin"}}});
    await db.insert(issues).values({id,companyId,projectId,title:"Analysis",status:"done"});
    const plan=normalizeDeliverySnapshot(fixture());
    await db.insert(deliverySnapshots).values({companyId,projectId,sourceOrigin:"https://proj.fingard.com:1888",demandNo,createdByUserId:"admin",collectedAt:new Date(),fingerprint:plan.fingerprint,plan});
    await db.insert(companySecrets).values({id:secretId,companyId,key:"qingzhou",name:"Qingzhou"});
    await db.insert(deliveryConnections).values({companyId,projectId,organizationId:"123",credentialSecretId:secretId});
    await db.insert(seatQingzhouAccounts).values({companyId,seatId,username:"analyst",credentialSecretId:secretId});
    const delivery: AnalysisDelivery={protocolVersion:1,binding:{protocolVersion:1,companyId,taskId:id,revision:1,nativeId:`pc-${id}-r1`,profile:"dsp",repository:"example/analysis"},phase:"P4",nativeStatus:"completed",completedPhases:["P0","P1","P2","P3","P4"],gateErrors:[],localCompleted:true,formalPublication:"unverified",inputDigest:"a".repeat(64),handoffDigest:"b".repeat(64),analysisMarkdown:markdown,artifacts:["intake.md","evidence.json","requirements.json","analysis.md","review.json","handoff.md","state.json"].map(path=>({path:path as AnalysisDelivery["artifacts"][number]["path"],sha256:path==="analysis.md"?sha(markdown):path==="handoff.md"?"b".repeat(64):"a".repeat(64)}))};
    await db.insert(analysisExecutions).values({id,companyId,projectId,seatId,ownerUserId:"admin",requestId:randomUUID(),createdBy:"admin",title:"Analysis",brief:"Test approved analysis",demandNo,state:"local_completed",delivery});
    let body="<p>原分析</p>",mode="success", writes=0, sourceState=3, submissions=0;
    const fetcher=vi.fn(async(target: URL | string | Request,init?:RequestInit)=>{
      const url=new URL(String(target)),op=url.searchParams.get("uc");
      if(url.pathname==="/api/auth/login")return new Response(JSON.stringify({accessToken:"fixture-token"}));
      let data: Record<string,unknown>;
      if(op==="UC_PROJ2_DEMAND_ITEM_ALL_SEARCH")data={total:1,rows:[{urid:demandId,demandNo}]};
      else if(op==="UC_PROJ2_DEMAND_DETAIL") {const d=detail(body);d.demandDto.demandState=sourceState;data={data:d};}
      else if(op==="UC_PROJ2_DEMAND_APPLY_REVIEW") {
        submissions++;
        if(mode==="review-rejected")return new Response(JSON.stringify({success:false,code:"PROJ0502",info:"private upstream message"}));
        sourceState=5;data={};
      }
      else {
        expect(op).toBe("UC_PROJ2_DEMAND_SPLIT_ANALYZE");writes++;
        expect(init?.body).toBeInstanceOf(FormData);
        if(mode==="rejected")return new Response(JSON.stringify({success:false,code:"PROJ0502",info:"private credential should never be returned"}));
        body=String((init!.body as FormData).get("demandAnalysisDto.analysisResult"));
        if(mode==="lost")throw Error("response lost with token=private");
        if(mode==="mismatch")body="<p>他人修改</p>";
        data={};
      }
      return new Response(JSON.stringify({success:true,code:"0",...data}));
    });
    const secrets=(()=>({resolveSecretValue:async(cid:string,sid:string)=>{expect(cid).toBe(companyId);expect(sid).toBe(secretId);return JSON.stringify({username:"analyst",password:"fixture-password"});}})) as unknown as typeof secretService;
    const sync=(options?: Parameters<typeof writeAnalysisToQingzhou>[4])=>writeAnalysisToQingzhou(db,companyId,id,{type:"user",id:"admin"},options,{fetch:fetcher as typeof fetch,secrets});
    return {id,companyId,projectId,seatId,delivery,fetcher,sync,body:(value:string)=>{body=value;},mode:(value:string)=>{mode=value;},writes:()=>writes,submissions:()=>submissions,secrets};
  }
  it("writes the bound demand, verifies readback, audits and keeps formal publication separate",async()=>{
    const f=await seed();expect(await f.sync()).toMatchObject({status:"saved",reviewStatus:"submitted",sourceState:"5",demandId,contentDigest:expect.any(String),credentialSource:"seat",credentialSeatId:f.seatId,seatAccountRevision:1});
    const [row]=await db.select().from(analysisExecutions).where(eq(analysisExecutions.id,f.id));
    expect(row.state).toBe("local_completed");expect(row.publication).toBeNull();expect(row.delivery).toEqual(f.delivery);
    const log=await db.select().from(activityLog).where(and(eq(activityLog.companyId,f.companyId),eq(activityLog.entityId,f.id)));
    expect(log.map(row=>row.action)).toContain("analysis.qingzhou.saved");
    expect(JSON.stringify(log)).not.toMatch(/fixture-password|fixture-token|script/);
    await f.sync();expect(f.writes()).toBe(1);expect(f.submissions()).toBe(1);
  });
  it("serializes concurrent retries to avoid duplicate upstream writes",async()=>{
    const f=await seed();const results=await Promise.all([f.sync(),f.sync()]);
    expect(results.every(r=>r?.status==="saved")).toBe(true);expect(f.writes()).toBe(1);
  });
  it("recovers a lost save response by reading back, without a second write",async()=>{
    const f=await seed();f.mode("lost");expect(await f.sync()).toMatchObject({status:"failed",previousContentDigest:expect.any(String)});
    f.mode("success");expect(await f.sync()).toMatchObject({status:"saved"});expect(f.writes()).toBe(1);
  });
  it("does not overwrite changed source content after uncertain readback",async()=>{
    const f=await seed();f.mode("mismatch");expect(await f.sync()).toMatchObject({status:"failed",error:expect.stringContaining("回读正文不一致")});
    f.mode("success");expect(await f.sync()).toMatchObject({status:"failed",error:expect.stringContaining("已变化")});expect(f.writes()).toBe(1);
  });
  it("keeps failures retryable without leaking upstream errors or changing the local delivery",async()=>{
    const f=await seed();f.mode("rejected");const failed=await f.sync();
    expect(failed).toMatchObject({status:"failed",error:expect.stringContaining("分析负责人")});expect(JSON.stringify(failed)).not.toContain("private");
    f.mode("success");expect(await f.sync({workHour:"2"})).toMatchObject({status:"saved",options:{workHour:"2"}});
    const [row]=await db.select().from(analysisExecutions).where(eq(analysisExecutions.id,f.id));expect(row.delivery).toEqual(f.delivery);
  });
  it("persists saved content and retries an unsuccessful review submission without saving again",async()=>{
    const f=await seed();f.mode("review-rejected");
    expect(await f.sync()).toMatchObject({status:"saved",reviewStatus:"failed",reviewError:expect.any(String)});
    const [row]=await db.select().from(analysisExecutions).where(eq(analysisExecutions.id,f.id));
    expect(row.qingzhouWriteback).toMatchObject({status:"saved",reviewStatus:"failed"});
    f.mode("success");expect(await f.sync()).toMatchObject({status:"saved",reviewStatus:"submitted"});
    expect(f.writes()).toBe(1);expect(f.submissions()).toBe(2);
  });
  it("still rejects an actually newer delivered task while excluding itself",async()=>{
    const f=await seed();const [row]=await db.select().from(analysisExecutions).where(eq(analysisExecutions.id,f.id));
    const id=randomUUID();await db.insert(issues).values({id,companyId:f.companyId,projectId:f.projectId,title:"New revision",status:"done"});
    await db.insert(analysisExecutions).values({...row,id,requestId:randomUUID(),createdAt:new Date(Date.now()+1000)});
    expect(await f.sync()).toMatchObject({status:"failed",error:expect.stringContaining("更新的分析交付")});expect(f.writes()).toBe(0);
  });
  it("never falls back to the project account or another seat account",async()=>{
    const f=await seed();
    await db.delete(seatQingzhouAccounts).where(eq(seatQingzhouAccounts.seatId,f.seatId));
    const otherSeatId=randomUUID();
    await db.insert(agents).values({id:otherSeatId,companyId:f.companyId,name:"Other seat",role:"engineer",adapterType:"claude_local",adapterConfig:{dsp7Seat:{}}});
    const [connection]=await db.select().from(deliveryConnections).where(eq(deliveryConnections.companyId,f.companyId));
    await db.insert(seatQingzhouAccounts).values({companyId:f.companyId,seatId:otherSeatId,username:"analyst",credentialSecretId:connection.credentialSecretId});
    expect(await f.sync()).toMatchObject({status:"failed",error:expect.stringContaining("执行席位的接单设置")});
    expect(f.fetcher).not.toHaveBeenCalled();
  });
  it("rejects cross-company access and refuses a demand missing from this project's snapshots",async()=>{
    const f=await seed();await expect(writeAnalysisToQingzhou(db,randomUUID(),f.id,{type:"user",id:"admin"},undefined,{fetch:f.fetcher as typeof fetch,secrets:f.secrets})).rejects.toMatchObject({status:404});
    await db.delete(deliverySnapshots).where(eq(deliverySnapshots.companyId,f.companyId));
    expect(await f.sync()).toMatchObject({status:"failed",error:expect.stringContaining("当前项目同步")});expect(f.fetcher).not.toHaveBeenCalled();
  });
});
