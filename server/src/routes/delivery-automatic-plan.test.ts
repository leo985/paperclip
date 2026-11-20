import { assertDeliveryTaskMutation, assertDeliveryTaskCheckout, assertNoDeliveryTaskLifecycle } from "../services/delivery-workflow-actions.js";
import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { eq } from "drizzle-orm";
import {
  activityLog,
  agents,
  companies,
  createDb,
  deliverySnapshots,
  deliveryWorkflowTemplates,
  deliveryWorkflows,
  issues,
  projects,
  type Db,
} from "@paperclipai/db";
import {
  DEFAULT_DELIVERY_TEMPLATE,
  type DeliveryPlan,
} from "@paperclipai/shared";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "../__tests__/helpers/embedded-postgres.js";
const mocks = vi.hoisted(() => ({
  source: vi.fn(),
  prior: vi.fn(),
  account: "owner",
}));
vi.mock("../services/delivery-automatic-source.js", () => ({
  readAutomaticDeliverySource: mocks.source,
}));
vi.mock("../services/delivery-prior-jira.js", async (original) => ({
  ...(await original<typeof import("../services/delivery-prior-jira.js")>()),
  readJiraPriorCompletion: mocks.prior,
}));
vi.mock("../services/heartbeat.js", () => ({
  heartbeatService: () => ({ wakeup: vi.fn() }),
}));
vi.mock("../services/delivery-seat-assignment.js", async (original) => ({
  ...(await original<
    typeof import("../services/delivery-seat-assignment.js")
  >()),
  readDeliveryJiraAssignments: async (
    _db: unknown,
    _c: string,
    _p: string,
    keys: string[],
  ) =>
    new Map(
      keys.map((key) => [
        key,
        {
          account: mocks.account,
          displayName: "owner",
          origin: "http://jira.fingard.com:6001",
        },
      ]),
    ),
}));
import { reconcileDeliveryWorkflow } from "../services/delivery-workflows.js";
import { MissingJiraPriorEvidence } from "../services/delivery-prior-jira.js";
import { deliveryWorkflowRoutes } from "./delivery-workflows.js";
const support = await getEmbeddedPostgresTestSupport();
(support.supported ? describe : describe.skip)(
  "automatic delivery plan and authorization",
  () => {
    let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>,
      db: Db;
    const c = randomUUID(),
      p = randomUUID(),
      sid = randomUUID(),
      base = `/companies/${c}/delivery-workflows`;
    let sequence = 0;
    function app(company = c, admin = true, userId = "local-board") {
      const a = express();
      a.use(express.json());
      a.use((req, _res, next) => {
        req.actor = {
          type: "board",
          source: "session",
          userId,
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
      a.use(deliveryWorkflowRoutes(db));
      a.use((e: any, _req: any, res: any, _next: any) =>
        res.status(e.status ?? 500).json({ error: e.message }),
      );
      return a;
    }
    beforeAll(async () => {
      vi.stubEnv("PAPERCLIP_DEPLOYMENT_MODE", "local_trusted");
      database = await startEmbeddedPostgresTestDatabase("delivery-auto-");
      db = createDb(database.connectionString);
      await db
        .insert(companies)
        .values({ id: c, name: "Auto plan", issuePrefix: "A" + c.slice(0, 6) });
      await db
        .insert(projects)
        .values({ id: p, companyId: c, name: "Automatic project" });
      const definition = structuredClone(DEFAULT_DELIVERY_TEMPLATE);
      for (const [key, policy] of Object.entries(definition.stages))
        policy.enabled = key === "coding";
      definition.stages.coding.taskSequence = "work_only";
      definition.stages.coding.entryChecks = ["title"];
      await db
        .insert(deliveryWorkflowTemplates)
        .values({
          companyId: c,
          scopeKey: "organization",
          revision: 1,
          definition,
          createdBy: "local-board",
        });
      await db
        .insert(agents)
        .values({
          id: sid,
          companyId: c,
          name: "Offline developer",
          role: "engineer",
          status: "idle",
          adapterType: "claude_local",
          adapterConfig: {
            dsp7Transport: "outbound",
            dsp7Seat: { ownerUserId: "local-board", machineId: randomUUID() },
            dsp7JiraDispatch: {
              enabled: true,
              projectId: p,
              jiraBaseUrl: "http://jira.fingard.com:6001",
              jiraAssignee: "owner",
            },
            dsp7HarnessCapabilities: {
              version: 1,
              revision: 1,
              items: [
                {
                  id: "dev",
                  kind: "development",
                  roles: ["coding", "code-review"],
                  root: "/isolated/development",
                  repository: "git.example.com/development",
                  profile: "dsp",
                  commit: "a".repeat(40),
                  manifestDigest: "b".repeat(64),
                  protocolVersion: 1,
                  validation: "local-files",
                  executionReady: false,
                  checkedAt: new Date().toISOString(),
                },
              ],
            },
          },
        });
    }, 30000);
    afterAll(async () => {
      await database?.cleanup();
      vi.unstubAllEnvs();
    });
    beforeEach(() => {
      mocks.account = "owner";
      mocks.source.mockReset();
      mocks.prior.mockReset();
      mocks.prior.mockImplementation(async (_db, _c, _p, prior) => ({
        ...prior,
        version: "verified-v1",
      }));
    });
    async function fixture(status = "待受理") {
      const n = ++sequence,
        id = randomUUID();
      const item = {
        key: `DEV-${n}`,
        parentKey: `MAIN-${n}`,
        type: "编码",
        title: "开发",
        status,
        assignee: "owner",
        scheduled: true,
      };
      const plan: DeliveryPlan = {
        demandId: String(n),
        demandNo: `REQ-${n}`,
        title: "自动计划需求",
        status: "开发中",
        roles: [],
        mains: [{ key: `MAIN-${n}`, sourceId: String(n), title: "main" }],
        items: [item],
        scheduleCount: 1,
        differences: [],
        fingerprint: "f".repeat(64),
        sourceMode: "online_readonly",
        executionAllowed: false,
      };
      await db
        .insert(deliverySnapshots)
        .values({
          id,
          companyId: c,
          projectId: p,
          sourceOrigin: "https://proj.fingard.com:1888",
          demandNo: plan.demandNo,
          fingerprint: plan.fingerprint,
          collectedAt: new Date(),
          createdByUserId: "local-board",
          plan,
        });
      const source = {
        items: [{ ...item, account: "owner", updated: "v1", reviewLinks: [] }],
        parents: [item.parentKey],
        origin: "http://jira.fingard.com:6001",
      };
      mocks.source.mockImplementation(async () => structuredClone(source));
      return { input: { snapshotId: id, environmentReference: "" }, source };
    }
    it("previews without creating issues, workflows or changing project templates", async () => {
      const { input } = await fixture();
      const before = await db
        .select()
        .from(deliveryWorkflowTemplates)
        .where(eq(deliveryWorkflowTemplates.companyId, c));
      const reply = await request(app())
        .post(base + "/plan")
        .send(input);
      expect(reply.status, reply.text).toBe(200);
      expect(reply.body.ready).toBe(true);
      expect(reply.body.nodes[0]).toMatchObject({ mode: "seat", seatId: sid });
      expect(await db.select().from(issues)).toHaveLength(0);
      expect(await db.select().from(deliveryWorkflows)).toHaveLength(0);
      expect(
        await db
          .select()
          .from(deliveryWorkflowTemplates)
          .where(eq(deliveryWorkflowTemplates.companyId, c)),
      ).toEqual(before);
    });
    it("loads a saved entry plan without reading Jira and changes it only on regeneration", async () => {
      const { input } = await fixture();
      const api = request(app());
      const path = base + "/plan";
      expect((await api.get(path).query({ snapshotId: input.snapshotId })).body).toBeNull();
      const first = await api.post(path + "/initial").send(input);
      expect(first.status, first.text).toBe(200);
      expect(first.body.plan.generatedAt).toEqual(expect.any(String));
      expect(first.body.input).toEqual(input);
      mocks.source.mockClear();

      const get = await api.get(path).query({ snapshotId: input.snapshotId });
      expect(get.body).toEqual(first.body);
      expect((await api.post(path + "/initial").send({ ...input, environmentReference: "https://qa.example/another" })).body).toEqual(first.body);
      expect(mocks.source).not.toHaveBeenCalled();
      expect((await request(app(c, false)).get(path).query({ snapshotId: input.snapshotId })).status).toBe(403);

      const [baseline] = await db.select().from(deliverySnapshots).where(eq(deliverySnapshots.id, input.snapshotId));
      const latestId = randomUUID();
      await db.insert(deliverySnapshots).values({
        ...baseline, id: latestId, fingerprint: "c".repeat(64), collectedAt: new Date(baseline.collectedAt.getTime() + 1000),
      });
      expect((await api.get(path).query({ snapshotId: latestId })).body).toEqual(first.body);
      expect((await api.post(path).send(input)).status).toBe(409);
      const next = { ...input, snapshotId: latestId, environmentReference: "https://qa.example/build" };
      const regenerated = await api.post(path).send(next);
      expect(regenerated.status, regenerated.text).toBe(200);
      expect(regenerated.body.digest).not.toBe(first.body.plan.digest);
      expect((await api.get(path).query({ snapshotId: latestId })).body).toEqual({ input: next, plan: regenerated.body });
      expect(await db.select().from(deliveryWorkflows)).toHaveLength(0);
    });
    it("requires explicit authorization and rejects a stale source digest without creating tasks", async () => {
      const { input, source } = await fixture();
      const preview = await request(app())
        .post(base + "/plan")
        .send(input);
      const payload = {
        plan: input,
        expectedDigest: preview.body.digest,
        requestId: randomUUID(),
        authorized: true,
      };
      expect(
        (
          await request(app())
            .post(base + "/automatic-start")
            .send({ ...payload, authorized: false })
        ).status,
      ).toBe(400);
      source.items[0].updated = "v2";
      const reply = await request(app())
        .post(base + "/automatic-start")
        .send(payload);
      expect(reply.status, reply.text).toBe(409);
      expect(await db.select().from(issues)).toHaveLength(0);
    });
    it("fails closed across company and administrator boundaries", async () => {
      const { input } = await fixture();
      const other = randomUUID();
      expect(
        (
          await request(app(other))
            .post(base + "/plan")
            .send(input)
        ).status,
      ).toBe(403);
      expect(
        (
          await request(app(c, false))
            .post(base + "/plan")
            .send(input)
        ).status,
      ).toBe(403);
      expect(
        (
          await request(app(other))
            .post(`/companies/${other}/delivery-workflows/plan`)
            .send(input)
        ).status,
      ).toBe(404);
    });
    it("reports missing capability or exact account matches as a planning blocker", async () => {
      const { input, source } = await fixture();
      source.items[0].account = "someone-else";
      source.items[0].assignee = "张三";
      const reply = await request(app())
        .post(base + "/plan")
        .send(input);
      expect(reply.status, reply.text).toBe(200);
      expect(reply.body.ready).toBe(false);
      expect(reply.body.nodes[0]).toMatchObject({ mode: "seat", executor: "待匹配", jiraAssignee: "张三" });
      expect(reply.body.blockers).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ code: "seat_missing" }),
        ]),
      );
    });
    it("verifies historical delivery during preview and surfaces missing evidence", async () => {
      const { input } = await fixture("已完成");
      let reply = await request(app())
        .post(base + "/plan")
        .send(input);
      expect(reply.body.ready, reply.text).toBe(true);
      expect(reply.body.nodes[0].mode).toBe("reuse");
      mocks.prior.mockRejectedValueOnce(new Error("附件缺失"));
      reply = await request(app())
        .post(base + "/plan")
        .send(input);
      expect(reply.body.ready).toBe(false);
      expect(reply.body.blockers).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            code: "prior_evidence",
            message: "附件缺失",
          }),
        ]),
      );
    });
    it("identifies a template's explicit environment check even without a new test node", async () => {
      const { input } = await fixture("已完成");
      const projectId = randomUUID();
      await db.insert(projects).values({ id: projectId, companyId: c, name: "Environment admission" });
      const definition = structuredClone(DEFAULT_DELIVERY_TEMPLATE);
      for (const [key, policy] of Object.entries(definition.stages)) policy.enabled = key === "coding";
      definition.stages.coding.entryChecks = ["title", "environment_reference"];
      definition.stages.coding.taskSequence = "work_only";
      await db.insert(deliveryWorkflowTemplates).values({
        companyId: c, projectId, scopeKey: projectId, revision: 1, definition, createdBy: "local-board",
      });
      await db.update(deliverySnapshots).set({ projectId }).where(eq(deliverySnapshots.id, input.snapshotId));
      const api = request(app());
      const missing = await api.post(base + "/plan").send(input);
      expect(missing.body.blockers).toEqual([{ code: "environment", message: expect.stringContaining("项目模板要求") }]);
      const supplied = await api.post(base + "/plan").send({ ...input, environmentReference: "https://ci.example.com/deployments/123" });
      expect(supplied.body.ready, supplied.text).toBe(true);
    });
    it("rejects evidence changed after recomputation and rolls back issue creation", async () => {
      const { input } = await fixture("已完成");
      const preview = await request(app())
        .post(base + "/plan")
        .send(input);
      mocks.prior.mockResolvedValueOnce({
        stage: "coding",
        jiraKey: "DEV-" + sequence,
        source: "jira",
        version: "verified-v1",
        artifactReferences: [],
        reviewReference: "",
      });
      mocks.prior.mockImplementation(async (_db, _c, _p, prior) => ({
        ...prior,
        version: "changed-v2",
      }));
      const reply = await request(app())
        .post(base + "/automatic-start")
        .send({
          plan: input,
          requestId: randomUUID(),
          expectedDigest: preview.body.digest,
          authorized: true,
        });
      expect(reply.status, reply.text).toBe(409);
      expect(reply.body.error).toContain("已有交付在授权后发生变化");
      expect(await db.select().from(issues)).toHaveLength(0);
    });
    it("invalidates approval when a seat Harness registry changes", async () => {
      const { input } = await fixture();
      const preview = await request(app())
        .post(base + "/plan")
        .send(input);
      const [seat] = await db.select().from(agents).where(eq(agents.id, sid));
      const adapterConfig = structuredClone(seat.adapterConfig);
      (adapterConfig.dsp7HarnessCapabilities as any).revision = 2;
      await db.update(agents).set({ adapterConfig }).where(eq(agents.id, sid));
      try {
        const reply = await request(app())
          .post(base + "/automatic-start")
          .send({
            plan: input,
            requestId: randomUUID(),
            expectedDigest: preview.body.digest,
            authorized: true,
          });
        expect(reply.status, reply.text).toBe(409);
        expect(reply.body.error).toContain("计划已变化");
      } finally {
        await db
          .update(agents)
          .set({ adapterConfig: seat.adapterConfig })
          .where(eq(agents.id, sid));
      }
    });
    it("starts an authorized plan exactly once and rejects request-id reuse with changed inputs", async () => {
      const { input } = await fixture();
      const preview = await request(app())
        .post(base + "/plan")
        .send(input);
      expect(preview.body.ready, preview.text).toBe(true);
      const payload = {
        plan: input,
        requestId: randomUUID(),
        expectedDigest: preview.body.digest,
        authorized: true,
      };
      const first = await request(app())
        .post(base + "/automatic-start")
        .send(payload);
      expect(first.status, first.text).toBe(201);
      expect(first.body.config.automaticPlan.digest).toBe(preview.body.digest);
      expect(first.body.stages).toHaveLength(1);
      const retry = await request(app())
        .post(base + "/automatic-start")
        .send(payload);
      expect(retry.status, retry.text).toBe(201);
      expect(retry.body.id).toBe(first.body.id);
      expect(
        (
          await request(app())
            .post(base + "/automatic-start")
            .send({
              ...payload,
              plan: {
                ...input,
                environmentReference: "https://env.example/new",
              },
            })
        ).status,
      ).toBe(409);
      expect(await db.select().from(issues)).toHaveLength(1);
    });
    it("keeps an entry partially delivered until a previously blocked main starts and is verified", async () => {
      const { input, source } = await fixture("已完成");
      const [initial] = await db.select().from(deliverySnapshots).where(eq(deliverySnapshots.id, input.snapshotId));
      const firstKey = source.parents[0];
      const secondKey = "MAIN-90001";
      const second = { ...source.items[0], key: "DEV-90001", parentKey: secondKey, status: "待受理", account: "unmatched" };
      source.parents.push(secondKey);
      source.items.push(second);
      const snapshot = { ...initial.plan,
        mains: [...initial.plan.mains, { key: secondKey, sourceId: "90001", title: "第二主单" }],
        items: [...initial.plan.items, second],
      };
      await db.update(deliverySnapshots).set({ plan: snapshot }).where(eq(deliverySnapshots.id, initial.id));
      const api = request(app());
      const planInput = { ...input, branchDependencies: [{ parentKey: secondKey, afterParentKey: firstKey }] };
      const preview = await api.post(base + "/plan").send(planInput);
      expect(preview.body.branches, preview.text).toMatchObject([
        { parentKey: firstKey, state: "ready" },
        { parentKey: secondKey, state: "blocked", afterParentKey: firstKey, blockers: [{ code: "branch_dependency_wait" }, { code: "seat_missing" }] },
      ]);
      const first = await api.post(base + "/automatic-start").send({
        plan: planInput, requestId: randomUUID(), expectedDigest: preview.body.digest, authorized: true, parentKeys: [firstKey],
      });
      expect(first.status, first.text).toBe(201);
      const flowId = first.body.id;
      await reconcileDeliveryWorkflow(db, flowId);
      const partial = await api.get(base + "/" + flowId);
      expect(partial.body.state).toBe("active");
      expect(partial.body.message).toContain("部分交付");
      const acceptance = { fingerprint: first.body.fingerprint, reference: "https://jira.example/acceptance", note: "验收结论" };
      expect((await api.post(base + "/" + flowId + "/accept").send(acceptance)).status).toBe(409);

      second.status = "已完成";
      const snapshotId = randomUUID();
      await db.insert(deliverySnapshots).values({
        ...initial, id: snapshotId, collectedAt: new Date(initial.collectedAt.getTime() + 1000),
        fingerprint: "e".repeat(64), plan: { ...snapshot, items: [...initial.plan.items, second] },
      });
      const nextInput = { ...planInput, snapshotId };
      const next = await api.post(base + "/plan").send(nextInput);
      expect(next.body.branches, next.text).toMatchObject([
        { parentKey: firstKey, state: "verified" }, { parentKey: secondKey, state: "ready" },
      ]);
      const authorization = { plan: nextInput, requestId: randomUUID(), expectedDigest: next.body.digest, authorized: true };
      const extended = await api.post(base + "/automatic-start").send(authorization);
      expect(extended.status, extended.text).toBe(201);
      expect(extended.body.id).toBe(flowId);
      expect(extended.body.stages.map((stage: { taskId: string }) => stage.taskId)[0]).toBe(first.body.stages[0].taskId);
      expect(extended.body.stages).toHaveLength(2);
      expect(extended.body.stages[1].dependsOn).toEqual([first.body.stages[0].taskId]);
      expect((await api.post(base + "/automatic-start").send(authorization)).status).toBe(201);
      await reconcileDeliveryWorkflow(db, flowId);
      const ready = (await api.get(base + "/" + flowId)).body;
      expect(ready.state).toBe("acceptance");
      expect((await api.post(base + "/" + flowId + "/accept").send(acceptance)).status).toBe(409);
      acceptance.fingerprint = ready.config.entryScope.acceptanceDigest;
      source.items.push({ ...second, key: "DEV-90002" });
      expect((await api.post(base + "/" + flowId + "/accept").send(acceptance)).status).toBe(409);
      await db.insert(deliverySnapshots).values({
        ...initial, id: randomUUID(), collectedAt: new Date(initial.collectedAt.getTime() + 2000),
        fingerprint: "d".repeat(64), plan: { ...snapshot, items: source.items },
      });
      await reconcileDeliveryWorkflow(db, flowId);
      expect((await api.get(base + "/" + flowId)).body.state).toBe("active");
      source.items.pop();
      await db.insert(deliverySnapshots).values({
        ...initial, id: randomUUID(), collectedAt: new Date(initial.collectedAt.getTime() + 3000),
        fingerprint: "c".repeat(64), plan: { ...snapshot, items: source.items },
      });
      await reconcileDeliveryWorkflow(db, flowId);
      const accepted = await api.post(base + "/" + flowId + "/accept").send(acceptance);
      expect(accepted.status, accepted.text).toBe(200);
      expect((await api.get(base + "/" + flowId)).body.state).toBe("completed");
    });

    it("projects activated personal actions and task context with company and participant boundaries",async()=>{
      const {input}=await fixture();
      const taskId=randomUUID(),futureId=randomUUID(),id=randomUUID();
      const stages=[{taskId,stage:"design",state:"review",executionMode:"human",reviewerUserId:"worker",ownerUserId:"worker",seatId:"",dependsOn:[],inputDigest:"a".repeat(64)},
        {taskId:futureId,stage:"coding",state:"review",executionMode:"human",reviewerUserId:"worker",ownerUserId:"worker",seatId:"",dependsOn:[taskId]}] as any;
      await db.insert(deliveryWorkflows).values({id,companyId:c,projectId:p,snapshotId:input.snapshotId,demandNo:"ACTION-"+id,fingerprint:"f",requestId:randomUUID(),createdBy:"local-board",config:{} as any,stages});
      const issue={id:taskId,companyId:c,status:"in_progress",assigneeAgentId:null,assigneeUserId:"worker"};
      await expect(assertDeliveryTaskMutation(db,issue,{status:"done"})).rejects.toThrow(/实例管理/);
      await expect(assertDeliveryTaskMutation(db,issue,{assigneeUserId:"other"})).rejects.toThrow(/实例管理/);
      await expect(assertDeliveryTaskMutation(db,issue,{status:"in_progress",title:"说明"})).resolves.toBeUndefined();
      await expect(assertDeliveryTaskCheckout(db,c,futureId,sid)).rejects.toThrow(/尚未授权/);
      await expect(assertNoDeliveryTaskLifecycle(db,c,taskId)).rejects.toThrow(/不能单独删除/);
      let reply=await request(app(c,false,"worker")).get(base+"/pending-actions");
      expect(reply.status,reply.text).toBe(200);
      expect(reply.body.actions.map((a:any)=>a.taskId)).toContain(taskId);
      expect(reply.body.actions.map((a:any)=>a.taskId)).not.toContain(futureId);
      expect(reply.body.managedTaskIds).toContain(futureId);
      expect((await request(app(c,false,"outsider")).get(base+"/pending-actions")).body.actions).toEqual([]);
      expect((await request(app(c,false,"worker")).get(base+"/pending-actions?scope=company")).status).toBe(403);
      expect((await request(app(c,false,"worker")).get(base+"/for-task/"+taskId)).body).toMatchObject({workflowId:id,stage:{taskId},href:expect.stringContaining("#delivery-node-"+taskId)});
      expect((await request(app(c,false,"outsider")).get(base+"/for-task/"+taskId)).status).toBe(404);
      const foreign=randomUUID();expect((await request(app(foreign)).get(`/companies/${foreign}/delivery-workflows/for-task/${taskId}`)).body).toBeNull();
      const dispatched=[{...stages[0],executionMode:undefined,state:"queued",seatId:sid}];
      await db.update(deliveryWorkflows).set({stages:dispatched}).where(eq(deliveryWorkflows.id,id));
      await expect(assertDeliveryTaskCheckout(db,c,taskId,sid)).resolves.toBeUndefined();
      await expect(assertDeliveryTaskCheckout(db,c,taskId,randomUUID())).rejects.toThrow(/尚未授权/);
      await expect(assertDeliveryTaskMutation(db,{...issue,id:randomUUID()},{status:"done"})).resolves.toBeUndefined();
      await db.update(deliveryWorkflows).set({state:"cancelled"}).where(eq(deliveryWorkflows.id,id));
      reply=await request(app(c,false,"worker")).get(base+"/pending-actions");expect(reply.body.actions).toEqual([]);
    });
    it("extends a compatible legacy workflow and archives its prior acceptance", async () => {
      const { input, source } = await fixture("已完成");
      const api = request(app());
      const preview = await api.post(base + "/plan").send(input);
      const legacy = await api.post(base + "/automatic-start").send({
        plan: input, requestId: randomUUID(), expectedDigest: preview.body.digest, authorized: true,
      });
      expect(legacy.status, legacy.text).toBe(201);
      expect(legacy.body.config.entryScope).toBeUndefined();
      const id = legacy.body.id;
      await reconcileDeliveryWorkflow(db, id);
      const reference = "https://jira.example/legacy-acceptance";
      expect((await api.post(base + "/" + id + "/accept").send({
        fingerprint: legacy.body.fingerprint, reference, note: "原主单验收",
      })).status).toBe(200);

      const [initial] = await db.select().from(deliverySnapshots).where(eq(deliverySnapshots.id, input.snapshotId));
      const secondKey = "MAIN-92001";
      source.parents.push(secondKey);
      source.items.push({ ...source.items[0], key: "DEV-92001", parentKey: secondKey });
      const snapshotId = randomUUID();
      await db.insert(deliverySnapshots).values({
        ...initial, id: snapshotId, fingerprint: "b".repeat(64),
        collectedAt: new Date(initial.collectedAt.getTime() + 1000),
        plan: { ...initial.plan,
          mains: [...initial.plan.mains, { key: secondKey, sourceId: "92001", title: "补充主单" }],
          items: source.items,
        },
      });
      const nextInput = { ...input, snapshotId };
      const next = await api.post(base + "/plan").send(nextInput);
      expect(next.body.branches, next.text).toMatchObject([
        { parentKey: source.parents[0], state: "verified" }, { parentKey: secondKey, state: "ready" },
      ]);
      const extended = await api.post(base + "/automatic-start").send({
        plan: nextInput, requestId: randomUUID(), expectedDigest: next.body.digest, authorized: true,
      });
      expect(extended.status, extended.text).toBe(201);
      expect(extended.body).toMatchObject({ id, state: "active", acceptance: null });
      expect(extended.body.stages[0].taskId).toBe(legacy.body.stages[0].taskId);
      const events = await db.select().from(activityLog).where(eq(activityLog.entityId, id));
      expect(events).toEqual(expect.arrayContaining([expect.objectContaining({
        action: "delivery.workflow.branches_started",
        details: expect.objectContaining({ previousAcceptance: expect.objectContaining({ reference }) }),
      })]));
    });

    it("starts a subset of main issues and lets an explicit exclusion close the acceptance scope", async () => {
      const { input, source } = await fixture("已完成");
      const first = source.parents[0];
      const excluded = "MAIN-93001";
      const third = "MAIN-93002";
      const extra = [
        { ...source.items[0], key: "DEV-93001", parentKey: excluded, status: "待受理", account: "unmatched" },
        { ...source.items[0], key: "DEV-93002", parentKey: third },
      ];
      source.parents.push(excluded, third);
      source.items.push(...extra);
      const [snapshot] = await db.select().from(deliverySnapshots).where(eq(deliverySnapshots.id, input.snapshotId));
      await db.update(deliverySnapshots).set({ plan: {
        ...snapshot.plan, mains: source.parents.map(key => ({ key, title: key, sourceId: key })), items: source.items,
      } }).where(eq(deliverySnapshots.id, input.snapshotId));

      const api = request(app());
      const preview = await api.post(base + "/plan").send(input);
      const started = await api.post(base + "/automatic-start").send({
        plan: input, requestId: randomUUID(), expectedDigest: preview.body.digest, authorized: true, parentKeys: [first, third],
      });
      expect(started.status, started.text).toBe(201);
      const id = started.body.id;
      expect(started.body.stages.map((stage: { parentKey: string }) => stage.parentKey)).toEqual([first, third]);
      await reconcileDeliveryWorkflow(db, id);
      expect((await api.get(base + "/" + id)).body.state).toBe("active");

      const invalid = await api.post(base + "/plan").send({ ...input, ignoredParentKeys: [first] });
      expect(invalid.body.blockers).toEqual(expect.arrayContaining([expect.objectContaining({ code: "ignored_parent" })]));
      const plan = { ...input, ignoredParentKeys: [excluded] };
      const exclusion = await api.post(base + "/plan").send(plan);
      expect(exclusion.body.canSaveIgnored).toBe(true);
      expect(exclusion.body.branches.find((branch: { parentKey: string }) => branch.parentKey === excluded))
        .toMatchObject({ state: "ignored", nodes: [], blockers: [] });
      const authorization = { plan, parentKeys: [], requestId: randomUUID(), expectedDigest: exclusion.body.digest, authorized: true };
      const updated = await api.post(base + "/automatic-start").send(authorization);
      expect(updated.status, updated.text).toBe(201);
      expect(updated.body.id).toBe(id);
      expect(updated.body.config.entryScope.ignoredParentKeys).toEqual([excluded]);
      expect(updated.body.stages.map((stage: { taskId: string }) => stage.taskId))
        .toEqual(started.body.stages.map((stage: { taskId: string }) => stage.taskId));
      expect((await api.post(base + "/automatic-start").send(authorization)).status).toBe(201);
      await reconcileDeliveryWorkflow(db, id);
      const accept = (await api.get(base + "/" + id)).body;
      expect(accept.state).toBe("acceptance");
      source.items.push({ ...extra[0], key: "DEV-93003" });
      const accepted = await api.post(base + "/" + id + "/accept").send({
        fingerprint: accept.config.entryScope.acceptanceDigest,
        reference: "https://jira.example/acceptance", note: "核验选定主单",
      });
      expect(accepted.status, accepted.text).toBe(200);
    });

    it("lets an administrator skip test cases on one main while retaining functional testing and audit scope", async () => {
      const { input, source } = await fixture("已完成");
      const projectId = randomUUID();
      await db.insert(projects).values({ id: projectId, companyId: c, name: "Optional test cases" });
      const definition = structuredClone(DEFAULT_DELIVERY_TEMPLATE);
      definition.stages.analysis.enabled = false;
      definition.stages.design.enabled = false;
      definition.stages.coding.taskSequence = "work_only";
      definition.stages.coding.entryChecks = ["title"];
      definition.stages["test-cases"].taskSequence = "work_then_review";
      await db.insert(deliveryWorkflowTemplates).values({
        companyId: c, projectId, scopeKey: projectId, revision: 1, definition, createdBy: "local-board",
      });
      const coding = source.items[0];
      const first = coding.parentKey;
      const second = "MAIN-95001";
      const functional = { ...coding, key: "TEST-95001", type: "功能测试" };
      const cases = { ...coding, key: "CASE-95001", parentKey: second, type: "测试用例设计" };
      source.parents.push(second);
      source.items.push(
        functional,
        cases,
        { ...cases, key: "REV-95001", type: "测试用例评审" },
        { ...coding, key: "DEV-95001", parentKey: second },
        { ...functional, key: "TEST-95002", parentKey: second },
      );
      const [snapshot] = await db.select().from(deliverySnapshots).where(eq(deliverySnapshots.id, input.snapshotId));
      await db.update(deliverySnapshots).set({ projectId,
        plan: { ...snapshot.plan, mains: source.parents.map(key => ({ key, title: key, sourceId: key })), items: source.items },
      }).where(eq(deliverySnapshots.id, input.snapshotId));

      const api = request(app());
      const plan = { ...input, passedTests: [{ jiraKey: functional.key, total: 3 }, { jiraKey: "TEST-95002", total: 2 }] };
      const unmodified = await api.post(base + "/plan").send(plan);
      expect(unmodified.body.branches[0]).toMatchObject({ canSkipTestCases: true, state: "blocked",
        blockers: expect.arrayContaining([{ code: "missing_work", message: "测试用例缺少真实工作子单" }]),
      });
      const choice = { ...plan, skipTestCasesParentKeys: [first] };
      const preview = await api.post(base + "/plan").send(choice);
      expect(preview.body.branches, preview.text).toMatchObject([
        { parentKey: first, state: "ready", skipTestCases: true, blockers: [],
          nodes: [{ jiraKey: coding.key }, { jiraKey: functional.key, dependsOn: [coding.key] }] },
        { parentKey: second, state: "ready", nodes: expect.arrayContaining([expect.objectContaining({ jiraKey: cases.key, stage: "test-cases" })]) },
      ]);
      expect(preview.body.template.definition.stages["test-cases"].enabled).toBe(true);
      const started = await api.post(base + "/automatic-start").send({
        plan: choice, expectedDigest: preview.body.digest, requestId: randomUUID(), authorized: true, parentKeys: [first],
      });
      expect(started.status, started.text).toBe(201);
      expect(started.body.stages.map((stage: { jiraKey: string }) => stage.jiraKey)).toEqual([coding.key, functional.key]);
      expect(started.body.config.entryScope.branches[first].skipTestCases).toBe(true);
      const audit = await db.select().from(activityLog).where(eq(activityLog.entityId, started.body.id));
      expect(audit.find(event => event.action === "delivery.workflow.started")?.details)
        .toMatchObject({ branches: [{ key: first, skipTestCases: true }] });
      source.items.push({ ...cases, key: "CASE-95002", parentKey: first });
      const refreshed = await api.post(base + "/plan").send({ ...plan, passedTests: [{ jiraKey: "TEST-95002", total: 2 }] });
      expect(refreshed.body.branches[0], refreshed.text).toMatchObject({
        parentKey: first, state: "verified", skipTestCases: true, blockers: [],
      });
    });

    it("authorizes reuse of a completed Jira functional test with a verified textual result", async () => {
      const { input, source } = await fixture("已完成");
      const projectId = randomUUID();
      await db.insert(projects).values({ id: projectId, companyId: c, name: "Historical Jira test" });
      const definition = structuredClone(DEFAULT_DELIVERY_TEMPLATE);
      for (const [stage, policy] of Object.entries(definition.stages)) policy.enabled = stage === "functional-test";
      definition.stages["functional-test"].entryChecks = ["title"];
      await db.insert(deliveryWorkflowTemplates).values({
        companyId: c, projectId, scopeKey: projectId, revision: 1, definition, createdBy: "local-board",
      });
      source.items[0].type = "功能测试";
      const [snapshot] = await db.select().from(deliverySnapshots).where(eq(deliverySnapshots.id, input.snapshotId));
      await db.update(deliverySnapshots).set({ projectId, plan: { ...snapshot.plan, items: source.items } })
        .where(eq(deliverySnapshots.id, input.snapshotId));
      mocks.prior.mockImplementation(async (_db, _company, _project, prior) => ({
        ...prior, version: "jira-test-version", reviewReference: source.origin + "/browse/" + prior.jiraKey,
        jiraEvidence: { status: "已完成", updated: "v1", testResult: "测试通过", artifacts: [], comments: [] },
      }));
      const api = request(app());
      const plan = { ...input, entryScope: true };
      const preview = await api.post(base + "/plan").send(plan);
      expect(preview.body.branches, preview.text).toMatchObject([{ state: "ready", blockers: [] }]);
      expect(preview.body.nodes[0]).toMatchObject({ mode: "reuse", testResult: "测试通过" });
      expect(preview.body.nodes[0]).not.toHaveProperty("verificationNote");
      const started = await api.post(base + "/automatic-start").send({
        plan, requestId: randomUUID(), expectedDigest: preview.body.digest, authorized: true,
      });
      expect(started.status, started.text).toBe(201);
      expect(started.body.stages[0]).toMatchObject({ state: "done", priorCompletion: { jiraEvidence: { testResult: "测试通过" } } });
      expect(started.body.stages[0].priorCompletion).not.toHaveProperty("passedTests");
      await reconcileDeliveryWorkflow(db, started.body.id);
      expect((await api.get(base + "/" + started.body.id)).body.state).toBe("acceptance");
    });

    it("defers historical review and test verification without releasing their dependents early", async () => {
      const { input, source } = await fixture("已完成");
      const projectId = randomUUID();
      await db.insert(projects).values({ id: projectId, companyId: c, name: "Historical verification" });
      const definition = structuredClone(DEFAULT_DELIVERY_TEMPLATE);
      definition.stages.analysis.enabled = false;
      definition.stages["test-cases"].enabled = false;
      definition.stages.design.entryChecks = ["title"];
      definition.stages.design.taskSequence = "work_then_review";
      definition.stages.coding.taskSequence = "work_only";
      await db.insert(deliveryWorkflowTemplates).values({
        companyId: c, projectId, scopeKey: projectId, revision: 1, definition, createdBy: "local-board",
      });
      const coding = source.items[0];
      const design = { ...coding, key: "DES-92001", type: "系统设计" };
      const review = { ...coding, key: "REV-92001", type: "设计评审" };
      const test = { ...coding, key: "TEST-92001", type: "功能测试" };
      const changed = { ...coding, key: "DEV-92002" };
      source.items.push(design, review, test, changed);
      const [snapshot] = await db.select().from(deliverySnapshots).where(eq(deliverySnapshots.id, input.snapshotId));
      await db.update(deliverySnapshots).set({ projectId, plan: { ...snapshot.plan, items: source.items } })
        .where(eq(deliverySnapshots.id, input.snapshotId));
      let changedVersion = "verified-v1";
      mocks.prior.mockImplementation(async (_db, _company, _project, prior) => {
        if ([review.key, test.key].includes(prior.jiraKey))
          throw new MissingJiraPriorEvidence("历史材料缺失");
        return {
          ...prior,
          version: prior.jiraKey === changed.key ? changedVersion : "verified-v1",
          reviewReference: source.origin + "/browse/" + prior.jiraKey,
        };
      });

      const api = request(app());
      const plan = { ...input, entryScope: true };
      const preview = await api.post(base + "/plan").send(plan);
      expect(preview.body.branches, preview.text).toMatchObject([{ state: "ready", blockers: [] }]);
      expect(preview.body.nodes).toEqual(expect.arrayContaining([
        expect.objectContaining({ jiraKey: review.key, verificationNote: expect.stringContaining("正式 Jira") }),
        expect.objectContaining({ jiraKey: coding.key, verificationNote: expect.stringContaining("前置节点") }),
        expect.objectContaining({ jiraKey: test.key, verificationNote: expect.stringContaining("正式测试报告") }),
      ]));
      const started = await api.post(base + "/automatic-start").send({
        plan, requestId: randomUUID(), expectedDigest: preview.body.digest, authorized: true,
      });
      expect(started.status, started.text).toBe(201);
      const id = started.body.id;
      async function flow() {
        const response = await api.get(base + "/" + id);
        expect(response.status, response.text).toBe(200);
        return response.body as typeof deliveryWorkflows.$inferSelect;
      }
      async function stage(key: string) {
        return (await flow()).stages.find(node => node.jiraKey === key)!;
      }
      async function verify(key: string, extra: Record<string, unknown> = {}) {
        const node = await stage(key);
        return api.post(base + "/" + id + "/review").send({
          taskId: node.taskId, digest: node.inputDigest, decision: "approve",
          reference: source.origin + "/browse/" + key, note: "已核对正式结果及版本",
          ...extra,
        });
      }
      await reconcileDeliveryWorkflow(db, id);
      expect((await stage(design.key)).state).toBe("done");
      expect((await stage(review.key)).state).toBe("review");
      expect(await stage(coding.key)).toMatchObject({ state: "pending", deferredPriorCompletion: { version: "verified-v1" } });
      expect((await stage(test.key)).state).toBe("pending");
      expect((await verify(review.key, { reference: "https://other.example/browse/" + review.key })).status).toBe(409);
      expect((await verify(review.key)).status).toBe(200);
      changedVersion = "verified-v2";
      await reconcileDeliveryWorkflow(db, id);
      expect((await stage(coding.key)).state).toBe("done");
      expect(await stage(changed.key)).toMatchObject({ state: "pending", historicalVerification: { jiraOrigin: source.origin } });
      expect((await stage(test.key)).state).toBe("pending");
      await reconcileDeliveryWorkflow(db, id);
      expect((await stage(changed.key)).state).toBe("review");
      expect((await verify(changed.key, { manualDelivery: {
        version: "verified-v2", artifactReferences: ["https://coding.example/artifacts/92002"],
      } })).status).toBe(200);
      await reconcileDeliveryWorkflow(db, id);
      expect((await stage(test.key)).state).toBe("review");
      expect((await verify(test.key)).status).toBe(400);
      expect((await flow()).state).toBe("active");
      const recorded = await verify(test.key, { manualDelivery: {
        version: "build-v1", artifactReferences: ["https://qa.example/reports/92001"],
        testResults: { total: 6, passed: 6, failed: 0, skipped: 0, blocked: 0 },
      } });
      expect(recorded.status, recorded.text).toBe(200);
      await reconcileDeliveryWorkflow(db, id);
      expect((await flow()).state).toBe("acceptance");
    });

    it("runs independent human branches and reopens an affected review after authorized scope expansion", async () => {
      const { input, source } = await fixture();
      const [initial] = await db.select().from(deliverySnapshots).where(eq(deliverySnapshots.id, input.snapshotId));
      const definition = structuredClone(DEFAULT_DELIVERY_TEMPLATE);
      for (const [key, policy] of Object.entries(definition.stages)) policy.enabled = key === "coding";
      Object.assign(definition.stages.coding, {
        workExecution: "human", workExecutorUserId: "local-board", taskSequence: "work_then_review",
        reviewExecution: "human", reviewExecutorUserId: "local-board", rejectionHandling: "pause", entryChecks: ["title"],
      });
      await db.insert(deliveryWorkflowTemplates).values({
        companyId: c, scopeKey: p, projectId: p, revision: 1, definition, createdBy: "local-board",
      });
      const firstKey = source.parents[0];
      const secondKey = "MAIN-91001";
      const second = { ...source.items[0], key: "DEV-91001", parentKey: secondKey };
      const firstReview = { ...source.items[0], key: "REV-91001", type: "代码评审" };
      const secondReview = { ...firstReview, key: "REV-91002", parentKey: secondKey };
      source.parents.push(secondKey);
      source.items.push(second, firstReview, secondReview);
      const snapshot = { ...initial.plan,
        mains: [...initial.plan.mains, { key: secondKey, sourceId: "91001", title: "第二主单" }],
        items: source.items,
      };
      await db.update(deliverySnapshots).set({ plan: snapshot }).where(eq(deliverySnapshots.id, initial.id));
      const api = request(app());
      const preview = await api.post(base + "/plan").send(input);
      expect(preview.body.branches?.map((branch: { state: string }) => branch.state), preview.text).toEqual(["ready", "ready"]);
      const started = await api.post(base + "/automatic-start").send({
        plan: input, requestId: randomUUID(), expectedDigest: preview.body.digest, authorized: true,
      });
      expect(started.status, started.text).toBe(201);
      const id = started.body.id;
      async function stage(key: string) {
        const [row] = await db.select().from(deliveryWorkflows).where(eq(deliveryWorkflows.id, id));
        return row.stages.find(node => node.jiraKey === key)!;
      }
      async function review(key: string, decision: "approve" | "reject" = "approve") {
        const node = await stage(key);
        const result = await api.post(base + "/" + id + "/review").send({
          taskId: node.taskId, digest: node.inputDigest, decision, reference: "https://jira.example/browse/" + key,
          note: "人工核验当前版本",
          ...(!node.reviewWorkKeys && decision === "approve" ? {
            manualDelivery: { version: "v1", artifactReferences: ["https://jira.example/material"] },
          } : {}),
        });
        expect(result.status, result.text).toBe(200);
      }
      await reconcileDeliveryWorkflow(db, id);
      const firstTask = await stage(source.items[0].key);
      expect((await stage(firstReview.key)).dependsOn).toEqual([firstTask.taskId]);
      expect((await stage(secondReview.key)).dependsOn).toEqual([(await stage(second.key)).taskId]);
      await review(firstTask.jiraKey!);
      await review(second.key);
      await reconcileDeliveryWorkflow(db, id);
      await review(firstReview.key, "reject");
      expect((await stage(firstReview.key)).branchBlocked).toBe(true);
      expect((await api.get(base + "/" + id)).body.state).toBe("active");
      await review(secondReview.key);
      const verifiedReview = await stage(secondReview.key);

      const extra = { ...second, key: "DEV-91002" };
      source.items.push(extra);
      const latestId = randomUUID();
      await db.insert(deliverySnapshots).values({
        ...initial, id: latestId, collectedAt: new Date(initial.collectedAt.getTime() + 1000),
        fingerprint: "a".repeat(64), plan: snapshot,
      });
      const updatedInput = { ...input, snapshotId: latestId };
      const updatedPlan = await api.post(base + "/plan").send(updatedInput);
      expect(updatedPlan.body.branches, updatedPlan.text).toMatchObject([
        { parentKey: firstKey, state: "blocked" }, { parentKey: secondKey, state: "ready", scopeChanged: true },
      ]);
      const appended = await api.post(base + "/automatic-start").send({
        plan: updatedInput, requestId: randomUUID(), expectedDigest: updatedPlan.body.digest,
        authorized: true, parentKeys: [secondKey],
      });
      expect(appended.status, appended.text).toBe(201);
      const reopened = await stage(secondReview.key);
      expect(reopened).toMatchObject({
        taskId: verifiedReview.taskId, state: "pending", review: null,
        reworkHistory: [{ kind: "scope_change", previous: { review: verifiedReview.review } }],
      });
      expect(reopened.dependsOn).toContain((await stage(extra.key)).taskId);
      await reconcileDeliveryWorkflow(db, id);
      expect((await stage(secondReview.key)).state).toBe("pending");
      await review(extra.key);
      await reconcileDeliveryWorkflow(db, id);
      expect((await stage(secondReview.key)).state).toBe("review");
      expect((await stage(firstReview.key)).branchBlocked).toBe(true);
    });
  },
);
