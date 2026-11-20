import { deliveryChainAdmission } from "../services/delivery-chain-admission.js";
import { prepareDeliveryRework } from "../services/delivery-rework.js";
import { deliveryTemplateRoutes } from "./delivery-templates.js";
import { randomUUID, createHash } from "node:crypto";
import express from "express";
import request from "supertest";
import { afterAll, beforeAll, describe, it, expect, vi } from "vitest";
import { eq } from "drizzle-orm";
import {
  createDb,
  companies,
  projects,
  agents,
  deliverySnapshots,
  deliveryWorkflows,
  deliveryWorkflowTemplates,
  analysisExecutions,
  heartbeatRuns,
  seatExecutionPermits,
  issues,
  type Db,
} from "@paperclipai/db";
import {
  DEFAULT_DELIVERY_TEMPLATE as BASE_DELIVERY_TEMPLATE,
  type DeliveryPlan,
  type DeliveryStageReceipt,
  type DeliveryStageRecord,
} from "@paperclipai/shared";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "../__tests__/helpers/embedded-postgres.js";
const DEFAULT_DELIVERY_TEMPLATE = structuredClone(BASE_DELIVERY_TEMPLATE);
DEFAULT_DELIVERY_TEMPLATE.stages.design.entryChecks = ["title"];
const wakes = vi.hoisted(() => ({ call: vi.fn(), cancel: vi.fn() }));
vi.mock("../services/heartbeat.js", () => ({
  heartbeatService: () => ({ wakeup: wakes.call, cancelRun: wakes.cancel }),
}));
const priorJira=vi.hoisted(()=>({read:vi.fn()}));
vi.mock("../services/delivery-prior-jira.js",()=>({readJiraPriorCompletion:priorJira.read}));
const jiraAssignments=vi.hoisted(()=>({accounts:new Map<string,string>()}));
vi.mock("../services/delivery-seat-assignment.js",async original=>({
  ...await original<typeof import("../services/delivery-seat-assignment.js")>(),
  readDeliveryJiraAssignments:async(_db:unknown,_c:string,_p:string,keys:string[])=>new Map(keys.map(key=>[key,{account:jiraAssignments.accounts.get(key)??"owner",displayName:"负责人",origin:"http://jira.fingard.com:6001"}]))
}));
const autoJira=vi.hoisted(()=>({created:new Map<string,string>(),posts:0,timeout:false,hide:false}));
vi.mock("../services/delivery-repair-jira.js",async original=>({
  ...await original<typeof import("../services/delivery-repair-jira.js")>(),
  repairJiraClient:async()=>({origin:"http://jira.fingard.com:6001",
    find:async(spec:any)=>autoJira.hide?null:autoJira.created.get(spec.marker)??null,
    create:async(spec:any)=>{autoJira.posts++;const key="AUTO-"+(100+autoJira.posts);autoJira.created.set(spec.marker,key);jiraAssignments.accounts.set(key,spec.account);if(autoJira.timeout)throw Error("Jira 建单结果不确定");return key;},
  }),
}));
import { deliveryWorkflowRoutes } from "./delivery-workflows.js";
import {
  reconcileDeliveryWorkflow,
  assertDeliveryRun,
} from "../services/delivery-workflows.js";
const support = await getEmbeddedPostgresTestSupport();
(support.supported ? describe : describe.skip)(
  "serial delivery workflow real persistence",
  () => {
    let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>,
      db: Db;
    const c = randomUUID(),
      p = randomUUID(),
      sid = randomUUID(),
      mid = randomUUID(),
      snapshotId = randomUUID(),
      fingerprint = "f".repeat(64),
      lease = randomUUID();
    const cap = (kind: string, roles: string[]) => ({
      id: kind,
      kind,
      roles,
      root: "/isolated/" + kind,
      repository: "git.example.com/" + kind,
      profile: "dsp",
      commit: "a".repeat(40),
      manifestDigest: "b".repeat(64),
      protocolVersion: 1,
      validation: "local-files",
      executionReady: false,
      checkedAt: new Date().toISOString(),
    });
    const cfg = {
      dsp7JiraDispatch:{enabled:true,projectId:p,jiraBaseUrl:"http://jira.fingard.com:6001",jiraAssignee:"owner"},
      dsp7Transport: "outbound",
      dsp7WebJiraIntake: true,
      dsp7Seat: {
        machineId: mid,
        machineFingerprint: fingerprint,
        ownerUserId: "local-board",
      },
      dsp7HarnessCapabilities: {
        version: 1,
        revision: 1,
        items: [
          cap("analysis", ["requirements-analysis"]),
          cap("development", [
            "system-design",
            "coding",
            "bug-fix",
            "code-review",
          ]),
          cap("qa", ["test-cases", "functional-test"]),
        ],
      },
      dsp7SeatPresence: {
        lastSeenAt: new Date().toISOString(),
        state: "idle",
        acceptingWork: true,
        capabilities: ["analysis-execution-v1", "delivery-flow-v1", "delivery-work-review-v1"],
      },
    };
    const config = {
      requestId: randomUUID(),
      snapshotId,
      analysisSeatId: sid,
      developmentSeatId: sid,
      qaSeatId: sid,
      designKey: "T-1",
      codingKey: "T-2",
      testCasesKey: "T-3",
      testExecutionKey: "T-4",
      environmentReference: "https://env.example/release/1",
    };
    const plan: DeliveryPlan = {
      demandId: "1",
      demandNo: "DEMAND-1",
      title: "Isolated requirement",
      status: "开发中",
      roles: [],
      mains: [],
      items: ["系统设计", "编码", "详细测试用例编写", "功能测试"].map(
        (type, i) => ({
          key: `T-${i + 1}`,
          parentKey: "T-100",
          title: type,
          type,
          status: "待受理",
          assignee: "owner",
          scheduled: true,
        }),
      ),
      scheduleCount: 4,
      differences: [],
      fingerprint,
      sourceMode: "online_readonly",
      executionAllowed: false,
    };
    function app(
      agent = false,
      owner = "local-board",
      company = c,
      admin = true,
      actingAgentId: string = sid,
    ) {
      const a = express();
      a.use(express.json());
      a.use((req, _res, next) => {
        req.actor = agent
          ? {
              type: "agent",
              source: "agent_key",
              agentId: actingAgentId,
              companyId: company,
              companyIds: [company],
            }
          : {
              type: "board",
              source: "session",
              userId: owner,
              companyIds: [company],
              memberships: admin
                ? [
                    {
                      companyId: company,
                      membershipRole: "admin",
                      status: "active",
                    },
                  ]
                : [],
            };
        next();
      });
      a.use(deliveryTemplateRoutes(db));
      a.use(deliveryWorkflowRoutes(db));
      a.use((e: any, _req: any, res: any, _next: any) =>
        res.status(e.status ?? 500).json({ error: e.message }),
      );
      return a;
    }
    const base = `/companies/${c}/delivery-workflows`,
      machine = {
        seat_id: sid,
        machine_id: mid,
        machine_fingerprint: fingerprint,
        lease,
      };
    beforeAll(async () => {
      vi.stubEnv("PAPERCLIP_DEPLOYMENT_MODE", "local_trusted");
      database = await startEmbeddedPostgresTestDatabase("delivery-flow-");
      db = createDb(database.connectionString);
      await db
        .insert(companies)
        .values({ id: c, name: "Flow Test", issuePrefix: "F" + c.slice(0, 6) });
      await db
        .insert(projects)
        .values({ id: p, companyId: c, name: "Flow Project" });
      await db.insert(agents).values({
        id: sid,
        companyId: c,
        name: "All domains test seat",
        role: "engineer",
        status: "idle",
        adapterType: "claude_local",
        adapterConfig: cfg,
      });
      const legacy = structuredClone(DEFAULT_DELIVERY_TEMPLATE);
      Object.values(legacy.stages).forEach(s=>delete s.taskSequence);
      legacy.stages.analysis.enabled = true;
      legacy.stages.analysis.entryChecks = ["title"];
      legacy.stages["test-cases"].review = "seat_owner";
      legacy.codingExecution = "serial";
      await db
        .insert(deliveryWorkflowTemplates)
        .values({
          companyId: c,
          scopeKey: "organization",
          revision: 1,
          definition: legacy,
          createdBy: "local-board",
        });
      await db.insert(deliverySnapshots).values({
        id: snapshotId,
        companyId: c,
        projectId: p,
        sourceOrigin: "https://proj.fingard.com:1888",
        demandNo: plan.demandNo,
        fingerprint,
        collectedAt: new Date(),
        createdByUserId: "local-board",
        plan,
      });
      wakes.call.mockImplementation(async (agentId, opts) => {
        const [r] = await db
          .insert(heartbeatRuns)
          .values({
            companyId: c,
            agentId,
            status: "running",
            contextSnapshot: opts.contextSnapshot,
          })
          .returning();
        return r;
      });
    }, 30000);
    afterAll(async () => {
      await database?.cleanup();
      vi.unstubAllEnvs();
    });
    async function flow(id: string) {
      return (
        await db
          .select()
          .from(deliveryWorkflows)
          .where(eq(deliveryWorkflows.id, id))
      )[0]!;
    }
    it("refuses substitute Jira creation when an existing workflow lacks its original coding and review nodes",async()=>{
      autoJira.created.clear();autoJira.posts=0;autoJira.timeout=false;autoJira.hide=false;
      const projectId=randomUUID(),snapshot=randomUUID(),dev=randomUUID(),review=randomUUID(),qa=randomUUID();
      await db.insert(projects).values({id:projectId,companyId:c,name:"Automatic repair"});
      for(const [id,account] of [[dev,"auto-dev"],[review,"auto-review"],[qa,"auto-qa"]])await db.insert(agents).values({id,companyId:c,name:account,role:"engineer",status:"idle",adapterType:"claude_local",adapterConfig:{...cfg,dsp7JiraDispatch:{...cfg.dsp7JiraDispatch,projectId,jiraAssignee:account},dsp7SeatPresence:{...cfg.dsp7SeatPresence,capabilities:["delivery-flow-v1","delivery-work-review-v1","delivery-executor-v1","delivery-rework-v1","delivery-auto-repair-v1", "delivery-reuse-repair-v1"]}}});
      const definition=structuredClone(DEFAULT_DELIVERY_TEMPLATE);for(const [key,policy] of Object.entries(definition.stages))policy.enabled=key==="functional-test";
      definition.stages["functional-test"].entryChecks=["title"];
      definition.automaticRepair={maxCycles:2,jiraProjectKey:"AUTO",defectIssueTypeId:"1",fixIssueTypeId:"2",reviewIssueTypeId:"3",retestIssueTypeId:"4",buildObservationUrl:"https://env.example/version",routes:[{module:"payments",developmentSeatId:dev,reviewSeatId:review,qaSeatId:qa}]};
      await db.insert(deliveryWorkflowTemplates).values({companyId:c,projectId,scopeKey:projectId,revision:1,definition,createdBy:"local-board"});
      const source={...plan,demandNo:"AUTOMATIC-1",items:[{...plan.items[3],key:"AUTO-1",parentKey:"AUTO-0"}]};
      jiraAssignments.accounts.set("AUTO-1","auto-qa");
      await db.insert(deliverySnapshots).values({id:snapshot,companyId:c,projectId,sourceOrigin:"https://proj.fingard.com:1888",demandNo:source.demandNo,fingerprint,collectedAt:new Date(),createdByUserId:"local-board",plan:source});
      const input={...config,requestId:randomUUID(),snapshotId:snapshot,analysisSeatId:"",developmentSeatId:"",qaSeatId:qa,testExecutionKey:"AUTO-1"};
      const denied=await request(app()).post(base).send(input);expect(denied.status).toBe(409);expect(denied.body.error).toContain("授权");
      const started=await request(app()).post(base).send({...input,automaticRepairAuthorized:true});expect(started.status,JSON.stringify(started.body)).toBe(201);
      const id=started.body.id;const current=await flow(id);const stage=current.stages[0];
      const [run]=await db.insert(heartbeatRuns).values({companyId:c,agentId:qa,status:"succeeded"}).returning();
      stage.runId=run.id;stage.state="review";stage.receiptDigest="c".repeat(64);
      stage.receipt={protocolVersion:1,taskId:stage.taskId,runId:run.id,stage:"functional-test",jiraKey:"AUTO-1",inputDigest:stage.inputDigest,stateDigest:"a".repeat(64),trackerReceiptId:"42",jiraReference:"http://jira.fingard.com:6001/browse/AUTO-1",artifacts:[{path:"execution-records.md",sha256:"b".repeat(64)}],testResults:{total:1,passed:0,failed:1,blocked:0,skipped:0,testedVersion:"bad-build",sourcePath:"execution-records.md",sourceSha256:"b".repeat(64)},failureReport:{sourcePath:"delivery-failures.json",sourceSha256:"d".repeat(64),defects:[{caseId:"C1",module:"payments",kind:"product",summary:"failure",steps:"reproduce",expected:"success",actual:"failed"}]}};
      await db.insert(seatExecutionPermits).values({companyId:c,agentId:qa,taskId:stage.taskId,runId:run.id,machineId:mid,leaseHash:"auto-fixture",expiresAt:new Date(Date.now()+60000),treeStopVerifiedAt:new Date()});
      await db.update(deliveryWorkflows).set({stages:current.stages,state:"blocked"}).where(eq(deliveryWorkflows.id,id));
      await reconcileDeliveryWorkflow(db,id);
      const stopped=await flow(id);
      expect(stopped.state).toBe("blocked");expect(stopped.message).toContain("原编码单");
      expect(autoJira.posts).toBe(0);expect(stopped.stages).toHaveLength(1);
      expect(stopped.stages[0].taskId).toBe(stage.taskId);
    });
    it.each(["manual","jira"] as const)("takes over only unfinished parallel coding work and preserves completed branches (%s)",async mode=>{
      const projectId=randomUUID(),snapshot=randomUUID(),seat=randomUUID(),prefix=mode==="jira"?"JPART":"MPART";
      await db.insert(projects).values({id:projectId,companyId:c,name:"Partial coding "+mode});
      await db.insert(agents).values({id:seat,companyId:c,name:"Partial coding seat",role:"engineer",status:"idle",adapterType:"claude_local",adapterConfig:{...cfg,dsp7JiraDispatch:{...cfg.dsp7JiraDispatch,projectId}}});
      const definition=structuredClone(DEFAULT_DELIVERY_TEMPLATE);
      for(const [kind,policy] of Object.entries(definition.stages))policy.enabled=kind==="coding";
      Object.assign(definition.stages.coding,{taskSequence:"work_only",review:"none",entryChecks:["title"]});
      await db.insert(deliveryWorkflowTemplates).values({companyId:c,projectId,scopeKey:projectId,revision:1,definition,createdBy:"local-board"});
      const source={...plan,demandNo:"PARTIAL-"+snapshot,items:[{...plan.items[1],key:prefix+"-1",parentKey:prefix+"-100",status:"已完成"},{...plan.items[1],key:prefix+"-2",parentKey:prefix+"-100"}]};
      await db.insert(deliverySnapshots).values({id:snapshot,companyId:c,projectId,sourceOrigin:"https://proj.fingard.com:1888",demandNo:source.demandNo,fingerprint,collectedAt:new Date(),createdByUserId:"local-board",plan:source});
      const evidence={stage:"coding",jiraKey:prefix+"-1",version:"prior-v1",artifactReferences:["https://jira.example/secure/attachment/1/old.md"],reviewReference:"https://jira.example/browse/"+prefix+"-1"};
      const previous=priorJira.read.getMockImplementation();priorJira.read.mockImplementation(async()=>evidence);
      try {
        const input={...config,requestId:randomUUID(),snapshotId:snapshot,analysisSeatId:"",developmentSeatId:seat,qaSeatId:"",workTasks:[{stage:"coding",jiraKey:prefix+"-1",seatId:""},{stage:"coding",jiraKey:prefix+"-2",seatId:seat}],priorCompletions:[mode==="jira"?{stage:"coding",jiraKey:prefix+"-1",source:"jira"}:evidence]};
        const started=await request(app()).post(base).send(input);expect(started.status,started.text).toBe(201);
        const current=await flow(started.body.id);expect(current.stages[0].state).toBe("done");expect(current.stages[0].runId).toBeNull();
        await reconcileDeliveryWorkflow(db,current.id);const live=await flow(current.id);
        expect(live.stages[0].runId).toBeNull();expect(live.stages[1].runId,live.message??"").toBeTruthy();expect(live.stages[1].seatId).toBe(seat);
        expect(live.config.template?.definition).toEqual(definition);
      } finally {if(previous)priorJira.read.mockImplementation(previous);else priorJira.read.mockReset();}
    });
    it("takes over an instance with verified prior work without seats or reruns and keeps the template", async () => {
      const projectId=randomUUID(), snapshot=randomUUID();
      await db.insert(projects).values({id:projectId,companyId:c,name:"Midstream takeover"});
      const definition=structuredClone(DEFAULT_DELIVERY_TEMPLATE);
      for(const [key,policy] of Object.entries(definition.stages)) policy.enabled=["analysis","design"].includes(key);
      definition.stages.analysis.entryChecks=["title"];
      definition.stages.design.taskSequence="work_then_review";
      definition.stages.design.reviewExecution="human";
      definition.stages.design.reviewExecutorUserId="local-board";
      await db.insert(deliveryWorkflowTemplates).values({companyId:c,projectId,scopeKey:projectId,revision:1,definition,createdBy:"local-board"});
      const source={...plan,demandNo:"TAKEOVER-1",items:[{...plan.items[0],key:"TAKE-1",status:"已完成"},{...plan.items[0],key:"TAKE-2",type:"设计评审",status:"待受理"}]};
      await db.insert(deliverySnapshots).values({id:snapshot,companyId:c,projectId,sourceOrigin:"https://proj.fingard.com:1888",demandNo:source.demandNo,fingerprint,collectedAt:new Date(),createdByUserId:"local-board",plan:source});
      const evidence={version:"v1",artifactReferences:["https://docs.example/result"],reviewReference:"https://docs.example/approval"};
      const input={...config,requestId:randomUUID(),snapshotId:snapshot,analysisSeatId:"",developmentSeatId:"",qaSeatId:"",designKey:"TAKE-1",reviewTasks:[{stage:"design",jiraKey:"TAKE-2",workKeys:["TAKE-1"]}],priorCompletions:[{...evidence,stage:"analysis",jiraKey:null},{...evidence,stage:"design",jiraKey:"TAKE-1",reviewReference:"https://jira.example/browse/TAKE-1"}]};
      const missingEvidence=await request(app()).post(base).send({...input,priorCompletions:[{...input.priorCompletions[0],artifactReferences:[]}]});expect(missingEvidence.status).toBe(400);
      const orphan=await request(app()).post(base).send({...input,analysisSeatId:sid,priorCompletions:[input.priorCompletions[1]]});expect(orphan.status).toBe(409);expect(orphan.body.error).toContain("前置");
      const duplicate=await request(app()).post(base).send({...input,priorCompletions:[...input.priorCompletions,input.priorCompletions[0]]});expect(duplicate.status).toBe(409);
      const unfinished=await request(app()).post(base).send({...input,priorCompletions:[...input.priorCompletions,{...evidence,stage:"design",jiraKey:"TAKE-2",reviewReference:"https://jira.example/browse/TAKE-2"}]});expect(unfinished.status).toBe(409);expect(unfinished.body.error).toContain("尚未完成");
      const unauthorized=await request(app(false,"outsider",c,false)).post(base).send(input);expect(unauthorized.status).toBe(403);
      const started=await request(app()).post(base).send(input);expect(started.status,JSON.stringify(started.body)).toBe(201);
      const id=started.body.id;expect(started.body.config.template.definition).toEqual(definition);
      expect(started.body.stages.map((s:any)=>s.state)).toEqual(["done","done","pending"]);
      expect(started.body.stages[0]).toMatchObject({seatId:"",runId:null,receipt:null,priorCompletion:{by:"local-board",snapshotId:snapshot}});
      const repeat=await request(app()).post(base).send(input);expect(repeat.body.id).toBe(id);
      const priorWakes=wakes.call.mock.calls.length;
      await reconcileDeliveryWorkflow(db,id);
      const current=await flow(id);expect(current.stages[2].state).toBe("review");expect(current.stages[2].inputDigest).toMatch(/^[a-f0-9]{64}$/);
      expect(wakes.call.mock.calls.length).toBe(priorWakes);
      expect((await db.select().from(analysisExecutions).where(eq(analysisExecutions.id,current.stages[0].taskId)))).toHaveLength(0);
      expect((await db.select().from(issues).where(eq(issues.id,current.stages[1].taskId)))[0].status).toBe("done");
    });
    it("binds current Jira assignees on the server and refuses a later owner change without transferring",async()=>{
      const projectId=randomUUID(),snapshot=randomUUID(),seatId=randomUUID();
      await db.insert(projects).values({id:projectId,companyId:c,name:"Owner binding"});
      await db.insert(agents).values({id:seatId,companyId:c,name:"Owner seat",role:"engineer",status:"idle",adapterType:"claude_local",adapterConfig:{...cfg,dsp7JiraDispatch:{...cfg.dsp7JiraDispatch,projectId}}});
      const source:DeliveryPlan={...plan,demandNo:"OWNER-00001",items:[{key:"OWNER-1",parentKey:"OWNER-0",type:"系统设计",title:"设计",status:"待受理",assignee:"旧的显示姓名",scheduled:true}]};
      await db.insert(deliverySnapshots).values({id:snapshot,companyId:c,projectId,sourceOrigin:"https://proj.fingard.com:1888",demandNo:source.demandNo,fingerprint,collectedAt:new Date(),createdByUserId:"local-board",plan:source});
      const definition=structuredClone(DEFAULT_DELIVERY_TEMPLATE);for(const [key,policy] of Object.entries(definition.stages))policy.enabled=key==="design";Object.assign(definition.stages.design,{taskSequence:"work_only",entryChecks:["title"],review:"none",workExecution:"agent"});
      await db.insert(deliveryWorkflowTemplates).values({companyId:c,projectId,scopeKey:projectId,revision:1,definition,createdBy:"local-board"});
      const input={...config,requestId:randomUUID(),snapshotId:snapshot,analysisSeatId:"",developmentSeatId:"",qaSeatId:"",designKey:"OWNER-1",codingKey:"",testCasesKey:"",testExecutionKey:""};
      const wrong=await request(app()).post(base).send({...input,workSeats:[{jiraKey:"OWNER-1",seatId:sid}]});expect(wrong.status).toBe(409);expect(wrong.body.error).toContain("不属于");
      const listed=await request(app()).get(base+"/seats?snapshotId="+snapshot);expect(listed.status).toBe(200);expect(listed.body.find((s:any)=>s.id===seatId).jiraKeys).toEqual(["OWNER-1"]);expect(listed.body.find((s:any)=>s.id===sid).jiraKeys).toEqual([]);
      const started=await request(app()).post(base).send(input);expect(started.status,JSON.stringify(started.body)).toBe(201);expect(started.body.stages[0].seatId).toBe(seatId);expect(started.body.config.seatAssignment).toBe("jira_assignee");
      const repeated=await request(app()).post(base).send(input);expect(repeated.status,JSON.stringify(repeated.body)).toBe(201);expect(repeated.body.id).toBe(started.body.id);
      jiraAssignments.accounts.set("OWNER-1","changed-owner");await reconcileDeliveryWorkflow(db,started.body.id);const [changed]=await db.select().from(deliveryWorkflows).where(eq(deliveryWorkflows.id,started.body.id));expect(changed.stages[0].seatId).toBe(seatId);expect(changed.message).toContain("经办人或席位账号配置已变化");jiraAssignments.accounts.delete("OWNER-1");
    });
    it("enforces configurable entry checks before creating tasks and keeps admitted chains admitted",async()=>{
      const projectId=randomUUID(),snap=randomUUID();
      await db.insert(projects).values({id:projectId,companyId:c,name:"Entry checks"});
      const entryPlan:DeliveryPlan={...plan,roles:[],demandNo:"ENTRY-00001",items:[{key:"ENTRY-1",parentKey:"ENTRY-0",title:"Design",type:"系统设计",status:"待处理",assignee:"",scheduled:true}]};
      await db.insert(deliverySnapshots).values({id:snap,companyId:c,projectId,sourceOrigin:"https://proj.fingard.com:1888",demandNo:entryPlan.demandNo,fingerprint,collectedAt:new Date(),createdByUserId:"local-board",plan:entryPlan});
      const definition=structuredClone(DEFAULT_DELIVERY_TEMPLATE);
      for(const stage of Object.keys(definition.stages) as (keyof typeof definition.stages)[])definition.stages[stage].enabled=stage==="design";
      Object.assign(definition.stages.design,{entryChecks:["title","owner"],taskSequence:"work_only",workExecution:"human",workExecutorUserId:"local-board",review:"none"});
      const templateBase=`/companies/${c}/delivery-templates`;
      const unconfigured=structuredClone(definition);delete unconfigured.stages.design.entryChecks;
      expect((await request(app()).post(templateBase).send({projectId,expectedRevision:0,definition:unconfigured})).status).toBe(400);
      expect((await request(app()).post(templateBase).send({projectId,expectedRevision:0,definition})).status).toBe(201);
      const input={...config,requestId:randomUUID(),snapshotId:snap,analysisSeatId:"",developmentSeatId:"",qaSeatId:"",designKey:"ENTRY-1",codingKey:"",testCasesKey:"",testExecutionKey:""};
      const rejected=await request(app()).post(base).send(input);
      expect(rejected.status).toBe(409);expect(rejected.body.error).toContain("需求拆分人员");
      expect(await db.select().from(deliveryWorkflows).where(eq(deliveryWorkflows.projectId,projectId))).toHaveLength(0);
      definition.stages.design.entryChecks=["title"];
      expect((await request(app()).post(templateBase).send({projectId,expectedRevision:1,definition})).status).toBe(201);
      const created=await request(app()).post(base).send(input);
      expect(created.status,JSON.stringify(created.body)).toBe(201);
      definition.stages.design.entryChecks=["owner"];
      expect((await request(app()).post(templateBase).send({projectId,expectedRevision:2,definition})).status).toBe(201);
      const [snapshot]=await db.select().from(deliverySnapshots).where(eq(deliverySnapshots.id,snap));
      const admission=await deliveryChainAdmission(db,snapshot);
      expect(admission).toMatchObject({state:"admitted",ready:true,template:{revision:2}});
    });
    it("runs the complete serial chain, rejects stale/foreign inputs and gates on real receipts, review, process exit and acceptance", async () => {
      expect(
        (
          await request(app(false, "other", c, false))
            .post(base)
            .send(config)
        ).status,
      ).toBe(403);
      const created = await request(app()).post(base).send(config);
      expect(created.status, JSON.stringify(created.body)).toBe(201);
      const id = created.body.id;
      const again = await request(app()).post(base).send(config);
      expect(again.status, JSON.stringify(again.body)).toBe(201);
      expect(again.body.id).toBe(id);
      expect((await flow(id)).stages).toHaveLength(5);
      expect(
        (await request(app(false, "other", c, false)).get(base + "/" + id))
          .status,
      ).toBe(404);
      expect(
        (
          await request(app(false, "local-board", randomUUID())).get(
            base + "/" + id,
          )
        ).status,
      ).toBe(403);
      const initialWakes = wakes.call.mock.calls.length;
      await reconcileDeliveryWorkflow(db, id);
      expect(wakes.call).toHaveBeenCalledTimes(initialWakes + 1);
      await reconcileDeliveryWorkflow(db, id);
      expect(wakes.call).toHaveBeenCalledTimes(initialWakes + 1);
      const [analysis] = await db
        .select()
        .from(analysisExecutions)
        .where(eq(analysisExecutions.id, created.body.stages[0].taskId));
      expect(analysis.activeRunId).toBeTruthy();
      // Publication is the existing independently tested analysis protocol, not adapter exit.
      await db
        .update(analysisExecutions)
        .set({
          state: "published",
          delivery: { inputDigest: "a", handoffDigest: "h" } as any,
          publication: {
            url: "https://formal.example/analysis",
            inputDigest: "a",
            handoffDigest: "h",
          } as any,
        })
        .where(eq(analysisExecutions.id, analysis.id));
      await db
        .update(heartbeatRuns)
        .set({ status: "succeeded" })
        .where(eq(heartbeatRuns.id, analysis.activeRunId!));
      await reconcileDeliveryWorkflow(db, id);
      expect((await flow(id)).stages[0].state).not.toBe("done");
      expect((await flow(id)).message).toContain("进程树退出核验");
      await db.insert(seatExecutionPermits).values({
        companyId: c,
        agentId: sid,
        taskId: analysis.id,
        runId: analysis.activeRunId!,
        machineId: mid,
        leaseHash: createHash("sha256").update(lease).digest("hex"),
        expiresAt: new Date(Date.now() + 600000),
        treeStopVerifiedAt: new Date(),
      });
      await reconcileDeliveryWorkflow(db, id);
      for (const stageName of [
        "design",
        "coding",
        "test-cases",
        "functional-test",
      ]) {
        const priorWakes = wakes.call.mock.calls.length;
        await db
          .update(agents)
          .set({
            adapterConfig: {
              ...cfg,
              dsp7SeatPresence: { ...cfg.dsp7SeatPresence, state: "busy", acceptingWork: false },
            },
          })
          .where(eq(agents.id, sid));
        await reconcileDeliveryWorkflow(db, id);
        expect(wakes.call.mock.calls.length).toBe(priorWakes);
        await db
          .update(agents)
          .set({ adapterConfig: cfg })
          .where(eq(agents.id, sid));
        await reconcileDeliveryWorkflow(db, id);
        let f = await flow(id);
        let s = f.stages.find((x) => x.stage === stageName)!;
        expect(s.runId).toBeTruthy();
        expect(
          f.stages.filter((s) => s.runId && s.state !== "done"),
        ).toHaveLength(1);
        await assertDeliveryRun(db, c, sid, s.runId!);
        await db.insert(seatExecutionPermits).values({
          companyId: c,
          agentId: sid,
          taskId: s.taskId,
          runId: s.runId!,
          machineId: mid,
          leaseHash: createHash("sha256").update(lease).digest("hex"),
          expiresAt: new Date(Date.now() + 600000),
        });
        const cb = `/agents/${sid}/delivery-runs/${s.runId}`;
        if (stageName === "design") {
          expect(
            (
              await request(app(true))
                .post(cb + "/question")
                .send({
                  ...machine,
                  text: "确认本次设计范围？",
                  digest: "d".repeat(64),
                })
            ).status,
          ).toBe(200);
          expect(
            (
              await request(app())
                .post(base + `/${id}/answer`)
                .send({
                  taskId: s.taskId,
                  digest: "e".repeat(64),
                  answer: "按当前需求",
                })
            ).status,
          ).toBe(409);
          expect(
            (
              await request(app())
                .post(base + `/${id}/answer`)
                .send({
                  taskId: s.taskId,
                  digest: "d".repeat(64),
                  answer: "按当前需求",
                })
            ).status,
          ).toBe(200);
          const q = await request(app(true))
            .post(cb + "/question")
            .send({
              ...machine,
              text: "确认本次设计范围？",
              digest: "d".repeat(64),
            });
          expect(q.body.answer).toBe("按当前需求");
        }
        const receipt: DeliveryStageReceipt = {
          protocolVersion: 1,
          taskId: s.taskId,
          runId: s.runId!,
          stage: s.stage,
          jiraKey: s.jiraKey!,
          inputDigest: s.inputDigest,
          stateDigest: "b".repeat(64),
          trackerReceiptId: "42",
          jiraReference: "http://jira.example/browse/" + s.jiraKey,
          artifacts: [
            {
              path:
                s.stage === "functional-test"
                  ? "execution-records.md"
                  : "result.md",
              sha256: "c".repeat(64),
            },
          ],
          ...(s.stage === "functional-test"
            ? {
                testResults: {
                  total: 1,
                  passed: 1,
                  failed: 0,
                  blocked: 0,
                  skipped: 0,
                  testedVersion: "fixture-build-1",
                  sourcePath: "execution-records.md" as const,
                  sourceSha256: "c".repeat(64),
                },
              }
            : {}),
        };
        expect(
          (
            await request(app(true))
              .post(cb + "/delivery")
              .send({ ...machine, lease: randomUUID(), receipt })
          ).status,
        ).toBe(409);
        expect(
          (
            await request(app(true))
              .post(cb + "/delivery")
              .send({
                ...machine,
                receipt: { ...receipt, inputDigest: "0".repeat(64) },
              })
          ).status,
        ).toBe(409);
        expect(
          (
            await request(app(true))
              .post(cb + "/delivery")
              .send({ ...machine, receipt })
          ).status,
        ).toBe(200);
        expect(
          (
            await request(app(true))
              .post(cb + "/delivery")
              .send({ ...machine, receipt })
          ).status,
        ).toBe(200); // exact retry is safe
        await reconcileDeliveryWorkflow(db, id);
        f = await flow(id);
        s = f.stages.find((x) => x.stage === stageName)!;
        expect(s.state).toBe("review");
        if (["design", "test-cases"].includes(stageName)) {
          expect(
            (
              await request(app())
                .post(base + `/${id}/review`)
                .send({
                  taskId: s.taskId,
                  digest: "0".repeat(64),
                  decision: "approve",
                  reference: "https://formal.example/review",
                  note: "通过",
                })
            ).status,
          ).toBe(409);
          expect(
            (
              await request(app())
                .post(base + `/${id}/review`)
                .send({
                  taskId: s.taskId,
                  digest: s.receiptDigest,
                  decision: "approve",
                  reference: "https://formal.example/review",
                  note: "核验本版本正式通过",
                })
            ).status,
          ).toBe(200);
        }
        await db
          .update(heartbeatRuns)
          .set({ status: "succeeded" })
          .where(eq(heartbeatRuns.id, s.runId!));
        await reconcileDeliveryWorkflow(db, id);
        expect(
          (await flow(id)).stages.find((x) => x.stage === stageName)!.state,
        ).not.toBe("done");
        await db
          .update(seatExecutionPermits)
          .set({ treeStopVerifiedAt: new Date() })
          .where(eq(seatExecutionPermits.runId, s.runId!));
        await reconcileDeliveryWorkflow(db, id);
        expect(
          (await flow(id)).stages.find((x) => x.stage === stageName)!.state,
        ).toBe("done");
      }
      await reconcileDeliveryWorkflow(db, id);
      expect((await flow(id)).state).toBe("acceptance");
      expect(
        (
          await request(app())
            .post(base + `/${id}/accept`)
            .send({
              fingerprint: "old",
              reference: "https://formal.example/accept",
              note: "通过",
            })
        ).status,
      ).toBe(409);
      expect(
        (
          await request(app())
            .post(base + `/${id}/accept`)
            .send({
              fingerprint,
              reference: "https://formal.example/accept",
              note: "正式验收已通过",
            })
        ).status,
      ).toBe(200);
      expect((await flow(id)).state).toBe("completed");
      await reconcileDeliveryWorkflow(db, id);
      expect(wakes.call).toHaveBeenCalledTimes(initialWakes + 5);
    }, 30000);

    async function freshCase(n: number) {
      const nextSnapshot = randomUUID(),
        nextPlan = {
          ...plan,
          demandNo: `DEMAND-${n}`,
          items: plan.items.map((x, i) => ({
            ...x,
            key: `N${n}-${i + 1}`,
            parentKey: `N${n}-100`,
          })),
        };
      await db.insert(deliverySnapshots).values({
        id: nextSnapshot,
        companyId: c,
        projectId: p,
        sourceOrigin: "https://proj.fingard.com:1888",
        demandNo: nextPlan.demandNo,
        fingerprint,
        collectedAt: new Date(),
        createdByUserId: "local-board",
        plan: nextPlan,
      });
      const input = {
        ...config,
        requestId: randomUUID(),
        snapshotId: nextSnapshot,
        designKey: `N${n}-1`,
        codingKey: `N${n}-2`,
        testCasesKey: `N${n}-3`,
        testExecutionKey: `N${n}-4`,
      };
      const response = await request(app()).post(base).send(input);
      expect(response.status, JSON.stringify(response.body)).toBe(201);
      return { id: response.body.id as string, nextPlan, nextSnapshot };
    }
    it("blocks acceptance for failed, blocked, skipped or unknown QA results even after verified exit", async () => {
      for (const [index, results] of [
        undefined,
        { total: 1, passed: 0, failed: 1, blocked: 0, skipped: 0 },
        { total: 1, passed: 0, failed: 0, blocked: 1, skipped: 0 },
        { total: 1, passed: 0, failed: 0, blocked: 0, skipped: 1 },
      ].entries()) {
        const { id } = await freshCase(10 + index);
        const current = await flow(id);
        current.stages.slice(0, 4).forEach((stage) => {
          stage.state = "done";
        });
        const stage = current.stages[4];
        await db
          .update(issues)
          .set({ status: "in_review" })
          .where(eq(issues.id, stage.taskId));
        const [run] = await db
          .insert(heartbeatRuns)
          .values({ companyId: c, agentId: sid, status: "succeeded" })
          .returning();
        stage.runId = run.id;
        stage.state = "review";
        stage.receiptDigest = "c".repeat(64);
        stage.receipt = {
          protocolVersion: 1,
          taskId: stage.taskId,
          runId: run.id,
          stage: "functional-test",
          jiraKey: stage.jiraKey!,
          inputDigest: stage.inputDigest,
          stateDigest: "a".repeat(64),
          trackerReceiptId: "42",
          jiraReference: "https://jira.example/browse/" + stage.jiraKey,
          artifacts: [{ path: "execution-records.md", sha256: "b".repeat(64) }],
          ...(results
            ? {
                testResults: {
                  ...results,
                  testedVersion: "build-123",
                  sourcePath: "execution-records.md" as const,
                  sourceSha256: "b".repeat(64),
                },
              }
            : {}),
        };
        await db
          .insert(seatExecutionPermits)
          .values({
            companyId: c,
            agentId: sid,
            taskId: stage.taskId,
            runId: run.id,
            machineId: mid,
            leaseHash: "fixture",
            expiresAt: new Date(Date.now() + 60000),
            treeStopVerifiedAt: new Date(),
          });
        await db
          .update(deliveryWorkflows)
          .set({ stages: current.stages })
          .where(eq(deliveryWorkflows.id, id));
        const before = wakes.call.mock.calls.length;
        await reconcileDeliveryWorkflow(db, id);
        const blocked = await flow(id);
        expect(blocked.state).toBe("blocked");
        expect(blocked.stages[4].state).not.toBe("done");
        expect(blocked.message).toContain("报告交付不等于测试通过");
        expect(wakes.call.mock.calls.length).toBe(before);
        expect(
          (await db.select().from(issues).where(eq(issues.id, stage.taskId)))[0]
            .status,
        ).toBe("in_review");
      }
    });
    it("refuses manual replacement tickets without an existing-task repair policy", async () => {
      const { id } = await freshCase(30);
      const current = await flow(id);
      current.stages.slice(0, 4).forEach((stage) => {
        stage.state = "done";
      });
      const failed = current.stages[4];
      const [run] = await db
        .insert(heartbeatRuns)
        .values({ companyId: c, agentId: sid, status: "succeeded" })
        .returning();
      failed.runId = run.id;
      failed.state = "review";
      failed.receiptDigest = "c".repeat(64);
      failed.receipt = {
        protocolVersion: 1,
        taskId: failed.taskId,
        runId: run.id,
        stage: "functional-test",
        jiraKey: failed.jiraKey!,
        inputDigest: failed.inputDigest,
        stateDigest: "a".repeat(64),
        trackerReceiptId: "42",
        jiraReference: "https://jira.example/browse/" + failed.jiraKey,
        artifacts: [{ path: "execution-records.md", sha256: "b".repeat(64) }],
        testResults: {
          total: 1,
          passed: 0,
          failed: 1,
          blocked: 0,
          skipped: 0,
          testedVersion: "build-123",
          sourcePath: "execution-records.md",
          sourceSha256: "b".repeat(64),
        },
      };
      await db
        .insert(seatExecutionPermits)
        .values({
          companyId: c,
          agentId: sid,
          taskId: failed.taskId,
          runId: run.id,
          machineId: mid,
          leaseHash: "fixture",
          expiresAt: new Date(Date.now() + 60000),
          treeStopVerifiedAt: new Date(),
        });
      await db
        .update(deliveryWorkflows)
        .set({ stages: current.stages, state: "blocked" })
        .where(eq(deliveryWorkflows.id, id));
      const reviewer = randomUUID();
      await db
        .insert(agents)
        .values({
          id: reviewer,
          companyId: c,
          name: "Independent reviewer",
          role: "engineer",
          status: "idle",
          adapterType: "claude_local",
          adapterConfig: cfg,
        });
      const input = {
        expectedReceiptDigest: failed.receiptDigest,
        defectKey: "REPAIR-1",
        reviewKey: "REVIEW-1",
        retestKey: "RETEST-1",
        developmentSeatId: sid,
        reviewSeatId: reviewer,
        qaSeatId: sid,
      };
      const endpoint = base + "/" + id + "/repair";
      const before = await db.select().from(issues).where(eq(issues.companyId,c));
      const denied=await request(app()).post(endpoint).send(input);
      expect(denied.status).toBe(409);expect(denied.body.error).toContain("策略");
      expect(await db.select().from(issues).where(eq(issues.companyId,c))).toEqual(before);
      expect((await flow(id)).stages.map(s=>s.taskId)).toEqual(current.stages.map(s=>s.taskId));
    });
    it("bounds explicit resumes and clears stale evidence without dispatching automatically", async () => {
      const { id } = await freshCase(4);
      const original = await flow(id);
      original.stages[0].state = "done";
      const stage = original.stages[1];
      stage.state = "interrupted";
      stage.receiptDigest = "a".repeat(64);
      stage.review = {
        decision: "approve",
        digest: "a".repeat(64),
        reference: "https://jira.example/browse/T-1",
        note: "old",
        by: "local-board",
        at: new Date().toISOString(),
      };
      const before = wakes.call.mock.calls.length;
      await db
        .update(deliveryWorkflows)
        .set({ stages: original.stages })
        .where(eq(deliveryWorkflows.id, id));
      for (let attempt = 1; attempt <= 3; attempt++) {
        const response = await request(app())
          .post(base + "/" + id + "/retry")
          .send({});
        expect(response.status, JSON.stringify(response.body)).toBe(200);
        const current = await flow(id),
          resumed = current.stages[1];
        expect(resumed.resumeCount).toBe(attempt);
        expect(resumed.state).toBe("pending");
        expect(resumed.review).toBeNull();
        expect(resumed.receiptDigest).toBeNull();
        expect(resumed.receipt).toBeNull();
        resumed.state = "interrupted";
        await db
          .update(deliveryWorkflows)
          .set({ stages: current.stages })
          .where(eq(deliveryWorkflows.id, id));
      }
      expect(
        (
          await request(app())
            .post(base + "/" + id + "/retry")
            .send({})
        ).status,
      ).toBe(409);
      expect((await flow(id)).stages[1].resumeCount).toBe(3);
      expect(wakes.call.mock.calls.length).toBe(before);
    });
    it("preserves offline queues and blocks automatic advancement when a newer source fingerprint arrives", async () => {
      const { id, nextPlan } = await freshCase(2),
        before = wakes.call.mock.calls.length;
      await db
        .update(agents)
        .set({
          adapterConfig: {
            ...cfg,
            dsp7SeatPresence: {
              ...cfg.dsp7SeatPresence,
              lastSeenAt: new Date(0).toISOString(),
            },
          },
        })
        .where(eq(agents.id, sid));
      await reconcileDeliveryWorkflow(db, id);
      expect(wakes.call.mock.calls.length).toBe(before);
      expect((await flow(id)).state).toBe("active");
      expect((await flow(id)).message).toContain("离线");
      await db.insert(deliverySnapshots).values({
        companyId: c,
        projectId: p,
        sourceOrigin: "https://proj.fingard.com:1888",
        demandNo: nextPlan.demandNo,
        fingerprint: "0".repeat(64),
        collectedAt: new Date(Date.now() + 1000),
        createdByUserId: "local-board",
        plan: { ...nextPlan, fingerprint: "0".repeat(64) },
      });
      await db
        .update(agents)
        .set({ adapterConfig: cfg })
        .where(eq(agents.id, sid));
      await reconcileDeliveryWorkflow(db, id);
      expect((await flow(id)).state).toBe("blocked");
      expect(wakes.call.mock.calls.length).toBe(before);
    });
    it("does not reuse a queued grant after the seat becomes unavailable and cancels future stages durably", async () => {
      const { id } = await freshCase(3);
      const f = await flow(id);
      f.stages[0].state = "done";
      f.stages[1].state = "queued";
      await db
        .update(deliveryWorkflows)
        .set({ stages: f.stages })
        .where(eq(deliveryWorkflows.id, id));
      const before = wakes.call.mock.calls.length;
      await db
        .update(agents)
        .set({
          adapterConfig: {
            ...cfg,
            dsp7SeatPresence: { ...cfg.dsp7SeatPresence, state: "busy", acceptingWork: false },
          },
        })
        .where(eq(agents.id, sid));
      await reconcileDeliveryWorkflow(db, id);
      expect(wakes.call.mock.calls.length).toBe(before);
      expect(
        (
          await request(app())
            .post(base + `/${id}/cancel`)
            .send({})
        ).status,
      ).toBe(200);
      expect((await flow(id)).state).toBe("cancelled");
      await db
        .update(agents)
        .set({ adapterConfig: cfg })
        .where(eq(agents.id, sid));
      await reconcileDeliveryWorkflow(db, id);
      expect(wakes.call.mock.calls.length).toBe(before);
    });
    it("resolves scoped templates, pins versions, confirms starts and forks/joins real coding runs", async () => {
      // Dedicated project avoids changing the legacy serial fixtures above.
      const projectId = randomUUID(),
        templateBase = `/companies/${c}/delivery-templates`;
      await db
        .insert(projects)
        .values({ id: projectId, companyId: c, name: "Parallel project" });
      expect(
        (await request(app()).get(templateBase + `?projectId=${randomUUID()}`))
          .status,
      ).toBe(404);
      expect(
        (
          await request(app(false, "other", c, false))
            .post(templateBase)
            .send({
              expectedRevision: 1,
              definition: DEFAULT_DELIVERY_TEMPLATE,
            })
        ).status,
      ).toBe(403);
      const definition = structuredClone(DEFAULT_DELIVERY_TEMPLATE);
      Object.values(definition.stages).forEach(s=>delete s.taskSequence);
      definition.stages["test-cases"].review="none";
      definition.stages.design.start = "confirmation";
      expect(
        (
          await request(app())
            .post(templateBase)
            .send({
              projectId,
              expectedRevision: 0,
              definition: {
                ...definition,
                stages: {
                  ...definition.stages,
                  design: {
                    ...definition.stages.design,
                    review: "specified_user",
                    reviewerUserId: "foreign-user",
                  },
                },
              },
            })
        ).status,
      ).toBe(409);
      const publishes = await Promise.all(
        [1, 2].map(() =>
          request(app())
            .post(templateBase)
            .send({ projectId, expectedRevision: 0, definition }),
        ),
      );
      expect(publishes.map((r) => r.status).sort()).toEqual([201, 409]);
      const effective = (
        await request(app()).get(templateBase + `?projectId=${projectId}`)
      ).body.effective;
      expect(effective.scope).toBe("project");
      const projectCfg={...cfg,dsp7JiraDispatch:{...cfg.dsp7JiraDispatch,projectId}};
      const secondSeat = randomUUID();
      await db
        .insert(agents)
        .values({
          id: secondSeat,
          companyId: c,
          name: "Backend seat",
          role: "engineer",
          status: "idle",
          adapterType: "claude_local",
          adapterConfig: projectCfg,
        });
      await db
        .update(agents)
        .set({
          adapterConfig: {
            ...projectCfg,
            dsp7SeatPresence: {
              ...cfg.dsp7SeatPresence,
              lastSeenAt: new Date().toISOString(),
            },
          },
        })
        .where(eq(agents.id, sid));
      const snap = randomUUID(),
        newPlan = {
          ...plan,
          demandNo: "PARALLEL",
          items: [
            ...plan.items.map((item, i) => ({
              ...item,
              key: `PAR-${i + 1}`,
              parentKey: "PAR-100",
            })),
            { ...plan.items[1], key: "PAR-5", parentKey: "PAR-100" },
            { ...plan.items[1], key: "PAR-6", parentKey: "PAR-100" },
          ],
        };
      await db
        .insert(deliverySnapshots)
        .values({
          id: snap,
          companyId: c,
          projectId,
          sourceOrigin: "https://proj.fingard.com:1888",
          demandNo: newPlan.demandNo,
          fingerprint,
          collectedAt: new Date(),
          createdByUserId: "local-board",
          plan: newPlan,
        });
      const input = {
        ...config,
        requestId: randomUUID(),
        snapshotId: snap,
        designKey: "PAR-1",
        codingKey: "",
        testCasesKey: "PAR-3",
        testExecutionKey: "PAR-4",
        codingTasks: [
          { jiraKey: "PAR-2", seatId: sid },
          { jiraKey: "PAR-5", seatId: secondSeat },
          { jiraKey: "PAR-6", seatId: sid },
        ],
        expectedTemplate: { id: effective.id, revision: 1 },
      };
      expect(
        (
          await request(app())
            .post(base)
            .send({
              ...input,
              expectedTemplate: { ...input.expectedTemplate, revision: 99 },
            })
        ).status,
      ).toBe(409);
      const created = await request(app()).post(base).send(input);
      expect(created.status, JSON.stringify(created.body)).toBe(201);
      const id = created.body.id;
      expect(created.body.stages.map((s: any) => s.stage)).toEqual([
        "design",
        "coding",
        "coding",
        "coding",
        "test-cases",
        "functional-test",
      ]);
      const updated = structuredClone(definition);
      updated.codingExecution = "serial";
      expect(
        (
          await request(app())
            .post(templateBase)
            .send({ projectId, expectedRevision: 1, definition: updated })
        ).status,
      ).toBe(201);
      expect((await flow(id)).config.template!.definition.codingExecution).toBe(
        "parallel",
      );
      expect((await request(app()).post(base).send(input)).body.id).toBe(id);
      const before = wakes.call.mock.calls.length;
      await reconcileDeliveryWorkflow(db, id);
      expect(wakes.call.mock.calls.length).toBe(before);
      let current = await flow(id);
      const design = current.stages[0];
      expect(
        (
          await request(app())
            .post(base + `/${id}/confirm-start`)
            .send({ taskId: design.taskId, inputDigest: design.inputDigest })
        ).status,
      ).toBe(200);
      await reconcileDeliveryWorkflow(db, id);
      current = await flow(id);
      expect(current.stages[0].runId).toBeTruthy();
      // A run without analysis must expose context successfully.
      const designRun = current.stages[0].runId!;
      await db
        .insert(seatExecutionPermits)
        .values({
          companyId: c,
          agentId: sid,
          taskId: design.taskId,
          runId: designRun,
          machineId: mid,
          leaseHash: createHash("sha256").update(lease).digest("hex"),
          expiresAt: new Date(Date.now() + 600000),
        });
      const context = await request(app(true))
        .post(`/agents/${sid}/delivery-runs/${designRun}/context`)
        .send(machine);
      expect(context.status, JSON.stringify(context.body)).toBe(200);
      expect(context.body.analysis).toBeNull();
      current.stages[0].state = "review";
      current.stages[0].receiptDigest = "c".repeat(64);
      current.stages[0].receipt = {
        protocolVersion: 1,
        taskId: design.taskId,
        runId: designRun,
        stage: "design",
        jiraKey: "PAR-1",
        inputDigest: current.stages[0].inputDigest,
        stateDigest: "a".repeat(64),
        trackerReceiptId: "42",
        jiraReference: "https://jira.example/browse/PAR-1",
        artifacts: [{ path: "design.md", sha256: "b".repeat(64) }],
      };
      await db
        .update(deliveryWorkflows)
        .set({ stages: current.stages })
        .where(eq(deliveryWorkflows.id, id));
      await db
        .update(heartbeatRuns)
        .set({ status: "succeeded" })
        .where(eq(heartbeatRuns.id, designRun));
      await db
        .update(seatExecutionPermits)
        .set({ treeStopVerifiedAt: new Date() })
        .where(eq(seatExecutionPermits.runId, designRun));
      await reconcileDeliveryWorkflow(db, id);
      expect(
        (await flow(id)).stages
          .filter((s) => s.stage === "coding")
          .every((s) => !s.runId),
      ).toBe(true);
      const review = {
        taskId: design.taskId,
        digest: "c".repeat(64),
        decision: "approve",
        reference: "https://formal.example/review",
        note: "设计已审核",
      };
      expect(
        (
          await request(app(false, "other"))
            .post(base + `/${id}/review`)
            .send(review)
        ).status,
      ).toBe(403);
      expect(
        (
          await request(app())
            .post(base + `/${id}/review`)
            .send(review)
        ).status,
      ).toBe(200);
      await reconcileDeliveryWorkflow(db, id);
      await reconcileDeliveryWorkflow(db, id);
      current = await flow(id);
      const coding = current.stages.filter((s) => s.stage === "coding");
      expect(coding[0].runId).toBeTruthy();
      expect(coding[1].runId).toBeTruthy();
      expect(coding[2].runId).toBeNull();
      expect(
        current.stages.find((s) => s.stage === "test-cases")!.runId,
      ).toBeNull();
      // Failure of one branch leaves the join closed, without losing its sibling.
      coding[0].state = "interrupted";
      await db
        .update(deliveryWorkflows)
        .set({ stages: current.stages })
        .where(eq(deliveryWorkflows.id, id));
      await reconcileDeliveryWorkflow(db, id);
      current = await flow(id);
      expect(
        current.stages.find((s) => s.taskId === coding[1].taskId)!.runId,
      ).toBe(coding[1].runId);
      expect(
        current.stages.find((s) => s.stage === "test-cases")!.runId,
      ).toBeNull();
      current.stages.find((s) => s.taskId === coding[0].taskId)!.state =
        "running";
      await db
        .update(deliveryWorkflows)
        .set({ stages: current.stages })
        .where(eq(deliveryWorkflows.id, id));
      // Complete each coding run through the native callback contract. The third
      // run on the first seat starts only after that seat's prior proof is done.
      async function deliverCoding(taskId: string) {
        let f = await flow(id);
        const s = f.stages.find((s) => s.taskId === taskId)!;
        await db
          .insert(seatExecutionPermits)
          .values({
            companyId: c,
            agentId: s.seatId,
            taskId: s.taskId,
            runId: s.runId!,
            machineId: mid,
            leaseHash: createHash("sha256").update(lease).digest("hex"),
            expiresAt: new Date(Date.now() + 600000),
          });
        const receipt: DeliveryStageReceipt = {
          protocolVersion: 1,
          taskId: s.taskId,
          runId: s.runId!,
          stage: "coding",
          jiraKey: s.jiraKey!,
          inputDigest: s.inputDigest,
          stateDigest: "a".repeat(64),
          trackerReceiptId: "42",
          jiraReference: "https://jira.example/browse/" + s.jiraKey,
          artifacts: [{ path: "review.md", sha256: "b".repeat(64) }],
        };
        const response = await request(
          app(true, "local-board", c, true, s.seatId),
        )
          .post(`/agents/${s.seatId}/delivery-runs/${s.runId}/delivery`)
          .send({ ...machine, seat_id: s.seatId, receipt });
        expect(response.status, JSON.stringify(response.body)).toBe(200);
        await db
          .update(heartbeatRuns)
          .set({ status: "succeeded" })
          .where(eq(heartbeatRuns.id, s.runId!));
        await reconcileDeliveryWorkflow(db, id);
        expect(
          (await flow(id)).stages.find((x) => x.taskId === taskId)!.state,
        ).not.toBe("done");
        await db
          .update(seatExecutionPermits)
          .set({ treeStopVerifiedAt: new Date() })
          .where(eq(seatExecutionPermits.runId, s.runId!));
        await reconcileDeliveryWorkflow(db, id);
        await reconcileDeliveryWorkflow(db, id);
      }
      await deliverCoding(coding[0].taskId);
      expect(
        (await flow(id)).stages.find((s) => s.taskId === coding[2].taskId)!
          .runId,
      ).toBeTruthy();
      expect(
        (await flow(id)).stages.find((s) => s.stage === "test-cases")!.runId,
      ).toBeNull();
      await deliverCoding(coding[1].taskId);
      expect(
        (await flow(id)).stages.find((s) => s.stage === "test-cases")!.runId,
      ).toBeNull();
      await deliverCoding(coding[2].taskId);
      expect(
        (await flow(id)).stages.find((s) => s.stage === "test-cases")!.runId,
      ).toBeTruthy();
      // Publishing inheritance follows the organization for future instances only.
      expect(
        (
          await request(app())
            .post(templateBase)
            .send({
              projectId,
              expectedRevision: 2,
              definition: { ...updated, inheritOrganization: true },
            })
        ).status,
      ).toBe(201);
      expect(
        (await request(app()).get(templateBase + `?projectId=${projectId}`))
          .body.effective.scope,
      ).toBe("organization");
      expect((await flow(id)).config.template!.revision).toBe(1);
    }, 30000);
    it("waits for terminal native runs and verified process stop before reopening and clearing issue locks",async()=>{
      const taskId=randomUUID(),runId=randomUUID();
      await db.insert(issues).values({id:taskId,companyId:c,title:"Native review return",assigneeAgentId:sid,status:"in_review"});
      await db.insert(heartbeatRuns).values({id:runId,companyId:c,agentId:sid,status:"running"});
      await db.update(issues).set({checkoutRunId:runId,executionRunId:runId}).where(eq(issues.id,taskId));
      const stage:DeliveryStageRecord={...(await flow((await db.select().from(deliveryWorkflows))[0].id)).stages.find(s=>s.stage==="design")!,taskId,seatId:sid,runId,executionMode:"seat" as const,state:"review" as const,review:{decision:"reject" as const,digest:"a".repeat(64),reference:"https://jira.example/browse/T-1",note:"补充异常设计",by:"local-board",at:new Date().toISOString()}};
      const f={companyId:c,stages:[stage]};
      expect(await db.transaction(tx=>prepareDeliveryRework(tx as unknown as Db,f,stage))).toBe(false);
      await db.update(heartbeatRuns).set({status:"succeeded"}).where(eq(heartbeatRuns.id,runId));
      expect(await db.transaction(tx=>prepareDeliveryRework(tx as unknown as Db,f,stage))).toBe(false);
      await db.insert(seatExecutionPermits).values({companyId:c,agentId:sid,runId,taskId,machineId:mid,leaseHash:"a".repeat(64),expiresAt:new Date(),treeStopVerifiedAt:new Date()});
      expect(await db.transaction(tx=>prepareDeliveryRework(tx as unknown as Db,f,stage))).toBe(true);
      expect(stage.state).toBe("pending");expect(stage.runId).toBeNull();expect(stage.reworkHistory?.[0].previous.runId).toBe(runId);
      const [task]=await db.select().from(issues).where(eq(issues.id,taskId));expect(task.executionRunId).toBeNull();expect(task.checkoutRunId).toBeNull();expect(task.assigneeAgentId).toBe(sid);
    });
    it.each(["automatic_rework", "pause"] as const)("supports repeated human review rework with %s policy and stale-version guards",async rejectionHandling=>{
      const projectId=randomUUID(),snap=randomUUID();await db.insert(projects).values({id:projectId,companyId:c,name:"Review rework"});
      const definition=structuredClone(DEFAULT_DELIVERY_TEMPLATE);
      for(const kind of ["analysis","coding","test-cases","functional-test"] as const)definition.stages[kind].enabled=false;
      Object.assign(definition.stages.design,{workExecution:"human",workExecutorUserId:"local-board",reviewExecution:"human",reviewExecutorUserId:"local-board",review:"none",rejectionHandling});
      expect((await request(app()).post(`/companies/${c}/delivery-templates`).send({projectId,expectedRevision:0,definition})).status).toBe(201);
      const source={...plan,demandNo:"REWORK-"+projectId,items:["系统设计","设计评审"].map((type,i)=>({...plan.items[0],key:`RW-${i+1}`,type,parentKey:"RW-100"}))};
      await db.insert(deliverySnapshots).values({id:snap,companyId:c,projectId,sourceOrigin:"https://proj.fingard.com:1888",demandNo:source.demandNo,fingerprint,collectedAt:new Date(),createdByUserId:"local-board",plan:source});
      const created=await request(app()).post(base).send({...config,requestId:randomUUID(),snapshotId:snap,analysisSeatId:"",developmentSeatId:"",qaSeatId:"",designKey:"RW-1",codingKey:"",testCasesKey:"",testExecutionKey:"",reviewTasks:[{stage:"design",jiraKey:"RW-2",workKeys:["RW-1"]}]});
      expect(created.status,JSON.stringify(created.body)).toBe(201);
      const id=created.body.id,endpoint=base+`/${id}/review`,before=wakes.call.mock.calls.length;
      for(let round=0;round<3;round++) {
        await reconcileDeliveryWorkflow(db,id);
        let f=await flow(id),work=f.stages[0];expect(work.state).toBe("review");
        const evidence={version:"design-v"+(round+1),artifactReferences:["https://jira.example/secure/attachment/1/design.md"]};
        const workInput={taskId:work.taskId,digest:work.inputDigest,decision:"approve",reference:"https://jira.example/browse/RW-1",note:"当前设计交付",manualDelivery:evidence};
        if(round)expect((await request(app()).post(endpoint).send({...workInput,manualDelivery:{...evidence,version:"design-v"+round}})).status).toBe(409);
        expect((await request(app()).post(endpoint).send(workInput)).status).toBe(200);
        await reconcileDeliveryWorkflow(db,id);f=await flow(id);const review=f.stages[1];expect(review.state).toBe("review");
        const input={taskId:review.taskId,digest:review.inputDigest,decision:round===2?"approve":"reject",reference:"https://jira.example/browse/RW-2",note:round===2?"修改核对通过":"问题：缺少异常处理；请补充设计与修改说明"};
        expect((await request(app(false,"other",c,true)).post(endpoint).send(input)).status).toBe(403);
        expect((await request(app()).post(endpoint).send({...input,note:""})).status).toBe(400);
        expect((await request(app()).post(endpoint).send(input)).status).toBe(200);
        expect((await request(app()).post(endpoint).send(input)).status).toBe(409);
        if(round===2)break;
        const dispatch=work.dispatchId;
        if(rejectionHandling==="pause") {
          expect((await flow(id)).state).toBe("blocked");await reconcileDeliveryWorkflow(db,id);expect((await flow(id)).stages[0].state).toBe("done");
          expect((await request(app()).post(base+`/${id}/rework`).send({taskId:review.taskId,digest:"0".repeat(64)})).status).toBe(409);
          expect((await request(app()).post(base+`/${id}/rework`).send({taskId:review.taskId,digest:review.inputDigest})).status).toBe(200);
        }
        await reconcileDeliveryWorkflow(db,id);f=await flow(id);
        expect(f.state).toBe("active");expect(f.stages.every(s=>s.state==="pending")).toBe(true);
        expect(f.stages[0].dispatchId).not.toBe(dispatch);expect(f.stages[0].manualDelivery).toBeUndefined();
        expect(f.stages[0].reworkHistory).toHaveLength(round+1);expect(f.stages[1].reworkHistory?.at(-1)?.rejection.note).toContain("缺少异常处理");
        expect((await request(app()).post(endpoint).send({...input,decision:"approve"})).status).toBe(409);
      }
      await reconcileDeliveryWorkflow(db,id);expect((await flow(id)).state).toBe("acceptance");expect(wakes.call.mock.calls.length).toBe(before);
    },30000);
    it("executes a fully human chain without Harness seats and binds manual handoffs and test results",async()=>{
      const projectId=randomUUID(),snap=randomUUID();await db.insert(projects).values({id:projectId,companyId:c,name:"Manual delivery"});
      const definition=structuredClone(DEFAULT_DELIVERY_TEMPLATE);
      for(const kind of ["design","coding","test-cases","functional-test"] as const) {
        definition.stages[kind].workExecution="human";definition.stages[kind].workExecutorUserId="local-board";
        definition.stages[kind].review="none";
        if(kind!=="design")definition.stages[kind].taskSequence="work_only";
      }
      definition.stages.design.reviewExecution="human";definition.stages.design.reviewExecutorUserId="local-board";
      expect((await request(app()).post(`/companies/${c}/delivery-templates`).send({projectId,expectedRevision:0,definition})).status).toBe(201);
      const source={...plan,demandNo:"MANUAL-1",items:["系统设计","设计评审","编码","测试用例设计","功能测试"].map((type,i)=>({...plan.items[0],key:`MAN-${i+1}`,type,parentKey:"MAN-100"}))};
      await db.insert(deliverySnapshots).values({id:snap,companyId:c,projectId,sourceOrigin:"https://proj.fingard.com:1888",demandNo:source.demandNo,fingerprint,collectedAt:new Date(),createdByUserId:"local-board",plan:source});
      const input={...config,requestId:randomUUID(),snapshotId:snap,analysisSeatId:"",developmentSeatId:"",qaSeatId:"",designKey:"MAN-1",codingKey:"MAN-3",testCasesKey:"MAN-4",testExecutionKey:"MAN-5",reviewTasks:[{stage:"design",jiraKey:"MAN-2",workKeys:["MAN-1"]}]};
      const created=await request(app()).post(base).send(input);expect(created.status,JSON.stringify(created.body)).toBe(201);
      const id=created.body.id,before=wakes.call.mock.calls.length;
      for(let index=0;index<5;index++) {
        await reconcileDeliveryWorkflow(db,id);const f=await flow(id),stage=f.stages[index];
        expect(stage.executionMode).toBe("human");expect(stage.state).toBe("review");expect(stage.runId).toBeNull();expect(stage.receipt).toBeNull();
        const inbox=await request(app()).get(base+"/pending-actions");
        expect(inbox.status,inbox.text).toBe(200);
        const actions=inbox.body.actions.filter((a:any)=>a.workflowId===id);
        expect(actions).toHaveLength(1);expect(actions[0].taskId).toBe(stage.taskId);
        expect(actions[0].kind).toBe(stage.reviewWorkKeys?"review":"work");
        const payload={taskId:stage.taskId,digest:stage.inputDigest,decision:"approve",reference:`https://jira.example/browse/${stage.jiraKey}`,note:"人工核对当前交付版本与正式材料"};
        const evidence={version:"release-manual-1",artifactReferences:["https://jira.example/secure/attachment/1/report.md"],...(stage.stage==="functional-test"?{testResults:{total:2,passed:2,failed:0,blocked:0,skipped:0}}:{})};
        if(!stage.reviewWorkKeys) {
          expect((await request(app()).post(base+`/${id}/review`).send(payload)).status).toBe(400);
          expect((await request(app(false,"other",c,false)).post(base+`/${id}/review`).send({...payload,manualDelivery:evidence})).status).toBe(403);
        }
        if(stage.stage==="functional-test")expect((await request(app()).post(base+`/${id}/review`).send({...payload,manualDelivery:{...evidence,testResults:{total:2,passed:1,failed:1,blocked:0,skipped:0}}})).status).toBe(409);
        const done=await request(app()).post(base+`/${id}/review`).send({...payload,...(!stage.reviewWorkKeys?{manualDelivery:evidence}:{})});expect(done.status,JSON.stringify(done.body)).toBe(200);
        const after=await request(app()).get(base+"/pending-actions");
        expect(after.body.actions.some((a:any)=>a.taskId===stage.taskId)).toBe(false);
      }
      await reconcileDeliveryWorkflow(db,id);expect((await flow(id)).state).toBe("acceptance");expect(wakes.call.mock.calls.length).toBe(before);
    },30000);
    it("activates real human review tickets before coding and launches independent code reviews only after bound work", async()=>{
      const projectId=randomUUID(),snap=randomUUID(),worker=randomUUID(),reviewer=randomUUID();
      await db.insert(projects).values({id:projectId,companyId:c,name:"Ordered review project"});
      for(const id of [worker,reviewer])await db.insert(agents).values({id,companyId:c,name:id===worker?"Worker":"Reviewer",role:"engineer",status:"idle",adapterType:"claude_local",adapterConfig:{...cfg,dsp7JiraDispatch:{...cfg.dsp7JiraDispatch,projectId},dsp7SeatPresence:{...cfg.dsp7SeatPresence,lastSeenAt:new Date().toISOString()}}});
      const definition=structuredClone(DEFAULT_DELIVERY_TEMPLATE);definition.stages["test-cases"].enabled=false;definition.stages["functional-test"].enabled=false;
      const published=await request(app()).post(`/companies/${c}/delivery-templates`).send({projectId,expectedRevision:0,definition});expect(published.status,JSON.stringify(published.body)).toBe(201);
      const types=["系统设计","设计评审","编码","代码评审"];
      const source={...plan,demandNo:"ORDERED-1",items:types.map((type,i)=>({...plan.items[0],key:`SEQ-${i+1}`,type,parentKey:"SEQ-100"}))};
      await db.insert(deliverySnapshots).values({id:snap,companyId:c,projectId,sourceOrigin:"https://proj.fingard.com:1888",demandNo:source.demandNo,fingerprint,collectedAt:new Date(),createdByUserId:"local-board",plan:source});
      const input={...config,requestId:randomUUID(),snapshotId:snap,developmentSeatId:worker,designKey:"SEQ-1",codingKey:"SEQ-3",testCasesKey:"",testExecutionKey:"",reviewTasks:[{stage:"design",jiraKey:"SEQ-2",workKeys:["SEQ-1"]},{stage:"coding",jiraKey:"SEQ-4",workKeys:["SEQ-3"],seatId:reviewer}]};
      expect((await request(app()).post(base).send({...input,reviewTasks:[]})).status).toBe(409);
      const created=await request(app()).post(base).send(input);expect(created.status,JSON.stringify(created.body)).toBe(201);
      const id=created.body.id;let f=await flow(id);const human=f.stages[1];
      // An older client must never claim work whose sibling review has been delegated.
      const legacyConfig={...cfg,dsp7JiraDispatch:{...cfg.dsp7JiraDispatch,projectId},dsp7SeatPresence:{...cfg.dsp7SeatPresence,lastSeenAt:new Date().toISOString(),capabilities:["analysis-execution-v1","delivery-flow-v1"]}};
      await db.update(agents).set({adapterConfig:legacyConfig}).where(eq(agents.id,worker));
      const oldClientWakes=wakes.call.mock.calls.length;await reconcileDeliveryWorkflow(db,id);
      expect(wakes.call.mock.calls.length).toBe(oldClientWakes);expect((await flow(id)).stages[0].runId).toBeNull();
      expect((await flow(id)).message).toContain("更新席位客户端");
      await db.update(agents).set({adapterConfig:{...cfg,dsp7JiraDispatch:{...cfg.dsp7JiraDispatch,projectId},dsp7SeatPresence:{...cfg.dsp7SeatPresence,lastSeenAt:new Date().toISOString()}}}).where(eq(agents.id,worker));
      const [humanIssue]=await db.select().from(issues).where(eq(issues.id,human.taskId));expect(humanIssue.assigneeUserId).toBe("local-board");expect(humanIssue.assigneeAgentId).toBeNull();
      const conclusion={taskId:human.taskId,digest:human.inputDigest,decision:"approve",reference:"https://jira.example/browse/SEQ-2",note:"正式评审通过"};
      expect((await request(app()).post(base+`/${id}/review`).send(conclusion)).status).toBe(409);
      // Freeze the already-covered native delivery protocol to isolate node dependencies and human authorization.
      f.stages[0].state="done";f.stages[0].receiptDigest="d".repeat(64);
      await db.update(deliveryWorkflows).set({stages:f.stages}).where(eq(deliveryWorkflows.id,id));
      const before=wakes.call.mock.calls.length;await reconcileDeliveryWorkflow(db,id);f=await flow(id);
      expect(wakes.call.mock.calls.length).toBe(before);expect(f.stages[1].state).toBe("review");expect(f.stages[2].runId).toBeNull();
      const bound={...conclusion,digest:f.stages[1].inputDigest};
      expect((await request(app(false,"other",c,false)).post(base+`/${id}/review`).send(bound)).status).toBe(403);
      expect((await request(app()).post(base+`/${id}/review`).send({...bound,digest:"0".repeat(64)})).status).toBe(409);
      expect((await request(app()).post(base+`/${id}/review`).send({...bound,reference:"https://jira.example/browse/SEQ-99"})).status).toBe(409);
      expect((await request(app()).post(base+`/${id}/review`).send(bound)).status).toBe(200);
      expect((await flow(id)).stages[1].state).toBe("done");await reconcileDeliveryWorkflow(db,id);f=await flow(id);
      expect(f.stages[2].runId).toBeTruthy();expect(f.stages[3].runId).toBeNull();
      // Stale approvals cannot be applied again after downstream work has started.
      expect((await request(app()).post(base+`/${id}/review`).send(bound)).status).toBe(409);
      f.stages[2].state="done";f.stages[2].receiptDigest="e".repeat(64);
      await db.update(deliveryWorkflows).set({stages:f.stages}).where(eq(deliveryWorkflows.id,id));
      await reconcileDeliveryWorkflow(db,id);f=await flow(id);expect(f.stages[3].intent).toBe("code-review");expect(f.stages[3].runId).toBeTruthy();expect(f.stages[3].seatId).toBe(reviewer);
    },30000);
  },
);
