import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { activityLog, agents, analysisExecutions, companies, companySecrets, createDb, deliveryConnections, deliverySnapshots, issues, projects, type Db } from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "../__tests__/helpers/embedded-postgres.js";
import { deliveryConnectionRoutes } from "./delivery-connections.js";
import { createDeliveryMonthlyScheduler, nextDeliveryMonthlySync } from "../services/delivery-monthly-schedule.js";
import { createDeliverySourceOperations } from "../services/delivery-source-operations.js";
import { normalizeDeliverySnapshot } from "../services/delivery-intake.js";
import { fixture } from "../services/delivery-intake.fixture.js";
import { badRequest } from "../errors.js";
import { QingzhouReadError } from "../services/qingzhou-client.js";
import type { secretService } from "../services/secrets.js";
import type { DeliveryMonthlyEntries } from "@paperclipai/shared";
import { annotateMonthlyDelivery } from "../services/delivery-monthly-annotations.js";
import { deliveryAdmission, latestDeliverySnapshots } from "../services/delivery-admission.js";
import { deliveryChainAdmission } from "../services/delivery-chain-admission.js";
const support = await getEmbeddedPostgresTestSupport();
it("calculates the next daily run in Shanghai across midnight and month boundaries", () => {
  expect(nextDeliveryMonthlySync("06:00", new Date("2026-11-30T16:00:00Z"))).toBe("2026-11-30T22:00:00.000Z");
  expect(nextDeliveryMonthlySync("06:00", new Date("2026-11-30T22:00:00Z"))).toBe("2026-12-01T22:00:00.000Z");
});

