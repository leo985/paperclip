/** Fast isolated rehearsal: real workflow routes, planner, scheduler and PostgreSQL;
 * only Jira I/O and the external seat process boundary are simulated. */
import { createHash, randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import express from "express";
import request from "supertest";
import { eq, and } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { agents, companies, projects, deliverySnapshots, deliveryWorkflowTemplates, deliveryWorkflows, heartbeatRuns, seatExecutionPermits, issues, activityLog, createDb, type Db } from "@paperclipai/db";
import { DEFAULT_DELIVERY_TEMPLATE, type DeliveryPlan, type DeliveryStageRecord, type DeliveryStageReceipt, type DeliveryTemplateDefinition } from "@paperclipai/shared";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "../__tests__/helpers/embedded-postgres.js";
const external = vi.hoisted(() => ({
  wake: vi.fn(),
  source: vi.fn(),
  assignments: vi.fn(),
  jira: vi.fn()
}));
vi.mock("../services/heartbeat.js", () => ({
  heartbeatService: () => ({
    wakeup: external.wake,
    cancelRun: vi.fn()
  })
}));
vi.mock("../services/delivery-automatic-source.js", () => ({
  readAutomaticDeliverySource: external.source
}));
vi.mock("../services/delivery-seat-assignment.js", async original => ({
  ...(await original<typeof import("../services/delivery-seat-assignment.js")>()),
  readDeliveryJiraAssignments: external.assignments
}));
vi.mock("../services/delivery-repair-jira.js", async original => ({
  ...(await original<typeof import("../services/delivery-repair-jira.js")>()),
  repairJiraClient: external.jira
}));
import { deliveryWorkflowRoutes } from "./delivery-workflows.js";
import { deliveryTemplateRoutes } from "./delivery-templates.js";
import { deliveryDigest, reconcileDeliveryWorkflow } from "../services/delivery-workflows.js";
const support = await getEmbeddedPostgresTestSupport();
const reports: Array<{
  name: string;
  status: string;
  elapsedMs: number;
  events: Array<Record<string, unknown>>;
}> = [];
const origin = "http://jira.fingard.com:6001",
  fingerprint = "f".repeat(64);
const hash = (v: string) => createHash("sha256").update(v).digest("hex");
(support.supported ? describe.sequential : describe.skip)("delivery chain mock rehearsal", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>, db: Db;
  beforeAll(async () => {
    vi.stubEnv("PAPERCLIP_DEPLOYMENT_MODE", "local_trusted");
    // Any accidentally unmocked external request makes the rehearsal fail closed.
    vi.stubGlobal("fetch", vi.fn(async () => {
      throw Error("External network is forbidden during delivery simulation");
    }));
    database = await startEmbeddedPostgresTestDatabase("delivery-simulation-");
    db = createDb(database.connectionString);
  }, 30000);
  afterAll(async () => {
    try {
      if (process.env.PAPERCLIP_DELIVERY_SIMULATION_REPORT) await writeFile(process.env.PAPERCLIP_DELIVERY_SIMULATION_REPORT, JSON.stringify({
        schemaVersion: 1,
        generatedAt: new Date().toISOString(),
        simulated: true,
        productionModified: false,
        real: ["PostgreSQL", "automatic planner", "dependency scheduler", "Jira-account seat selection", "HTTP callbacks", "human inbox", "rework", "acceptance", "audit"],
        mocked: ["Jira source (creation forbidden)", "seat process execution and exit attestation", "human decisions", "artifact content"],
        scenarios: reports
      }, null, 2));
    } finally {
      await database?.cleanup();
      vi.unstubAllEnvs();
      vi.unstubAllGlobals();
    }
  });
  async function fixture(name: string, options: {
    repair?: boolean;
    agentReviews?: boolean;
    humanWork?: boolean;
    codingRejection?: "automatic_rework" | "pause";
    busy?: boolean;
    offline?: boolean;
  } = {}) {
    const started = performance.now(),
      report = {
        name,
        status: "running",
        elapsedMs: 0,
        events: [] as Array<Record<string, unknown>>
      };
    reports.push(report);
    const event = (kind: string, details: Record<string, unknown> = {}) => report.events.push({
      kind,
      elapsedMs: Math.round(performance.now() - started),
      ...details
    });
    const companyId = randomUUID(),
      projectId = randomUUID(),
      snapshotId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "SIMULATION " + name,
      issuePrefix: "S" + companyId.slice(0, 6)
    });
    await db.insert(projects).values({
      id: projectId,
      companyId,
      name: "SIMULATION DSP"
    });
    const seats = new Map<string, {
      id: string;
      machineId: string;
      lease: string;
      config: Record<string, any>;
    }>();
    for (const [account, kind, roles] of [["dev-a", "development", ["system-design", "coding", "bug-fix"]], ["dev-b", "development", ["coding"]], ["reviewer", "development", ["code-review", "design-review"]], ["qa", "qa", ["test-cases", "functional-test"]], ["qa-review", "qa", ["test-case-review"]]] as const) {
      const id = randomUUID(),
        machineId = randomUUID(),
        lease = randomUUID();
      const config = {
        dsp7Transport: "outbound",
        dsp7WebJiraIntake: true,
        dsp7JiraDispatch: {
          enabled: true,
          projectId,
          jiraBaseUrl: origin,
          jiraAssignee: account
        },
        dsp7Seat: {
          machineId,
          machineFingerprint: fingerprint,
          ownerUserId: "local-board"
        },
        dsp7HarnessCapabilities: {
          version: 1,
          revision: 1,
          items: [{
            id: kind,
            kind,
            roles: [...roles],
            root: "/simulation/" + account,
            repository: "git.example/simulation",
            profile: "dsp",
            commit: "a".repeat(40),
            manifestDigest: "b".repeat(64),
            protocolVersion: 1,
            validation: "local-files",
            executionReady: false,
            checkedAt: new Date().toISOString()
          }]
        },
        dsp7SeatPresence: {
          lastSeenAt: options.offline && account === "dev-a" ? new Date(0).toISOString() : new Date().toISOString(),
          state: options.busy && account === "dev-a" ? "busy" : "idle",
          acceptingWork: true,
          capabilities: ["delivery-flow-v1", "delivery-work-review-v1", "delivery-executor-v1", "delivery-rework-v1", "delivery-auto-repair-v1", "delivery-reuse-repair-v1"]
        }
      };
      await db.insert(agents).values({
        id,
        companyId,
        name: "MOCK " + account,
        role: "engineer",
        status: "idle",
        adapterType: "claude_local",
        adapterConfig: config
      });
      seats.set(account, {
        id,
        machineId,
        lease,
        config
      });
    }
    const definition = structuredClone(DEFAULT_DELIVERY_TEMPLATE);
    for (const policy of Object.values(definition.stages)) policy.entryChecks = ["title"];
    definition.stages["functional-test"].start = "confirmation";
    if (options.humanWork) Object.assign(definition.stages["test-cases"], {
      workExecution: "human",
      workExecutorUserId: "local-board"
    });
    if (options.codingRejection) definition.stages.coding.rejectionHandling = options.codingRejection;
    if (options.agentReviews) {
      Object.assign(definition.stages.design, {
        reviewExecution: "agent",
        review: "none"
      });
      Object.assign(definition.stages["test-cases"], {
        reviewExecution: "agent",
        review: "none"
      });
    }
    if (options.repair) definition.automaticRepair = {
      maxCycles: 2,
      jiraProjectKey: "SIM",
      defectIssueTypeId: "1",
      fixIssueTypeId: "2",
      reviewIssueTypeId: "3",
      retestIssueTypeId: "4",
      buildObservationUrl: "https://env.example/simulation/version",
      routes: [{
        module: "payments",
        developmentSeatId: seats.get("dev-a")!.id,
        reviewSeatId: seats.get("reviewer")!.id,
        qaSeatId: seats.get("qa")!.id
      }]
    };
    const [occupiedRun] = options.busy ? await db.insert(heartbeatRuns).values({
      companyId,
      agentId: seats.get("dev-a")!.id,
      status: "running",
      triggerDetail: "mock occupied seat"
    }).returning() : [];
    const rows = [["系统设计", "dev-a"], ["设计评审", options.agentReviews ? "reviewer" : "dev-a"], ["编码", "dev-a"], ["前端编码", "dev-b"], ["代码评审", "reviewer"], ["详细测试用例编写", "qa"], ["测试用例评审", options.agentReviews ? "qa-review" : "qa"], ["功能测试", "qa"]];
    if (options.repair) rows.push(["功能测试", "qa"]);
    const accounts = new Map(rows.map(([, a], i) => [`SIM-${i + 1}`, a]));
    const source: DeliveryPlan = {
      demandId: snapshotId,
      demandNo: "SIM-" + name,
      title: "模拟付款需求",
      status: "开发中",
      roles: [],
      mains: [{
        key: "SIM-100",
        sourceId: "100",
        title: "模拟主工单"
      }],
      items: rows.map(([type, account], i) => ({
        key: `SIM-${i + 1}`,
        parentKey: "SIM-100",
        title: type,
        type,
        status: "待受理",
        assignee: account,
        scheduled: true
      })),
      scheduleCount: rows.length,
      differences: [],
      fingerprint,
      sourceMode: "online_readonly",
      executionAllowed: false
    };
    await db.insert(deliverySnapshots).values({
      id: snapshotId,
      companyId,
      projectId,
      demandNo: source.demandNo,
      sourceOrigin: "https://proj.fingard.com:1888",
      fingerprint,
      collectedAt: new Date(),
      createdByUserId: "local-board",
      plan: source
    });
    external.source.mockImplementation(async () => ({
      origin,
      parents: ["SIM-100"],
      items: source.items.map(item => ({
        ...item,
        account: accounts.get(item.key),
        updated: "simulated-v1",
        reviewLinks: []
      }))
    }));
    external.assignments.mockImplementation(async (_db, _c, _p, keys: string[]) => new Map(keys.map(key => [key, {
      account: accounts.get(key),
      displayName: accounts.get(key),
      origin
    }])));
    const dispatches: Array<{
        taskId: string;
        seatId: string;
        runId: string;
        key: string;
      }> = [],
      dispatchByKey = new Map<string, typeof heartbeatRuns.$inferSelect>();
    external.wake.mockImplementation(async (seatId: string, input: any) => {
      if (dispatchByKey.has(input.idempotencyKey)) return dispatchByKey.get(input.idempotencyKey);
      const seat = [...seats.values()].find(s => s.id === seatId)!;
      expect(seat).toBeTruthy();
      const [run] = await db.insert(heartbeatRuns).values({
        companyId,
        agentId: seatId,
        status: "running",
        contextSnapshot: input.contextSnapshot
      }).returning();
      await db.insert(seatExecutionPermits).values({
        companyId,
        agentId: seatId,
        taskId: input.contextSnapshot.taskId,
        runId: run.id,
        machineId: seat.machineId,
        leaseHash: hash(seat.lease),
        expiresAt: new Date(Date.now() + 600000)
      });
      dispatchByKey.set(input.idempotencyKey, run);
      dispatches.push({
        taskId: input.contextSnapshot.taskId,
        seatId,
        runId: run.id,
        key: input.idempotencyKey
      });
      event("seat-dispatched", {
        taskId: input.contextSnapshot.taskId,
        seat: [...seats].find(([, s]) => s.id === seatId)![0]
      });
      return run;
    });
    const jiraSpecs: Array<any> = [],
      jiraByMarker = new Map<string, string>();
    external.jira.mockImplementation(async () => ({
      origin,
      find: async (spec: any) => jiraByMarker.get(spec.marker) ?? null,
      create: async (spec: any) => {
        const key = "SIM-" + (200 + jiraSpecs.length);
        jiraSpecs.push(spec);
        jiraByMarker.set(spec.marker, key);
        accounts.set(key, spec.account);
        event("mock-jira-created", {
          key,
          account: spec.account
        });
        return key;
      }
    }));
    function app(userId = "local-board", seatId?: string) {
      const a = express();
      a.use(express.json());
      a.use((req, _res, next) => {
        req.actor = seatId ? {
          type: "agent",
          source: "agent_key",
          agentId: seatId,
          companyId,
          companyIds: [companyId]
        } : {
          type: "board",
          source: "session",
          userId,
          companyIds: [companyId],
          memberships: userId === "local-board" ? [{
            companyId,
            membershipRole: "admin",
            status: "active"
          }] : []
        };
        next();
      });
      a.use(deliveryTemplateRoutes(db));
      a.use(deliveryWorkflowRoutes(db));
      a.use((err: any, _req: any, res: any, _next: any) => res.status(err.status ?? 500).json({
        error: err.message
      }));
      return a;
    }
    const base = `/companies/${companyId}/delivery-workflows`;
    const published = await request(app()).post(`/companies/${companyId}/delivery-templates`).send({
      projectId,
      expectedRevision: 0,
      definition
    });
    expect(published.status, published.text).toBe(201);
    const input = {
      snapshotId,
      environmentReference: "https://env.example/simulation"
    };
    const preview = await request(app()).post(base + "/plan").send(input);
    expect(preview.status, preview.text).toBe(200);
    expect(preview.body.ready, JSON.stringify(preview.body.blockers)).toBe(true);
    expect(preview.body.nodes).toHaveLength(rows.length);
    for (const node of preview.body.nodes.filter((n: any) => n.mode === "seat")) expect(node.seatId).toBe(seats.get(accounts.get(node.jiraKey)!)!.id);
    const startInput = {
      requestId: randomUUID(),
      plan: input,
      expectedDigest: preview.body.digest,
      authorized: true,
      automaticRepairAuthorized: !!options.repair
    };
    const created = await request(app()).post(base + "/automatic-start").send(startInput);
    expect(created.status, created.text).toBe(201);
    const id = created.body.id as string;
    const flow = async () => (await db.select().from(deliveryWorkflows).where(eq(deliveryWorkflows.id, id)))[0]!;
    const tick = async () => {
      await reconcileDeliveryWorkflow(db, id);
      return flow();
    };
    const inbox = async () => {
      const r = await request(app()).get(base + "/pending-actions");
      expect(r.status, r.text).toBe(200);
      return r.body.actions.filter((a: any) => a.workflowId === id);
    };
    const machine = (s: DeliveryStageRecord) => {
      const seat = [...seats.values()].find(seat => seat.id === s.seatId)!;
      return {
        seat_id: s.seatId,
        machine_id: seat.machineId,
        machine_fingerprint: fingerprint,
        lease: seat.lease
      };
    };
    const callback = (s: DeliveryStageRecord, suffix: string, body: object = {}) => request(app("local-board", s.seatId)).post(`/agents/${s.seatId}/delivery-runs/${s.runId}/${suffix}`).send({
      ...machine(s),
      ...body
    });
    async function context(s: DeliveryStageRecord) {
      const r = await callback(s, "context");
      expect(r.status, r.text).toBe(200);
      return r.body;
    }
    async function complete(s: DeliveryStageRecord, extra: Partial<DeliveryStageReceipt> = {}, exit = true) {
      expect(s.runId).toBeTruthy();
      const round = s.reworkHistory?.length ?? 0,
        digest = hash(`${s.taskId}:${s.runId}:${round}`);
      const artifact = {
        path: "result.md",
        sha256: digest,
        downloadUrl: `${origin}/secure/attachment/1/${s.taskId}-${round}.md`
      };
      const receipt: DeliveryStageReceipt = {
        protocolVersion: 1,
        taskId: s.taskId,
        runId: s.runId!,
        stage: s.stage,
        jiraKey: s.jiraKey!,
        inputDigest: s.inputDigest,
        stateDigest: digest,
        trackerReceiptId: "mock-" + s.taskId,
        jiraReference: origin + "/browse/" + s.jiraKey,
        artifacts: [artifact],
        ...extra
      };
      if (s.intent === "code-review" && !extra.codeReview) receipt.codeReview = {
        decision: "passed",
        reviewedVersionDigest: deliveryDigest({
          inputDigest: s.inputDigest,
          workKeys: s.reviewWorkKeys
        }),
        sourcePath: artifact.path,
        sourceSha256: artifact.sha256
      };
      if (s.intent === "design-review" || s.intent === "test-case-review") receipt.domainReview = {
        decision: "passed",
        reviewedVersionDigest: deliveryDigest({
          inputDigest: s.inputDigest,
          workKeys: s.reviewWorkKeys
        }),
        sourcePath: artifact.path,
        sourceSha256: artifact.sha256
      };
      if (s.stage === "functional-test" && !extra.testResults) {
        receipt.artifacts = [{
          ...artifact,
          path: "execution-records.md"
        }];
        receipt.testResults = {
          total: 2,
          passed: 2,
          failed: 0,
          blocked: 0,
          skipped: 0,
          testedVersion: s.expectedBuild?.version ?? "mock-build-1",
          sourcePath: "execution-records.md",
          sourceSha256: digest
        };
      }
      const r = await callback(s, "delivery", {
        receipt
      });
      expect(r.status, r.text).toBe(200);
      expect((await callback(s, "delivery", {
        receipt
      })).status).toBe(200);
      await db.update(heartbeatRuns).set({
        status: "succeeded"
      }).where(eq(heartbeatRuns.id, s.runId!));
      await tick();
      expect((await flow()).stages.find(n => n.taskId === s.taskId)!.state).not.toBe("done");
      if (exit) await db.update(seatExecutionPermits).set({
        treeStopVerifiedAt: new Date()
      }).where(eq(seatExecutionPermits.runId, s.runId!));
      event("mock-result", {
        node: s.jiraKey,
        intent: s.intent ?? "work",
        round,
        result: receipt.testResults?.failed ? "failed" : receipt.codeReview?.decision ?? "passed"
      });
      return receipt;
    }
    async function human(s: DeliveryStageRecord, decision: "approve" | "reject" = "approve", note = "已核对当前模拟交付") {
      const body = {
        taskId: s.taskId,
        digest: s.inputDigest,
        decision,
        reference: origin + "/browse/" + s.jiraKey,
        note,
        ...(!s.reviewWorkKeys ? {
          manualDelivery: {
            version: "mock-human-" + (s.reworkHistory?.length ?? 0),
            artifactReferences: [origin + "/secure/attachment/1/mock.md"]
          }
        } : {})
      };
      const r = await request(app()).post(base + `/${id}/review`).send(body);
      expect(r.status, r.text).toBe(200);
      expect((await inbox()).some((a: any) => a.taskId === s.taskId)).toBe(false);
      event("mock-human-decision", {
        node: s.jiraKey,
        decision,
        note
      });
      return body;
    }
    async function finish() {
      for (let i = 0; i < 40; i++) {
        const f = await tick();
        if (f.state === "acceptance") return f;
        expect(f.state, f.message ?? "").toBe("active");
        for (const s of f.stages.filter(s => s.state !== "done")) {
          const actions = await inbox();
          const confirm = actions.find((a: any) => a.taskId === s.taskId && a.kind === "confirm-start");
          if (confirm) {
            const current = (await flow()).stages.find(node => node.taskId === s.taskId)!;
            expect(current.inputDigest).toMatch(/^[a-f0-9]{64}$/);
            const r = await request(app()).post(base + `/${id}/confirm-start`).send({
              taskId: s.taskId,
              inputDigest: current.inputDigest
            });
            expect(r.status, r.text).toBe(200);
            event("mock-start-confirmed", {
              node: s.jiraKey
            });
          } else if (s.executionMode === "human" && s.state === "review") await human(s);else if (s.runId && !s.receipt) {
            const ctx = await context(s);
            expect(ctx.upstream.length).toBeGreaterThanOrEqual(s.dependsOn?.length ?? 0);
            await complete(s);
          }
        }
      }
      throw Error("Simulation exceeded 40 scheduler ticks: " + JSON.stringify(await flow()));
    }
    async function accept() {
      const f = await flow();
      expect(f.state).toBe("acceptance");
      expect(f.stages.every(s => s.state === "done")).toBe(true);
      expect((await inbox()).map((a: any) => a.kind)).toEqual(["accept"]);
      const r = await request(app()).post(base + `/${id}/accept`).send({
        fingerprint,
        reference: "https://formal.example/simulation/accepted",
        note: "MOCK 正式验收通过"
      });
      expect(r.status, r.text).toBe(200);
      expect((await flow()).state).toBe("completed");
      expect(await inbox()).toEqual([]);
      const before = dispatches.length;
      await Promise.all([tick(), tick()]);
      expect(dispatches).toHaveLength(before);
      const tasks = await db.select().from(issues).where(eq(issues.companyId, companyId));
      expect(tasks.filter(t => f.stages.some(s => s.taskId === t.id)).every(t => t.status === "done")).toBe(true);
      if (options.repair) {
        expect(tasks).toHaveLength(rows.length);
        expect(f.stages).toHaveLength(rows.length);
      }
      const [template] = await db.select().from(deliveryWorkflowTemplates).where(eq(deliveryWorkflowTemplates.projectId, projectId));
      expect(template.definition).toEqual(definition);
      const audit = await db.select().from(activityLog).where(and(eq(activityLog.companyId, companyId), eq(activityLog.action, "delivery.workflow.accepted")));
      expect(audit).toHaveLength(1);
      expect(vi.mocked(fetch)).not.toHaveBeenCalled();
      event("accepted", {
        nodeCount: f.stages.length,
        dispatchCount: dispatches.length,
        jiraWrites: jiraSpecs.length
      });
      report.status = "passed";
      report.elapsedMs = Math.round(performance.now() - started);
    }
    event("planned-and-started", {
      nodes: rows.length,
      seats: seats.size
    });
    return {
      id,
      companyId,
      projectId,
      snapshotId,
      app,
      base,
      flow,
      tick,
      inbox,
      context,
      callback,
      complete,
      human,
      finish,
      accept,
      seats,
      dispatches,
      jiraSpecs,
      event,
      definition,
      occupiedRun
    };
  }
  async function presence(f: Awaited<ReturnType<typeof fixture>>, online: boolean) {
    const seat = f.seats.get("dev-a")!;
    await db.update(agents).set({
      adapterConfig: {
        ...seat.config,
        dsp7SeatPresence: {
          ...seat.config.dsp7SeatPresence,
          lastSeenAt: online ? new Date().toISOString() : new Date(0).toISOString(),
          state: online ? "idle" : "offline"
        }
      }
    }).where(eq(agents.id, seat.id));
    f.event(online ? "seat-online" : "seat-offline", {
      seat: "dev-a"
    });
  }
  it("waits for an offline seat before dispatch and automatically continues on the same seat after reconnect", async () => {
    const f = await fixture("offline-before-dispatch", {
      offline: true
    });
    const initial = (await f.flow()).stages[0];
    await f.tick();
    await f.tick();
    expect(f.dispatches).toHaveLength(0);
    expect((await f.flow()).stages[0].runId).toBeNull();
    expect(await f.inbox()).toEqual([]);
    await presence(f, true);
    await f.tick();
    await f.tick();
    const resumed = (await f.flow()).stages[0];
    expect(resumed.taskId).toBe(initial.taskId);
    expect(resumed.seatId).toBe(initial.seatId);
    expect(resumed.runId).toBeTruthy();
    expect(f.dispatches).toHaveLength(1);
    f.event("offline-queue-resumed-on-original-seat");
    await f.finish();
    await f.accept();
  }, 30000);
  it("preserves a live run and its answered question across a connection loss without duplicate dispatch", async () => {
    const f = await fixture("offline-live-run");
    await f.tick();
    const original = (await f.flow()).stages[0];
    expect(original.runId).toBeTruthy();
    const question = {
      text: "断线前确认付款重试范围",
      digest: hash("offline-question")
    };
    expect((await f.callback(original, "question", question)).status).toBe(200);
    await presence(f, false);
    const before = f.dispatches.length;
    for (let i = 0; i < 3; i++) await f.tick();
    expect(f.dispatches).toHaveLength(before);
    expect((await f.flow()).stages[0].runId).toBe(original.runId);
    expect((await f.flow()).stages.slice(1).every(s => !s.runId)).toBe(true);
    const answer = await request(f.app()).post(f.base + `/${f.id}/answer`).send({
      taskId: original.taskId,
      digest: question.digest,
      answer: "按原流水号幂等重试"
    });
    expect(answer.status, answer.text).toBe(200);
    expect(await f.inbox()).toEqual([]);
    await presence(f, true);
    await f.tick();
    expect((await f.callback(original, "question", question)).body.answer).toBe("按原流水号幂等重试");
    const continued = (await f.flow()).stages[0];
    expect(continued.runId).toBe(original.runId);
    expect(continued.dispatchId).toBe(original.dispatchId);
    await f.complete(continued);
    f.event("original-run-continued-with-persisted-answer");
    await f.finish();
    await f.accept();
  }, 30000);
  it("requires verified old-process exit and administrator retry after an offline run terminates", async () => {
    const f = await fixture("offline-terminated-run");
    await f.tick();
    const original = (await f.flow()).stages[0];
    await presence(f, false);
    await db.update(heartbeatRuns).set({
      status: "failed"
    }).where(eq(heartbeatRuns.id, original.runId!));
    await f.tick();
    expect((await f.flow()).stages[0].state).toBe("interrupted");
    expect((await f.inbox()).map((action: any) => action.kind)).toEqual(["recovery"]);
    await presence(f, true);
    const before = f.dispatches.length;
    await f.tick();
    expect(f.dispatches).toHaveLength(before);
    const retry = () => request(f.app()).post(f.base + `/${f.id}/retry`).send({
      taskId: original.taskId
    });
    expect((await retry()).status).toBe(409);
    await db.update(seatExecutionPermits).set({
      treeStopVerifiedAt: new Date()
    }).where(eq(seatExecutionPermits.runId, original.runId!));
    const restored = await retry();
    expect(restored.status, restored.text).toBe(200);
    await f.tick();
    await f.tick();
    const resumed = (await f.flow()).stages[0];
    expect(resumed.taskId).toBe(original.taskId);
    expect(resumed.seatId).toBe(original.seatId);
    expect(resumed.runId).not.toBe(original.runId);
    expect(resumed.dispatchId).not.toBe(original.dispatchId);
    expect(resumed.resumeCount).toBe(1);
    const stale = await f.callback(original, "context");
    expect([404, 409]).toContain(stale.status);
    f.event("terminated-run-recovered-with-new-grant");
    await f.finish();
    await f.accept();
  }, 30000);
  it("completes mixed human/Agent nodes with questions, busy-seat waiting, parallel join and design rework", async () => {
    const f = await fixture("mixed", {
      humanWork: true,
      busy: true
    });
    expect(await f.inbox()).toEqual([]);
    expect((await request(f.app()).post(f.base + `/${f.id}/accept`).send({
      fingerprint,
      reference: "https://formal.example/early",
      note: "too early"
    })).status).toBe(409);
    const seat = f.seats.get("dev-a")!;
    await db.update(agents).set({
      adapterConfig: {
        ...seat.config,
        dsp7SeatPresence: {
          ...seat.config.dsp7SeatPresence,
          state: "busy"
        }
      }
    }).where(eq(agents.id, seat.id));
    await f.tick();
    expect(f.dispatches).toHaveLength(0);
    expect(await f.inbox()).toEqual([]);
    f.event("busy-seat-waited");
    await db.update(heartbeatRuns).set({
      status: "succeeded"
    }).where(eq(heartbeatRuns.id, f.occupiedRun!.id));
    await db.update(agents).set({
      adapterConfig: {
        ...seat.config,
        dsp7SeatPresence: {
          ...seat.config.dsp7SeatPresence,
          state: "idle"
        }
      }
    }).where(eq(agents.id, seat.id));
    await f.tick();
    await f.tick();
    expect(f.dispatches).toHaveLength(1);
    let s = (await f.flow()).stages[0];
    const initialDesign = structuredClone(s);
    const q = {
      text: "付款失败后是否需要幂等重试？",
      digest: hash("mock-question")
    };
    expect((await f.callback(s, "question", q)).body.answer).toBeNull();
    expect((await f.inbox()).map((a: any) => a.kind)).toEqual(["answer"]);
    expect((await request(f.app("other")).post(f.base + `/${f.id}/answer`).send({
      taskId: s.taskId,
      digest: q.digest,
      answer: "invalid"
    })).status).toBe(403);
    expect((await request(f.app()).post(f.base + `/${f.id}/answer`).send({
      taskId: s.taskId,
      digest: hash("stale"),
      answer: "invalid"
    })).status).toBe(409);
    const answer = "需要按业务流水号幂等重试，避免重复付款";
    expect((await request(f.app()).post(f.base + `/${f.id}/answer`).send({
      taskId: s.taskId,
      digest: q.digest,
      answer
    })).status).toBe(200);
    expect((await f.callback(s, "question", q)).body.answer).toBe(answer);
    expect(await f.inbox()).toEqual([]);
    f.event("question-round-trip", {
      question: q.text,
      answer
    });
    await f.complete(s);
    await f.tick();
    await f.tick();
    let flow = await f.flow();
    s = flow.stages.find(s => s.jiraKey === "SIM-2")!;
    expect(s.state).toBe("review");
    expect(flow.stages.filter(s => s.stage === "coding").every(s => !s.runId)).toBe(true);
    const rejected = await f.human(s, "reject", "设计缺少付款幂等处理，请研发补充异常与重试设计");
    await f.tick();
    await f.tick();
    flow = await f.flow();
    const rework = flow.stages[0];
    expect(rework.taskId).toBe(initialDesign.taskId);
    expect(rework.seatId).toBe(seat.id);
    expect(rework.runId).not.toBe(initialDesign.runId);
    expect((await f.context(rework)).stage.reworkHistory[0].rejection.note).toContain("幂等");
    f.event("rejection-delivered-to-original-seat");
    expect((await request(f.app()).post(f.base + `/${f.id}/review`).send({
      ...rejected,
      decision: "approve"
    })).status).toBe(409);
    await f.complete(rework);
    await f.tick();
    await f.tick();
    await f.human((await f.flow()).stages.find(s => s.jiraKey === "SIM-2")!);
    await f.tick();
    flow = await f.flow();
    const coding = flow.stages.filter(s => s.stage === "coding" && !s.intent);
    expect(coding).toHaveLength(2);
    expect(coding.every(s => s.runId)).toBe(true);
    expect(new Set(coding.map(s => s.seatId)).size).toBe(2);
    await f.complete(coding[0]);
    await f.tick();
    expect((await f.flow()).stages.find(s => s.intent === "code-review")!.runId).toBeNull();
    await f.complete(coding[1]);
    await f.tick();
    await f.tick();
    const review = (await f.flow()).stages.find(s => s.intent === "code-review")!;
    expect(review.runId).toBeTruthy();
    expect(coding.every(s => s.seatId !== review.seatId)).toBe(true);
    expect((await f.context(review)).upstream.filter((s: any) => s.stage === "coding")).toHaveLength(2);
    f.event("parallel-join-and-independent-review");
    await f.finish();
    await f.accept();
  }, 30000);
  it("completes all Agent review nodes and human final acceptance", async () => {
    const f = await fixture("agent-reviews", {
      agentReviews: true
    });
    await f.finish();
    expect((await f.flow()).stages.filter(s => s.executionMode === "human")).toHaveLength(0);
    await f.accept();
  }, 30000);
  it.each(["automatic_rework", "pause"] as const)("handles normal code review rejection with %s and preserves the original coding seats", async policy => {
    const f = await fixture("code-review-" + policy, {
      codingRejection: policy
    });
    let review: DeliveryStageRecord | undefined;
    for (let i = 0; i < 25; i++) {
      const flow = await f.tick();
      review = flow.stages.find(s => s.intent === "code-review");
      if (review?.runId) break;
      for (const s of flow.stages.filter(s => s.state !== "done")) {
        if (s.executionMode === "human" && s.state === "review") await f.human(s);else if (s.runId && !s.receipt) await f.complete(s);
      }
    }
    expect(review?.runId).toBeTruthy();
    const before = (await f.flow()).stages.filter(s => s.stage === "coding" && !s.intent);
    const sha = hash("normal-review-rejection");
    await f.complete(review!, {
      artifacts: [{
        path: "review.md",
        sha256: sha
      }],
      codeReview: {
        decision: "rejected",
        note: "付款异常重试缺少幂等校验，请补充流水号去重",
        reviewedVersionDigest: deliveryDigest({
          inputDigest: review!.inputDigest,
          workKeys: review!.reviewWorkKeys
        }),
        sourcePath: "review.md",
        sourceSha256: sha
      }
    });
    if (policy === "pause") {
      await f.tick();
      const paused = await f.flow();
      expect(paused.state).toBe("blocked");
      expect((await f.inbox()).map((action: any) => action.kind)).toEqual(["recovery"]);
      const rejected = paused.stages.find(s => s.taskId === review!.taskId)!;
      const resumed = await request(f.app()).post(f.base + `/${f.id}/rework`).send({
        taskId: rejected.taskId,
        digest: rejected.receiptDigest
      });
      expect(resumed.status, resumed.text).toBe(200);
      f.event("manual-rework-authorized");
    }
    for (let i = 0; i < 3; i++) await f.tick();
    const flow = await f.flow();
    expect(flow.state, flow.message ?? "").toBe("active");
    for (const original of before) {
      const reopened = flow.stages.find(s => s.taskId === original.taskId)!;
      expect(reopened.seatId).toBe(original.seatId);
      expect(reopened.runId).not.toBe(original.runId);
      expect((await f.context(reopened)).stage.reworkHistory[0].rejection.note).toContain("流水号去重");
    }
    f.event("agent-review-rejection-delivered-to-coding");
    await f.finish();
    await f.accept();
  }, 30000);
  it("passes QA defects to the original development/review/QA seats and accepts only the repaired build", async () => {
    const f = await fixture("qa-repair", {
      repair: true
    });
    // Drive the complete normal prefix, stopping at the real QA callback.
    for (let i = 0; i < 30; i++) {
      const flow = await f.tick(),
        qa = flow.stages.find(s => s.stage === "functional-test")!;
      if (qa.runId) break;
      for (const s of flow.stages.filter(s => s.state !== "done")) {
        if ((await f.inbox()).some((a: any) => a.taskId === s.taskId && a.kind === "confirm-start")) {
          expect((await request(f.app()).post(f.base + `/${f.id}/confirm-start`).send({
            taskId: s.taskId,
            inputDigest: s.inputDigest
          })).status).toBe(200);
        } else if (s.executionMode === "human" && s.state === "review") await f.human(s);else if (s.runId && !s.receipt) await f.complete(s);
      }
    }
    const originalNodes = (await f.flow()).stages.map(s => ({
      taskId: s.taskId,
      jiraKey: s.jiraKey,
      intent: s.intent
    }));
    const qa = (await f.flow()).stages.find(s => s.stage === "functional-test")!;
    const failure = {
      caseId: "PAY-1",
      module: "payments",
      kind: "product" as const,
      summary: "重复请求造成重复付款",
      steps: "对同一业务流水提交两次付款",
      expected: "只支付一次",
      actual: "发生两次支付"
    };
    const sha = hash("qa-failed"),
      failuresSha = hash("failure-report");
    await f.complete(qa, {
      artifacts: [{
        path: "execution-records.md",
        sha256: sha
      }, {
        path: "delivery-failures.json",
        sha256: failuresSha,
        downloadUrl: origin + "/secure/attachment/2/delivery-failures.json"
      }],
      testResults: {
        total: 2,
        passed: 1,
        failed: 1,
        blocked: 0,
        skipped: 0,
        testedVersion: "mock-build-1",
        sourcePath: "execution-records.md",
        sourceSha256: sha
      },
      failureReport: {
        sourcePath: "delivery-failures.json",
        sourceSha256: failuresSha,
        defects: [failure]
      }
    });
    await f.tick();
    expect((await f.flow()).state).toBe("blocked");
    const invalidReplacement = await request(f.app()).post(f.base + `/${f.id}/repair`).send({
      expectedReceiptDigest: (await f.flow()).stages.find(s => s.taskId === qa.taskId)!.receiptDigest,
      defectKey: "NEW-1",
      reviewKey: "NEW-2",
      retestKey: "NEW-3",
      developmentSeatId: f.seats.get("dev-a")!.id,
      reviewSeatId: f.seats.get("reviewer")!.id,
      qaSeatId: f.seats.get("qa")!.id
    });
    expect(invalidReplacement.status, invalidReplacement.text).toBe(409);
    expect(invalidReplacement.body.error).toContain("复用");
    for (let i = 0; i < 7; i++) await f.tick();
    let flow = await f.flow();
    expect(flow.state, flow.message ?? "").toBe("active");
    expect(flow.stages).toHaveLength(originalNodes.length);
    expect(flow.stages.map(s => s.jiraKey)).toEqual(originalNodes.map(s=>s.jiraKey));
    expect(f.jiraSpecs).toHaveLength(0);
    expect(external.jira).not.toHaveBeenCalled();
    const fix = flow.stages.find(s => s.jiraKey === "SIM-3")!;
    expect(flow.stages.find(s => s.jiraKey === "SIM-4")!.state).toBe("done");
    expect(fix.repairReused).toBe(true);
    expect(fix.intent).toBeUndefined();
    expect(fix.seatId).toBe(f.seats.get("dev-a")!.id);
    const ctx = await f.context(fix);
    expect(ctx.stage.repairFailure.receipt.failureReport.defects).toEqual([failure]);
    expect(ctx.stage.reworkHistory.at(-1).rejection.note).toContain(failure.actual);
    f.event("qa-defect-delivered-to-development", {
      summary: failure.summary
    });
    const buildSha = hash("repaired-build");
    await f.complete(fix, {
      artifacts: [{
        path: "delivery-build.json",
        sha256: buildSha,
        downloadUrl: origin + "/secure/attachment/3/delivery-build.json"
      }],
      build: {
        version: "mock-build-2",
        environmentReference: "https://env.example/simulation",
        observationUrl: "https://env.example/simulation/version",
        sourcePath: "delivery-build.json",
        sourceSha256: buildSha
      }
    });
    await f.tick();
    await f.tick();
    flow = await f.flow();
    const review = flow.stages.find(s => s.intent === "code-review" && s.repairReused)!;
    expect(review.seatId).toBe(f.seats.get("reviewer")!.id);
    expect(review.seatId).not.toBe(fix.seatId);
    await f.complete(review);
    await f.tick();
    await f.tick();
    const retest = (await f.flow()).stages.find(s => s.stage === "functional-test" && s.repairReused)!;
    expect(retest.seatId).toBe(f.seats.get("qa")!.id);
    expect(retest.expectedBuild?.version).toBe("mock-build-2");
    const staleSha = hash("stale-retest");
    const stale = await f.callback(retest, "delivery", {
      receipt: {
        protocolVersion: 1,
        taskId: retest.taskId,
        runId: retest.runId,
        stage: retest.stage,
        jiraKey: retest.jiraKey,
        inputDigest: retest.inputDigest,
        stateDigest: staleSha,
        trackerReceiptId: "mock-stale",
        jiraReference: origin + "/browse/" + retest.jiraKey,
        artifacts: [{
          path: "execution-records.md",
          sha256: staleSha
        }],
        testResults: {
          total: 2,
          passed: 2,
          failed: 0,
          blocked: 0,
          skipped: 0,
          testedVersion: "mock-build-1",
          sourcePath: "execution-records.md",
          sourceSha256: staleSha
        }
      }
    });
    expect(stale.status, stale.text).toBe(409);
    f.event("stale-retest-build-rejected");
    // A second QA failure must reopen exactly the same three tasks again.
    const secondSha = hash("second-failed-run"),
      secondReportSha = hash("second-failure-report");
    await f.complete(retest, {
      artifacts: [{
        path: "execution-records.md",
        sha256: secondSha,
        downloadUrl: origin + "/secure/attachment/4/execution-records.md"
      }, {
        path: "delivery-failures.json",
        sha256: secondReportSha,
        downloadUrl: origin + "/secure/attachment/5/delivery-failures.json"
      }],
      testResults: {
        total: 2,
        passed: 1,
        failed: 1,
        blocked: 0,
        skipped: 0,
        testedVersion: "mock-build-2",
        sourcePath: "execution-records.md",
        sourceSha256: secondSha
      },
      failureReport: {
        sourcePath: "delivery-failures.json",
        sourceSha256: secondReportSha,
        defects: [failure]
      }
    });
    await f.tick();
    for (let i = 0; i < 7; i++) await f.tick();
    const secondFix = (await f.flow()).stages.find(s => s.jiraKey === "SIM-3")!;
    expect(secondFix.taskId).toBe(fix.taskId);
    expect(secondFix.runId).not.toBe(fix.runId);
    const nextBuildSha = hash("repaired-build-3");
    await f.complete(secondFix, {
      artifacts: [{
        path: "delivery-build.json",
        sha256: nextBuildSha,
        downloadUrl: origin + "/secure/attachment/6/delivery-build.json"
      }],
      build: {
        version: "mock-build-3",
        environmentReference: "https://env.example/simulation",
        observationUrl: "https://env.example/simulation/version",
        sourcePath: "delivery-build.json",
        sourceSha256: nextBuildSha
      }
    });
    await f.tick();
    await f.tick();
    await f.complete((await f.flow()).stages.find(s => s.jiraKey === "SIM-5")!);
    await f.tick();
    await f.tick();
    const finalTest = (await f.flow()).stages.find(s => s.taskId === qa.taskId)!;
    expect(finalTest.expectedBuild?.version).toBe("mock-build-3");
    expect(finalTest.repairHistory).toHaveLength(2);
    expect(f.jiraSpecs).toHaveLength(0);
    f.event("second-qa-cycle-reused-same-tasks");
    await f.finish();
    expect(f.jiraSpecs).toHaveLength(0);
    await f.accept();
    expect((await f.flow()).stages.map(s => ({
      taskId: s.taskId,
      jiraKey: s.jiraKey,
      intent: s.intent
    }))).toEqual(originalNodes);
  }, 30000);
});