(support.supported ? describe : describe.skip)("online delivery connection routes", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>, db: ReturnType<typeof createDb>;
  beforeAll(async () => { database = await startEmbeddedPostgresTestDatabase("delivery-source-"); db = createDb(database.connectionString); });
  afterAll(async () => { await database?.cleanup(); });
  async function seed() {
    const companyId = randomUUID(), projectId = randomUUID(), agentId = randomUUID(), jiraSecretId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Source", issuePrefix: `S${companyId.slice(0, 6)}` });
    await db.insert(projects).values({ id: projectId, companyId, name: "Project" });
    await db.insert(companySecrets).values({ id: jiraSecretId, companyId, name: "Jira", key: "jira" });
    const config = { dsp7Seat: { machineId: randomUUID() }, dsp7JiraDispatch: { projectId, jiraSecretId, jiraBaseUrl: "http://jira.fingard.com:6001", revision: 1 } };
    await db.insert(agents).values({ id: agentId, companyId, name: "Seat", role: "engineer", adapterType: "claude_local", adapterConfig: config });
    const values = new Map<string, string>();
    const secrets = ((tx: Db) => ({
      create: async (cid: string, data: { value: string; name: string }) => { const id = randomUUID(); values.set(id, data.value); await tx.insert(companySecrets).values({ id, companyId: cid, name: data.name, key: id }); return { id }; },
      rotate: async (id: string, data: { value: string }) => { values.set(id, data.value); },
      resolveSecretValue: async (_cid: string, id: string) => {
        // Match the real secret service: a read writes usage timestamps.
        await tx.update(companySecrets).set({lastResolvedAt:new Date(),updatedAt:new Date()}).where(eq(companySecrets.id,id));
        return id === jiraSecretId ? "test-jira-pat" : values.get(id);
      },
    })) as unknown as typeof secretService;
    let reads = 0;
    let duringRead: (() => Promise<void>) | undefined;
    const reader = async (input: any) => {
      reads++; expect(await input.credentials()).toEqual({ username: "test-user", password: "test-password" });
      expect(input.jira.token).toBe("test-jira-pat");
      await duringRead?.();
      return { plan: normalizeDeliverySnapshot({ ...fixture(), projectId }, "online_readonly"), collectedAt: fixture().collectedAt };
    };
    function app(actor: Record<string, unknown> = { type: "board", source: "local_implicit", userId: "admin" }, read = reader, monthly = async (input: any) => { expect(input.organizationId).toBe("123"); expect(input.month).toBe("2026-10"); expect(await input.credentials()).toEqual({username:"test-user",password:"test-password"}); return {month:input.month,collectedAt:new Date().toISOString(),items:[{demandNo:"ATS3-00156",title:"Monthly",owner:"Owner",sourceStatus:"",startDate:"",endDate:"",workCount:2,snapshotId:null,admission:null}],executionAllowed:false as const}; }, demand = async (input: any) => {
      expect(await input.credentials()).toEqual({username:"test-user",password:"test-password"});
      return {demandNo:input.demandNo,title:"未排期条目",sourceStatus:"待需求分析",owner:"拆分人员",analysisOwner:"分析人员",collectedAt:new Date().toISOString()};
    }) {
      const app = express();app.use(express.json());app.use((req, _res, next) => { Object.assign(req, { actor });next(); });
      app.use(deliveryConnectionRoutes(db, read, secrets, monthly, async input => {expect(await input.credentials()).toEqual({username:"test-user",password:"test-password"});return {items:[{id:"123",name:"研发七组",code:"D7",kinds:["researchGroup"]}],collectedAt:new Date().toISOString()};}, demand));app.use((error: any, _req: any, res: any, _next: any) => res.status(error.status ?? 500).json({ error: error.message }));return app;
    }
    const base = `/companies/${companyId}/delivery-connections`;
    const save = { projectId, expectedRevision: 0, jiraAgentId: agentId, organizationId: "123", credentials: { username: "test-user", password: "test-password" } };
    const sync = { projectId, expectedRevision: 1, demandNo: "ATS3-00156", months: ["2026-10"] };
    return { companyId, projectId, agentId, jiraSecretId, config, base, app, save, sync, reader, secrets, reads: () => reads, change: (fn: () => Promise<void>) => { duringRead = fn; } };
  }
  it("saves an administrator's schedule and syncs the current Beijing month once across workers", async () => {
    const f = await seed();
    const app = f.app();
    const url = f.base + "/monthly-schedule";
    const settings = { projectId: f.projectId, enabled: true, time: "06:00" };
    expect((await request(app).get(url).query({ projectId: f.projectId })).body).toMatchObject({
      enabled: false, time: "06:00", timezone: "Asia/Shanghai", nextRunAt: null, lastRun: null,
    });
    expect((await request(app).put(url).send(settings)).status).toBe(409);
    const member = f.app({ type: "board", source: "session", companyIds: [f.companyId], memberships: [] });
    expect((await request(member).get(url).query({ projectId: f.projectId })).status).toBe(403);
    expect((await request(member).put(url).send(settings)).status).toBe(403);
    expect((await request(app).put(f.base).send(f.save)).status).toBe(200);
    expect((await request(app).put(url).send({ ...settings, time: "24:00" })).status).toBe(400);
    const saved = await request(app).put(url).send(settings);
    expect(saved.status).toBe(200);
    expect(saved.body).toMatchObject({ enabled: true, time: "06:00", timezone: "Asia/Shanghai", lastRun: null });
    expect(saved.body.nextRunAt).toMatch(/T22:00:00\.000Z$/);
    const [[connection], [audit]] = await Promise.all([
      db.select().from(deliveryConnections).where(eq(deliveryConnections.projectId, f.projectId)),
      db.select().from(activityLog).where(eq(activityLog.action, "delivery.monthly_sync.schedule_updated")),
    ]);
    expect(connection!.revision).toBe(1);
    expect(audit).toMatchObject({ actorId: "admin", entityId: connection!.id });

    // 06:00 on December 1 in Shanghai is still November in UTC.
    const now = new Date("2026-11-30T22:00:00Z");
    await db.update(deliveryConnections).set({ monthlySync: { ...saved.body, nextRunAt: now.toISOString() } })
      .where(eq(deliveryConnections.id, connection!.id));
    const entry: DeliveryMonthlyEntries["items"][number] = {
      demandNo: f.sync.demandNo, title: "Monthly", owner: "Owner", sourceStatus: "",
      startDate: "", endDate: "", workCount: 2, snapshotId: null, admission: null,
    };
    const monthly = vi.fn(async ({ month, credentials }: { month: string; credentials: () => Promise<unknown> }) => {
      expect(month).toBe("2026-12");
      expect(await credentials()).toEqual(f.save.credentials);
      return {
        month, collectedAt: now.toISOString(), executionAllowed: false as const,
        items: [entry, entry, { ...entry, demandNo: "ATS3-00157" }],
      };
    });
    const reader = vi.fn(async (input: Parameters<typeof f.reader>[0]) => {
      expect(input.months).toEqual(["2026-12"]);
      if (input.demandNo === "ATS3-00157") throw new QingzhouReadError("connection_unavailable");
      return f.reader(input);
    });
    const source = createDeliverySourceOperations(db, reader, f.secrets, monthly);
    await Promise.all([
      createDeliveryMonthlyScheduler(db, source, () => now)(),
      createDeliveryMonthlyScheduler(db, source, () => now)(),
    ]);
    expect(monthly).toHaveBeenCalledTimes(1);
    expect(reader).toHaveBeenCalledTimes(2);
    const after = await request(app).get(url).query({ projectId: f.projectId });
    expect(after.body).not.toHaveProperty("leaseUntil");
    expect(after.body).toMatchObject({
      nextRunAt: "2026-12-01T22:00:00.000Z",
      lastRun: { month: "2026-12", status: "partial", total: 2, succeeded: 1, failed: 1 },
    });
    expect(await db.select().from(deliverySnapshots).where(eq(deliverySnapshots.companyId, f.companyId))).toHaveLength(1);
    const disabled = await request(app).put(url).send({ ...settings, enabled: false });
    expect(disabled.body).toMatchObject({ enabled: false, nextRunAt: null, lastRun: after.body.lastRun });
  });
  it("looks up an exact unscheduled demand without monthly or Jira reads or creating a snapshot", async () => {
    const f=await seed(), app=f.app(); await request(app).put(f.base).send(f.save);
    const response=await request(app).post(f.base+"/lookup").send({projectId:f.projectId,expectedRevision:1,demandNo:" twgf-00919 "});
    expect(response.status).toBe(200);expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.body).toMatchObject({demandNo:"TWGF-00919",title:"未排期条目",snapshotId:null});
    expect(JSON.stringify(response.body)).not.toMatch(/test-password|test-user|SecretId/);
    expect(f.reads()).toBe(0);expect(await db.select().from(deliverySnapshots).where(eq(deliverySnapshots.companyId,f.companyId))).toHaveLength(0);
    expect((await request(app).post(f.base+"/lookup").send({projectId:f.projectId,expectedRevision:1,demandNo:"TWGF"})).status).toBe(400);
    expect((await request(app).post(f.base+"/lookup").send({projectId:f.projectId,expectedRevision:2,demandNo:"TWGF-00919"})).status).toBe(409);
    const member=f.app({type:"board",source:"session",companyIds:[f.companyId],memberships:[]});
    expect((await request(member).post(f.base+"/lookup").send({projectId:f.projectId,expectedRevision:1,demandNo:"TWGF-00919"})).status).toBe(403);
    const other=await seed();
    expect((await request(app).post(f.base+"/lookup").send({projectId:other.projectId,expectedRevision:1,demandNo:"TWGF-00919"})).status).toBe(403);
  });
  it("links only the latest matching version in each live project of the same company", async () => {
    const f = await seed(), foreign = await seed(), app = f.app();
    await request(app).put(f.base).send(f.save);
    const otherProject = randomUUID(), archivedProject = randomUUID();
    await db.insert(projects).values([
      { id: otherProject, companyId: f.companyId, name: "基础平台" },
      { id: archivedProject, companyId: f.companyId, name: "已归档", archivedAt: new Date() },
    ]);
    const id = randomUUID();
    const snapshot = (companyId: string, projectId: string, version: number, snapshotId = randomUUID()) => ({
      id: snapshotId, companyId, projectId, sourceOrigin: "https://proj.fingard.com:1888", demandNo: "TWGF-00919",
      fingerprint: String(version), collectedAt: new Date(`2026-11-0${version}T00:00:00Z`),
      createdByUserId: "admin", plan: normalizeDeliverySnapshot({ ...fixture(), projectId }, "online_readonly"),
    });
    await db.insert(deliverySnapshots).values([
      snapshot(f.companyId, otherProject, 1), snapshot(f.companyId, otherProject, 2, id),
      snapshot(f.companyId, archivedProject, 2), snapshot(foreign.companyId, foreign.projectId, 2),
    ]);
    const payload = { projectId: f.projectId, expectedRevision: 1, demandNo: "TWGF-00919" };
    const lookedUp = await request(app).post(f.base + "/lookup").send(payload);
    expect(lookedUp.status, lookedUp.text).toBe(200);
    expect(lookedUp.body).toMatchObject({ snapshotId: null, savedEntries: [{ projectId: otherProject, projectName: "基础平台", snapshotId: id }] });
    const current = snapshot(f.companyId, f.projectId, 3);
    await db.insert(deliverySnapshots).values(current);
    const saved = await request(app).post(f.base + "/lookup").send(payload);
    expect(saved.body.snapshotId).toBe(current.id);
    expect(saved.body.savedEntries).toHaveLength(2);
  });

  it("rejects lookup results if source configuration changes during the read", async () => {
    const f=await seed();await request(f.app()).put(f.base).send(f.save);
    const app=f.app(undefined,undefined,undefined,async(input:any)=>{
      await db.update(deliveryConnections).set({revision:2}).where(eq(deliveryConnections.projectId,f.projectId));
      return {demandNo:input.demandNo,title:"旧配置结果",sourceStatus:"",owner:"",analysisOwner:"",collectedAt:new Date().toISOString()};
    });
    expect((await request(app).post(f.base+"/lookup").send({projectId:f.projectId,expectedRevision:1,demandNo:"TWGF-00919"})).status).toBe(409);
  });
  it("blocks unauthorized mutation and cross-company reads before network access", async () => {
    const f = await seed();
    const member = f.app({ type: "board", source: "session", companyIds: [f.companyId], memberships: [] });
    expect((await request(member).put(f.base).send(f.save)).status).toBe(403);
    const outsider = f.app({ type: "board", source: "session", companyIds: [] });
    expect((await request(outsider).get(f.base + "?projectId=" + f.projectId)).status).toBe(403);expect(f.reads()).toBe(0);
  });
  it("shows the saved Qingzhou username to managers, preserves omitted credentials and rejects stale saves", async () => {
    const f = await seed(), app = f.app();
    const saved = await request(app).put(f.base).send(f.save);
    expect(saved.status).toBe(200);
    expect(saved.body).toMatchObject({ credentialsConfigured: true, qingzhouUsername: "test-user" });
    const member = f.app({ type: "board", source: "session", companyIds: [f.companyId], memberships: [] });
    const managerRead = await request(app).get(f.base).query({ projectId: f.projectId });
    expect(managerRead.status).toBe(200);
    expect(managerRead.body.qingzhouUsername).toBe("test-user");
    const memberRead = await request(member).get(f.base).query({ projectId: f.projectId });
    expect(memberRead.status).toBe(200);
    expect(memberRead.body).not.toHaveProperty("qingzhouUsername");
    for (const response of [saved, managerRead, memberRead]) {
      expect(JSON.stringify(response.body)).not.toMatch(/test-password|credentialSecretId/);
    }
    expect((await request(app).put(f.base).send(f.save)).status).toBe(409);
    const { credentials: _omit, ...next } = f.save;
    const retained = await request(app).put(f.base).send({ ...next, expectedRevision: 1 });
    expect(retained.status).toBe(200);
    expect(retained.body.qingzhouUsername).toBe("test-user");
    expect((await request(app).post(f.base + "/test").send({ ...f.sync, expectedRevision: 2 })).status).toBe(200);
    expect(await db.select().from(deliverySnapshots).where(eq(deliverySnapshots.companyId, f.companyId))).toHaveLength(0);
  });
  it("persists product scope, forwards it to monthly reads and preserves it when omitted",async()=>{
    const f=await seed();
    const app=f.app(undefined,undefined,async input=>{
      expect(input.subProductAttribution).toBe("DSP");
      return {month:input.month,collectedAt:new Date().toISOString(),items:[],executionAllowed:false as const};
    });
    expect((await request(app).put(f.base).send({...f.save,subProductAttribution:"DSP"})).body.subProductAttribution).toBe("DSP");
    expect((await request(app).post(f.base+"/monthly").send({projectId:f.projectId,expectedRevision:1,month:"2026-11"})).status).toBe(200);
    expect((await request(app).put(f.base).send({...f.save,expectedRevision:1})).body.subProductAttribution).toBe("DSP");
    expect((await request(app).put(f.base).send({...f.save,expectedRevision:2,subProductAttribution:null})).body.subProductAttribution).toBe(null);
  });
  it("tests without saving then deduplicates online snapshots and audits checks", async () => {
    const f = await seed(), app = f.app();await request(app).put(f.base).send(f.save);
    expect((await request(app).post(f.base + "/test").send(f.sync)).body.saved).toBe(false);
    const first = await request(app).post(f.base + "/sync").send(f.sync);expect(first.status).toBe(200);expect(first.body.plan.sourceMode).toBe("online_readonly");expect(first.body.plan.executionAllowed).toBe(false);
    expect((await request(app).post(f.base + "/sync").send(f.sync)).body.existing).toBe(true);
    expect(await db.select().from(deliverySnapshots).where(eq(deliverySnapshots.companyId, f.companyId))).toHaveLength(1);
    const logs = await db.select().from(activityLog).where(eq(activityLog.companyId, f.companyId));
    expect(logs.filter(l => l.action === "delivery.connection.checked")).toHaveLength(3);expect(JSON.stringify(logs)).not.toContain("test-password");
  });
  it("rejects independently rotated credentials while reading", async () => {
    const f = await seed(), app = f.app();await request(app).put(f.base).send(f.save);
    f.change(async () => { await db.update(companySecrets).set({ latestVersion: 2 }).where(eq(companySecrets.id, f.jiraSecretId)); });
    expect((await request(app).post(f.base + "/sync").send(f.sync)).status).toBe(409);
    expect(await db.select().from(deliverySnapshots).where(eq(deliverySnapshots.companyId, f.companyId))).toHaveLength(0);
  });
  it("records failures without snapshots and rejects changed source configuration", async () => {
    const f = await seed();await request(f.app()).put(f.base).send(f.save);
    const failure = f.app(undefined, async () => { throw new QingzhouReadError("incomplete_response"); });
    expect((await request(failure).post(f.base + "/sync").send(f.sync)).status).toBe(400);
    const [connection] = await db.select().from(deliveryConnections).where(eq(deliveryConnections.companyId, f.companyId));expect(connection!.lastCheckStatus).toBe("incomplete_response");
    f.change(async () => { await db.update(agents).set({ adapterConfig: { ...f.config, dsp7JiraDispatch: { ...f.config.dsp7JiraDispatch, revision: 2 } } }).where(eq(agents.id, f.agentId)); });
    expect((await request(f.app()).post(f.base + "/sync").send(f.sync)).status).toBe(409);
    expect(await db.select().from(deliverySnapshots).where(eq(deliverySnapshots.companyId, f.companyId))).toHaveLength(0);
  });
  it("reads monthly entries with saved project credentials and annotates managed versions",async()=>{
    const f=await seed(),app=f.app();await request(app).put(f.base).send(f.save);
    const monthly={projectId:f.projectId,expectedRevision:1,month:"2026-10"};
    const r=await request(app).post(f.base+"/monthly").send(monthly);expect(r.status).toBe(200);expect(r.body.items).toHaveLength(1);expect(r.body.executionAllowed).toBe(false);expect(JSON.stringify(r.body)).not.toMatch(/test-password|test-jira-pat|credentialSecretId/);
    expect(r.headers["server-timing"]).toContain("annotation;dur=");
    expect(r.headers["server-timing"]).toContain("total;dur=");
    await request(app).post(f.base+"/sync").send(f.sync);
    const managed=await request(app).post(f.base+"/monthly").send(monthly);expect(managed.body.items[0].snapshotId).toBeTruthy();expect(managed.body.items[0].admission.ready).toBe(false);
    expect((await request(app).post(f.base+"/monthly").send({...monthly,month:"2026-13"})).status).toBe(400);
    expect((await request(app).post(f.base+"/monthly").send({...monthly,expectedRevision:2})).status).toBe(409);
    expect((await request(f.app({type:"board",source:"session",companyIds:[]})).post(f.base+"/monthly").send(monthly)).status).toBe(403);
  });

  it("rejects a monthly read when credentials change during the source read", async () => {
    const f = await seed();
    let release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    const source = vi.fn(async (input: any) => {
      await held;
      return { month: input.month, collectedAt: new Date().toISOString(), items: [], executionAllowed: false as const };
    });
    const app = f.app(undefined, undefined, source);
    await request(app).put(f.base).send(f.save);
    const body = { projectId: f.projectId, expectedRevision: 1, month: "2026-10" };
    const first = request(app).post(f.base + "/monthly").send(body).then(r => r);
    await vi.waitFor(() => expect(source).toHaveBeenCalledTimes(1));
    const [connection] = await db.select().from(deliveryConnections).where(eq(deliveryConnections.projectId, f.projectId));
    await db.update(companySecrets).set({ latestVersion: 2 }).where(eq(companySecrets.id, connection!.credentialSecretId));
    release(); expect((await first).status).toBe(409);
    expect((await request(app).post(f.base + "/monthly").send(body)).status).toBe(200);
    expect(source).toHaveBeenCalledTimes(2);
  });

  it("batches month annotations with the same current decisions as individual reads", async () => {
    const f = await seed(), other = await seed();
    const plan = {...normalizeDeliverySnapshot({...fixture(), projectId:f.projectId}, "online_readonly"), differences:[]};
    const snapshots = await db.insert(deliverySnapshots).values(Array.from({length:24},(_,i)=>({
      companyId:f.companyId, projectId:f.projectId, sourceOrigin:"https://proj.fingard.com:1888",
      demandNo:`ATS3-${i}`, fingerprint:plan.fingerprint, collectedAt:new Date(), createdByUserId:"admin", plan:{...plan,demandNo:`ATS3-${i}`},
    }))).returning();
    // A historical snapshot and an unrelated company's record must not win.
    await db.insert(deliverySnapshots).values({...snapshots[0]!,id:randomUUID(),fingerprint:"historical",collectedAt:new Date(0)});
    await db.insert(activityLog).values({companyId:other.companyId,actorType:"user",actorId:"outsider",entityType:"delivery_snapshot",entityId:snapshots[0]!.id,action:"delivery.admission.checked",details:{fingerprint:plan.fingerprint,analysisReference:"https://example.com/analysis",designReference:"",designRequired:false,note:"Unrelated"}});
    const [issue] = await db.insert(issues).values({companyId:f.companyId,projectId:f.projectId,title:"Analysis"}).returning();
    await db.insert(analysisExecutions).values({id:issue!.id,companyId:f.companyId,projectId:f.projectId,seatId:f.agentId,ownerUserId:"admin",requestId:randomUUID(),createdBy:"admin",title:"Analysis",brief:"Fixture",demandNo:snapshots[0]!.demandNo,state:"published"});
    await db.insert(activityLog).values([
      {companyId:f.companyId,actorType:"user",actorId:"old",entityType:"delivery_snapshot",entityId:snapshots[0]!.id,action:"delivery.admission.checked",createdAt:new Date(0),details:{fingerprint:"outdated"}},
      {companyId:f.companyId,actorType:"user",actorId:"admin",entityType:"delivery_snapshot",entityId:snapshots[0]!.id,action:"delivery.admission.checked",details:{fingerprint:plan.fingerprint,analysisExecutionId:issue!.id,analysisRevision:1,analysisReference:"https://example.com/analysis",designReference:"",designRequired:false,note:"Checked"}},
    ]);
    const result: DeliveryMonthlyEntries = {month:"2026-10",collectedAt:new Date().toISOString(),executionAllowed:false,items:snapshots.map(s=>({demandNo:s.demandNo,title:s.plan.title,owner:"",sourceStatus:"",startDate:"",endDate:"",workCount:0,snapshotId:null,admission:null}))};
    const expected = new Map<string, unknown>();
    for (const snapshot of await latestDeliverySnapshots(db,f.companyId,f.projectId)) {
      const admission=await deliveryAdmission(db,snapshot);
      expected.set(snapshot.demandNo,{admission,chainAdmission:await deliveryChainAdmission(db,snapshot,{codingAdmission:admission})});
    }
    const select=vi.spyOn(db,"select"), distinct=vi.spyOn(db,"selectDistinctOn");
    try {
      await annotateMonthlyDelivery(db,f.companyId,f.projectId,result);
      // 24 entries use six SELECTs, rather than hundreds of repeated reads.
      expect(select.mock.calls.length+distinct.mock.calls.length).toBe(6);
    } finally {select.mockRestore();distinct.mockRestore();}
    for (const item of result.items) expect({admission:item.admission,chainAdmission:item.chainAdmission}).toEqual(expected.get(item.demandNo));
    expect(result.items[0]!.admission!.analysisExecutionId).toBe(issue!.id);
    expect(result.items[0]!.admission).toMatchObject({ready:true,evidence:{checkedBy:"admin"}});
    await db.update(analysisExecutions).set({state:"draft"}).where(eq(analysisExecutions.id,issue!.id));
    await annotateMonthlyDelivery(db,f.companyId,f.projectId,result);
    expect(result.items[0]!.admission!.reasons).toContain("最新平台分析修订尚未正式发布，请先完成或处理该修订");
  });

  it("loads organizations before initial save and reuses encrypted project credentials without exposing them",async()=>{
    const f=await seed(),app=f.app();
    const initial={projectId:f.projectId,expectedRevision:0,credentials:f.save.credentials};
    const first=await request(app).post(f.base+"/organizations").send(initial);expect(first.status).toBe(200);expect(first.body.items[0]).toMatchObject({id:"123",name:"研发七组"});expect(JSON.stringify(first.body)).not.toMatch(/test-password|test-user/);
    expect((await request(app).post(f.base+"/organizations").send({projectId:f.projectId,expectedRevision:0})).status).toBe(400);
    await request(app).put(f.base).send(f.save);
    expect((await request(app).post(f.base+"/organizations").send({projectId:f.projectId,expectedRevision:1})).status).toBe(200);
    expect((await request(app).post(f.base+"/organizations").send({...initial,credentials:{username:"test-user"}})).status).toBe(400);
    expect((await request(app).post(f.base+"/organizations").send(initial)).status).toBe(409);
    expect((await request(f.app({type:"board",source:"session",companyIds:[]})).post(f.base+"/organizations").send(initial)).status).toBe(403);
  });

  it("saves a project-owned Jira connection and reads without any executor", async () => {
    const f=await seed(), app=f.app();
    await db.delete(agents).where(eq(agents.id,f.agentId));
    const {jiraAgentId:_seat,...input}=f.save;
    const saved=await request(app).put(f.base).send({...input,jira:{baseUrl:"http://jira.fingard.com:6001",token:"test-jira-pat"}});
    expect(saved.status).toBe(200);expect(saved.body).toMatchObject({jiraAgentId:null,jiraConnectionMode:"project",jiraCredentialsConfigured:true,jiraBaseUrl:"http://jira.fingard.com:6001"});
    expect(JSON.stringify(saved.body)).not.toMatch(/test-jira-pat|test-password|jiraSecretId/);
    expect((await request(app).post(f.base+"/sync").send(f.sync)).status).toBe(200);
    const {credentials:_credentials,...retained}=input;
    expect((await request(app).put(f.base).send({...retained,expectedRevision:1,jira:{baseUrl:"http://jira.fingard.com:6001"}})).status).toBe(200);
    expect((await request(app).post(f.base+"/test").send({...f.sync,expectedRevision:2})).status).toBe(200);
  });
  it("copies legacy credentials on save and detaches the source from seat changes and deletion", async () => {
    const f=await seed(),app=f.app();await request(app).put(f.base).send(f.save);
    const before=await request(app).get(f.base+"?projectId="+f.projectId);expect(before.body.jiraConnectionMode).toBe("legacy_seat");
    const saved=await request(app).put(f.base).send({projectId:f.projectId,expectedRevision:1,organizationId:"123",jira:{baseUrl:"http://jira.fingard.com:6001"}});
    expect(saved.status).toBe(200);expect(saved.body.jiraAgentId).toBeNull();expect(saved.body.jiraConnectionMode).toBe("project");
    const [connection]=await db.select().from(deliveryConnections).where(eq(deliveryConnections.projectId,f.projectId));
    expect(connection!.jiraSecretId).not.toBe(f.jiraSecretId);
    await db.update(companySecrets).set({latestVersion:2}).where(eq(companySecrets.id,f.jiraSecretId));
    await db.delete(agents).where(eq(agents.id,f.agentId));
    expect((await request(app).post(f.base+"/test").send({...f.sync,expectedRevision:2})).status).toBe(200);
  });
  it("rejects missing Jira PAT, conflicting source modes and unapproved URLs without storing secrets",async()=>{
    const f=await seed(),app=f.app();const {jiraAgentId:_seat,...input}=f.save;
    expect((await request(app).put(f.base).send({...input,jira:{baseUrl:"http://jira.fingard.com:6001"}})).status).toBe(400);
    expect((await request(app).put(f.base).send({...f.save,jira:{baseUrl:"http://jira.fingard.com:6001",token:"test-jira-pat"}})).status).toBe(400);
    for(const baseUrl of ["http://127.0.0.1:3100","http://user:password@jira.fingard.com:6001","http://jira.fingard.com:6001/api"])
      expect((await request(app).put(f.base).send({...input,jira:{baseUrl,token:"test-jira-pat"}})).status).toBe(400);
    expect(await db.select().from(deliveryConnections).where(eq(deliveryConnections.projectId,f.projectId))).toHaveLength(0);
  });
  it("rejects project PAT rotation during source read",async()=>{
    const f=await seed(),app=f.app();const {jiraAgentId:_seat,...input}=f.save;
    await request(app).put(f.base).send({...input,jira:{baseUrl:"http://jira.fingard.com:6001",token:"test-jira-pat"}});
    const [connection]=await db.select().from(deliveryConnections).where(eq(deliveryConnections.projectId,f.projectId));
    f.change(async()=>{await db.update(companySecrets).set({latestVersion:2}).where(eq(companySecrets.id,connection!.jiraSecretId!));});
    expect((await request(app).post(f.base+"/sync").send(f.sync)).status).toBe(409);
    expect(await db.select().from(deliverySnapshots).where(eq(deliverySnapshots.companyId,f.companyId))).toHaveLength(0);
  });

  it("does not mistake secret usage timestamps for credential rotation on repeated reads",async()=>{
    const f=await seed(),app=f.app();const {jiraAgentId:_seat,...input}=f.save;
    await request(app).put(f.base).send({...input,jira:{baseUrl:"http://jira.fingard.com:6001",token:"test-jira-pat"}});
    for(let attempt=0;attempt<2;attempt++){
      expect((await request(app).post(f.base+"/organizations").send({projectId:f.projectId,expectedRevision:1})).status).toBe(200);
      expect((await request(app).post(f.base+"/monthly").send({projectId:f.projectId,expectedRevision:1,month:"2026-10"})).status).toBe(200);
      expect((await request(app).post(f.base+"/test").send(f.sync)).status).toBe(200);
    }
    expect((await request(app).post(f.base+"/sync").send(f.sync)).status).toBe(200);
    const [row]=await db.select().from(deliveryConnections).where(eq(deliveryConnections.projectId,f.projectId));
    const [secret]=await db.select().from(companySecrets).where(eq(companySecrets.id,row!.credentialSecretId));
    expect(secret!.lastResolvedAt).not.toBeNull();expect(secret!.latestVersion).toBe(1);
    const saved=await request(app).put(f.base).send({projectId:f.projectId,expectedRevision:1,organizationId:"456",jira:{baseUrl:"http://jira.fingard.com:6001"}});
    expect(saved.status).toBe(200);expect(saved.body.organizationId).toBe("456");
  });
  it("still rejects a revoked credential during source reading",async()=>{
    const f=await seed(),app=f.app();await request(app).put(f.base).send(f.save);
    const [connection]=await db.select().from(deliveryConnections).where(eq(deliveryConnections.projectId,f.projectId));
    f.change(async()=>{await db.update(companySecrets).set({status:"disabled"}).where(eq(companySecrets.id,connection!.credentialSecretId));});
    expect((await request(app).post(f.base+"/sync").send(f.sync)).status).toBe(409);
    expect(await db.select().from(deliverySnapshots).where(eq(deliverySnapshots.companyId,f.companyId))).toHaveLength(0);
  });

  it("preserves actionable snapshot validation errors instead of blaming credentials",async()=>{
    const f=await seed();await request(f.app()).put(f.base).send(f.save);
    const app=f.app(undefined,async()=>{throw badRequest("排期主工单缺少子工单数组");});
    const result=await request(app).post(f.base+"/test").send(f.sync);
    expect(result.status).toBe(400);expect(result.body.error).toBe("排期主工单缺少子工单数组");
    const [row]=await db.select().from(deliveryConnections).where(eq(deliveryConnections.projectId,f.projectId));expect(row!.lastCheckStatus).toBe("invalid_response");
    const unknown=f.app(undefined,async()=>{throw Error("internal detail fixture-pat");});
    const hidden=await request(unknown).post(f.base+"/test").send(f.sync);expect(hidden.body.error).not.toMatch(/凭据未就绪|fixture-pat|internal detail/);
  });

});
