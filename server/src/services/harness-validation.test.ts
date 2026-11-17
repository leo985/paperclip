import { issueService } from "./issues.js";
import { nativeWakeCheckoutStatuses } from "./harness-validation-readiness.js";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { budgetService } from "./budgets.js";
import { costService } from "./costs.js";
import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { and, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { activityLog, agents, budgetPolicies, companies, costEvents, createDb, heartbeatRuns, issues, seatExecutionPermits } from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "../__tests__/helpers/embedded-postgres.js";
import { harnessValidationService } from "./harness-validation.js";
import { seatPermitService } from "./seat-execution-permits.js";
import { managedSessionRoutes } from "../routes/managed-sessions.js";
import { harnessValidationRoutes } from "../routes/harness-validation.js";

const support = await getEmbeddedPostgresTestSupport();
(support.supported ? describe : describe.skip)("isolated validation authorization and native permit", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>, db: ReturnType<typeof createDb>;
  beforeAll(async () => { database = await startEmbeddedPostgresTestDatabase("harness-validation-"); db = createDb(database.connectionString); });
  afterAll(async () => { await database?.cleanup(); });
  afterEach(() => vi.unstubAllEnvs());
  const protocols = { kind: "validation" as const, observerProtocol: 1 as const, supervisionProtocol: 2 as const, validationProtocol: 1 as const };
  async function fixture() {
    const companyId = randomUUID(), seatId = randomUUID(), taskId = randomUUID(), runId = randomUUID(), machineId = randomUUID(), dispatchId = randomUUID();
    const bundle = { protocolVersion: 1, bundleDigest: "a".repeat(64), project: "history-pilot", mode: "candidate",
      packages: [{ id: "runtime", layer: "L3", version: "1.0.0", manifestDigest: "b".repeat(64), skills: [] },
        { id: "methods", layer: "L4", version: "1.0.0", manifestDigest: "c".repeat(64), skills: ["harness-v2-history-pilot"] }] };
    const adapterConfig = { dsp7Transport: "outbound", dsp7WebJiraIntake: true, dsp7Seat: { machineId, machineFingerprint: "f".repeat(64), ownerUserId: "owner" },
      dsp7HarnessBundles: { version: 1, revision: 2, items: [{ ...bundle, checkedAt: new Date().toISOString(),
        validation: "seat-reported-local-files", executionReady: false, loadState: "unconfirmed" }] } };
    await db.insert(companies).values({ id: companyId, name: "Isolated validation", issuePrefix: `V${companyId.slice(0, 6)}` });
    await db.insert(agents).values({ id: seatId, companyId, name: "Seat", role: "engineer", status: "idle", adapterType: "claude_local", adapterConfig });
    await db.insert(issues).values({ id: taskId, companyId, assigneeAgentId: seatId, title: "Synthetic only", status: "in_progress" });
    await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId: seatId, nativeIssueId: taskId, status: "running",
      contextSnapshot: { issueId: taskId, harnessValidationDispatchId: dispatchId } });
    vi.stubEnv("PAPERCLIP_DEPLOYMENT_MODE", "local_trusted");
    for (const flag of ["DSP7_HARNESS_VALIDATION_ENABLED", "DSP7_HARNESS_OBSERVER_BINDINGS_ENABLED", "DSP7_HARNESS_OBSERVATION_ENABLED", "DSP7_HARNESS_BUNDLES_ENABLED"]) vi.stubEnv(flag, "true");
    const selection = { companyId, seatId, taskId, projectId: null, bundleDigest: bundle.bundleDigest };
    vi.stubEnv("DSP7_HARNESS_VALIDATION_TASKS", JSON.stringify([selection]));
    vi.stubEnv("DSP7_HARNESS_OBSERVER_BINDINGS", JSON.stringify([selection]));
    vi.stubEnv("DSP7_HARNESS_V2_SEATS", JSON.stringify([{ companyId, seatId }]));
    const scope = { companyId, seatId, taskId }, identity = { companyId, agentId: seatId, taskId, runId, machineId, lease: randomUUID() };
    const grant = () => harnessValidationService(db).authorize(scope, dispatchId, bundle.bundleDigest, "local-board");
    return { ...scope, scope, identity, runId, dispatchId, bundle, adapterConfig, selection, grant };
  }
  async function permits(runId: string) { return db.select().from(seatExecutionPermits).where(eq(seatExecutionPermits.runId, runId)); }

  it.each([true, false])("collection requires real validation authorization: %s", async authorized => {
    const f=await fixture();
    if(authorized) { await f.grant(); await seatPermitService(db).issue(f.identity, protocols); }
    const a=express();a.use(express.json());
    a.use((req,_res,next)=>{req.actor={type:"agent",source:"agent_key",agentId:f.seatId,companyId:f.companyId} as Express.Request["actor"];next();});
    a.use("/api",managedSessionRoutes(db));
    a.use((error:any,_req:express.Request,res:express.Response,_next:express.NextFunction)=>res.status(error.status??500).json({error:error.message}));
    const result=await request(a).post(`/api/agents/${f.seatId}/managed-sessions`).send({protocolVersion:1,
      seat_id:f.seatId,machine_id:f.identity.machineId,machine_fingerprint:"f".repeat(64),
      runId:f.runId,nativeSessionId:f.runId,taskId:f.taskId});
    expect(result.status).toBe(authorized?200:409);
    if(authorized)expect(result.body.sessionId).toBeTruthy();
  });
  it("dispatches once through native wakeup with immutable scope and no issue-provided commands", async () => {
    const f = await fixture(); await f.grant();
    const wakeup = vi.fn().mockResolvedValue({ id: f.runId });
    const result = await harnessValidationService(db).dispatch(f.scope, f.dispatchId, "local-board", wakeup);
    expect(result).toEqual({ runId: f.runId, dispatched: true, executionStarted: false });
    expect(wakeup).toHaveBeenCalledWith(f.seatId, expect.objectContaining({
      allowRunCoalescing: false, reason: "Harness 隔离验证授权启动；" + f.dispatchId,
      contextSnapshot: { issueId: f.taskId, taskId: f.taskId, harnessValidationDispatchId: f.dispatchId, forceFreshSession: true },
      issueStateGuard: { statuses: ["backlog", "todo", "in_progress"], assigneeAgentId: f.seatId },
    }));
    await expect(harnessValidationService(db).dispatch(f.scope,f.dispatchId,"local-board",wakeup)).rejects.toThrow("不自动重放");
    expect(wakeup).toHaveBeenCalledTimes(1);
    expect(await permits(f.runId)).toHaveLength(0);
  });
  it("starts an explicitly authorized backlog task without a generic status-change wake", async () => {
    const f = await fixture();
    await db.update(issues).set({ status: "backlog" }).where(eq(issues.id, f.taskId));
    await f.grant();
    const wakeup = vi.fn().mockResolvedValue({ id: f.runId });
    await expect(harnessValidationService(db).dispatch(f.scope, f.dispatchId, "local-board", wakeup))
      .resolves.toMatchObject({ runId: f.runId, dispatched: true });
    expect(wakeup).toHaveBeenCalledWith(f.seatId, expect.objectContaining({
      issueStateGuard: { statuses: ["backlog", "todo", "in_progress"], assigneeAgentId: f.seatId },
    }));
    const [task] = await db.select().from(issues).where(eq(issues.id, f.taskId));
    expect(task.status).toBe("backlog"); // Native heartbeat owns checkout, not the grant service.
  });
  it.each(["blocked", "in_review", "done", "cancelled"])("does not resume %s through validation dispatch", async status => {
    const f = await fixture(); await f.grant();
    await db.update(issues).set({ status }).where(eq(issues.id, f.taskId));
    const wakeup = vi.fn();
    await expect(harnessValidationService(db).dispatch(f.scope, f.dispatchId, "local-board", wakeup)).rejects.toThrow();
    expect(wakeup).not.toHaveBeenCalled();
    expect(await db.select().from(activityLog).where(and(eq(activityLog.entityId, f.dispatchId),
      eq(activityLog.action, "harness.validation.dispatch-requested")))).toHaveLength(0);
  });
  it("does not overwrite a block that lands after the ready snapshot", async () => {
    const f = await fixture(); await f.grant();
    await db.update(issues).set({ status: "backlog" }).where(eq(issues.id, f.taskId));
    const [snapshot] = await db.select().from(issues).where(eq(issues.id, f.taskId));
    expect(snapshot.status).toBe("backlog");
    await db.update(issues).set({ status: "blocked" }).where(eq(issues.id, f.taskId));
    await expect(issueService(db).checkout(f.taskId, f.seatId,
      nativeWakeCheckoutStatuses({ harnessValidationDispatchId: f.dispatchId }), f.runId)).rejects.toThrow();
    const [task] = await db.select().from(issues).where(eq(issues.id, f.taskId));
    expect(task.status).toBe("blocked");
    expect(task.checkoutRunId).toBeNull();
    await expect(seatPermitService(db).issue(f.identity, protocols)).rejects.toThrow();
    expect(await permits(f.runId)).toHaveLength(0);
  });
  it.each(["blocked", "in_review"])("rejects a validation claim or renewal after status becomes %s", async status => {
    const f = await fixture(); await f.grant();
    const service = seatPermitService(db); await service.issue(f.identity, protocols);
    await db.update(issues).set({ status }).where(eq(issues.id, f.taskId));
    expect((await service.renew(f.identity)).alive).toBe(false);
    const other = await fixture(); await other.grant();
    await db.update(issues).set({ status }).where(eq(issues.id, other.taskId));
    await expect(service.issue(other.identity, protocols)).rejects.toThrow();
    expect(await permits(other.runId)).toHaveLength(0);
  });
  it("serializes concurrent duplicate dispatch reservations in real PostgreSQL", async () => {
    const f=await fixture();await f.grant();
    const wakeup=vi.fn().mockResolvedValue({id:f.runId});
    const results=await Promise.allSettled(Array.from({length:4},()=>
      harnessValidationService(db).dispatch(f.scope,f.dispatchId,"local-board",wakeup)));
    expect(results.filter(r=>r.status==="fulfilled")).toHaveLength(1);
    expect(wakeup).toHaveBeenCalledTimes(1);
    expect(await db.select().from(activityLog).where(and(eq(activityLog.entityId,f.dispatchId),
      eq(activityLog.action,"harness.validation.dispatch-requested")))).toHaveLength(1);
    expect(await permits(f.runId)).toHaveLength(0);
  });
  it("issues exactly one validation permit under simultaneous claims", async () => {
    const f=await fixture();await f.grant();const service=seatPermitService(db);
    const results=await Promise.allSettled(Array.from({length:4},()=>service.issue(f.identity,protocols)));
    expect(results.filter(r=>r.status==="fulfilled")).toHaveLength(1);
    expect(await permits(f.runId)).toHaveLength(1);
  });
  it("retains a dispatch reservation after an uncertain native wakeup and never retries it", async () => {
    const f = await fixture(); await f.grant();
    const wakeup=vi.fn().mockRejectedValue(new Error("transport interrupted"));
    await expect(harnessValidationService(db).dispatch(f.scope,f.dispatchId,"local-board",wakeup)).rejects.toThrow("transport interrupted");
    await expect(harnessValidationService(db).dispatch(f.scope,f.dispatchId,"local-board",wakeup)).rejects.toThrow("不自动重放");
    expect(wakeup).toHaveBeenCalledTimes(1);
  });
  it("rejects revoked authorization and changed bundle before requesting native dispatch", async () => {
    const f=await fixture();await f.grant();const wakeup=vi.fn();
    await harnessValidationService(db).revoke(f.scope,f.dispatchId,"local-board");
    await expect(harnessValidationService(db).dispatch(f.scope,f.dispatchId,"local-board",wakeup)).rejects.toThrow("授权缺失");
    expect(wakeup).not.toHaveBeenCalled();
  });
  it("accepts the original outbound heartbeat task link when nativeIssueId is null", async () => {
    const f=await fixture();await f.grant();
    await db.update(heartbeatRuns).set({nativeIssueId:null}).where(eq(heartbeatRuns.id,f.runId));
    const permit=await seatPermitService(db).issue(f.identity,protocols);
    expect(permit.harnessValidation).toMatchObject({runId:f.runId,taskId:f.taskId});
  });
  it("rejects an explicit native task link conflicting with the original snapshot", async () => {
    const f=await fixture();await f.grant();
    const other=randomUUID();await db.insert(issues).values({id:other,companyId:f.companyId,title:"Other synthetic task",status:"todo"});
    await db.update(heartbeatRuns).set({nativeIssueId:other}).where(eq(heartbeatRuns.id,f.runId));
    await expect(seatPermitService(db).issue(f.identity,protocols)).rejects.toThrow();
    expect(await permits(f.runId)).toHaveLength(0);
  });
  it("freezes the authorization in the original permit, renews it and refuses a second claim", async () => {
    const f = await fixture(), service = seatPermitService(db);
    const grant = await f.grant();
    expect(await f.grant()).toEqual(grant);
    const permit = await service.issue(f.identity, protocols);
    expect(permit.executionRoute).toBeNull();
    expect(permit.treeProofRequired).toBe(true);
    expect(permit.harnessValidation).toMatchObject({ runId: f.runId, taskId: f.taskId, dispatchId: f.dispatchId,
      purpose: "synthetic-history", fixtureVersion: 1, bundle: f.bundle });
    const renewed = await service.renew(f.identity);
    expect(renewed.alive && renewed.permit.harnessValidation).toEqual(permit.harnessValidation);
    await expect(service.issue(f.identity, protocols)).rejects.toThrow("已经签发");
    expect(await permits(f.runId)).toHaveLength(1);
    expect((await permits(f.runId))[0].ledgerScope?.harnessValidation).toEqual(permit.harnessValidation);
    expect(await db.select().from(activityLog).where(and(eq(activityLog.entityId, f.dispatchId), eq(activityLog.action, "harness.validation.authorized")))).toHaveLength(1);
  });
  it("cannot acquire a permit from discovery alone or by borrowing development", async () => {
    const f = await fixture(), service = seatPermitService(db);
    await expect(service.issue(f.identity, protocols)).rejects.toThrow("授权缺失");
    await f.grant();
    await expect(service.issue(f.identity, { kind: "development", observerProtocol: 1 })).rejects.toThrow("不得借用");
    for (const options of [{ ...protocols, validationProtocol: undefined }, { ...protocols, supervisionProtocol: 1 as const }, { ...protocols, observerProtocol: undefined }]) {
      await expect(service.issue(f.identity, options)).rejects.toThrow("独立协商");
    }
    expect(await permits(f.runId)).toHaveLength(0);
  });
  it("does not extend the native permit beyond its validation authorization", async () => {
    const f = await fixture(), clock = Date.now() - 15 * 60_000 + 10_000;
    const grant = await harnessValidationService(db, () => clock).authorize(f.scope, f.dispatchId, f.bundle.bundleDigest, "local-board");
    const service = seatPermitService(db), issued = await service.issue(f.identity, protocols);
    expect(issued.expiresAt).toBe(grant.expiresAt);
    expect(issued.validForMs).toBeLessThanOrEqual(10_000);
    const renewed = await service.renew(f.identity);
    expect(renewed.alive && renewed.permit.expiresAt).toBe(grant.expiresAt);
  });
  it("stops a real isolated Bridge process tree after synthetic billed spend crosses the original budget", async () => {
    // Disposable PostgreSQL only. No production billing, fake prices or native dispatch claim.
    const other=await fixture(), f=await fixture(); await f.grant();
    const service=seatPermitService(db), initial=await service.issue(f.identity,protocols);
    const budgets=budgetService(db), costs=costService(db);
    const unknown={agentId:f.seatId,heartbeatRunId:f.runId,issueId:f.taskId,provider:"synthetic-test",
      model:"unpriced-fixture",billingType:"unknown",costStatus:"unpriced",costCents:0,inputTokens:1000000,
      occurredAt:new Date(),idempotencyKey:"unpriced-fixture"};
    await costs.createEvent(f.companyId,unknown);
    expect((await service.renew(f.identity)).alive).toBe(true);
    const script=`import sys,json,subprocess,time,signal
def terminate(*args): raise KeyboardInterrupt
signal.signal(signal.SIGTERM,terminate)
sys.path.insert(0,sys.argv[1])
from process_tree import ProcessTree
from execution_permit import ExecutionPermit
child=subprocess.Popen([sys.executable,'-c','import time;time.sleep(60)'],start_new_session=True)
tree=ProcessTree(sys.argv[2]);tree.attach(child)
guard=ExecutionPermit(terminate=tree.stop)
try:
 guard.renew(json.loads(sys.stdin.readline()),time.monotonic());guard.attach(child);guard.start()
 print(json.dumps({'ready':True,'members':len(tree.members())}),flush=True)
 response=json.loads(sys.stdin.readline())
 if response.get('alive'): raise RuntimeError('expected original server denial')
 tree.stop();child.wait(timeout=5)
 print(json.dumps({'proof':tree.proof(),'exitCode':child.returncode}),flush=True)
finally:
 tree.stop();guard.close()
`;
    const child=spawn(process.env.HARNESS_TEST_PYTHON??"python3",["-c",script,
      fileURLToPath(new URL("../../../integrations/dsp7-bridge",import.meta.url)),f.runId],{stdio:["pipe","pipe","pipe"]});
    const closed=once(child,"close"); const lines=createInterface({input:child.stdout})[Symbol.asyncIterator]();
    let stderr="";child.stderr.on("data",chunk=>{stderr+=chunk.toString();});
    try {
      child.stdin.write(JSON.stringify(initial)+"\n");
      const ready=JSON.parse((await lines.next()).value!);expect(ready.ready).toBe(true);expect(ready.members).toBeGreaterThan(0);
      const billed={...unknown,model:"synthetic-billed-fixture",billingType:"metered_api",costStatus:"reported",
        costCents:2,inputTokens:0,idempotencyKey:"synthetic-billed-fixture"};
    await budgets.upsertPolicy(f.companyId,{scopeType:"agent",scopeId:f.seatId,metric:"billed_cents",
      windowKind:"lifetime",amount:1,warnPercent:80,hardStopEnabled:true,notifyEnabled:false,isActive:true},"isolated-test");
      await costs.createEvent(f.companyId,billed);await costs.createEvent(f.companyId,billed);
      const [seat]=await db.select().from(agents).where(eq(agents.id,f.seatId));
      expect(seat).toMatchObject({status:"paused",pauseReason:"budget",spentMonthlyCents:2});
      expect((await db.select().from(agents).where(eq(agents.id,other.seatId)))[0].status).toBe("idle");
      const denied=await service.renew(f.identity);expect(denied).toMatchObject({alive:false,reason:"scope_paused"});
      const [before]=await permits(f.runId);expect(before.treeStopVerifiedAt).toBeNull();expect(before.processExitObservedAt).toBeNull();
      child.stdin.write(JSON.stringify(denied)+"\n");
      const stopped=JSON.parse((await lines.next()).value!);
      expect(stopped.exitCode).not.toBe(0);
      expect((await service.observeExit(f.identity,stopped.proof)).executionStopVerified).toBe(true);
      expect((await closed)[0],stderr).toBe(0);
      expect(await db.select().from(costEvents).where(eq(costEvents.heartbeatRunId,f.runId))).toHaveLength(2);
      expect((await permits(f.runId))[0]).toMatchObject({stopReason:"scope_paused"});
      await expect(service.issue({...f.identity,lease:randomUUID()},protocols)).rejects.toThrow();
    } finally {child.stdin.end();if(child.exitCode===null){child.kill("SIGTERM");await closed;} }
  },15000);
  it.each(["revocation", "expiry", "owner", "bundle", "project", "seat", "disabled", "manager", "budget", "cancelled"])("revokes the native permit when %s changes", async change => {
    const f = await fixture(); await f.grant();
    const service = seatPermitService(db); await service.issue(f.identity, protocols);
    if (change === "revocation") await harnessValidationService(db).revoke(f.scope, f.dispatchId, "local-board");
    if (change === "expiry") {
      const [row] = await db.select().from(activityLog).where(and(eq(activityLog.entityId, f.dispatchId), eq(activityLog.action, "harness.validation.authorized")));
      await db.update(activityLog).set({ details: { ...row.details, expiresAt: new Date(Date.now() - 1).toISOString() } }).where(eq(activityLog.id, row.id));
    }
    if (change === "owner") await db.update(agents).set({ adapterConfig: { ...f.adapterConfig, dsp7Seat: { ...f.adapterConfig.dsp7Seat, ownerUserId: "new-owner" } } }).where(eq(agents.id, f.seatId));
    if (change === "bundle") vi.stubEnv("DSP7_HARNESS_VALIDATION_TASKS", JSON.stringify([{ ...f.selection, bundleDigest: "d".repeat(64) }]));
    if (change === "project") vi.stubEnv("DSP7_HARNESS_VALIDATION_TASKS", JSON.stringify([{ ...f.selection, projectId: randomUUID() }]));
    if (change === "seat") vi.stubEnv("DSP7_HARNESS_VALIDATION_TASKS", JSON.stringify([{ ...f.selection, seatId: randomUUID() }]));
    if (change === "disabled") vi.stubEnv("DSP7_HARNESS_VALIDATION_ENABLED", "false");
    if (change === "manager") vi.stubEnv("PAPERCLIP_DEPLOYMENT_MODE", "authenticated");
    if (change === "budget") await db.insert(budgetPolicies).values({ companyId: f.companyId, scopeType: "company", scopeId: f.companyId, metric: "billed_cents", windowKind: "calendar_month", amount: 100 });
    if (change === "cancelled") await db.update(issues).set({ status: "cancelled" }).where(eq(issues.id, f.taskId));
    expect((await service.renew(f.identity)).alive).toBe(false);
    const [stored] = await permits(f.runId); expect(stored.revokedAt).toBeInstanceOf(Date);
    expect(stored.ledgerScope?.harnessValidation?.dispatchId).toBe(f.dispatchId);
  });
  it("binds each dispatch to one run and rejects a cross-run replay", async () => {
    const f = await fixture(); await f.grant(); await seatPermitService(db).issue(f.identity, protocols);
    const runId = randomUUID();
    await db.insert(heartbeatRuns).values({ id: runId, companyId: f.companyId, agentId: f.seatId, status: "running", nativeIssueId: f.taskId,
      contextSnapshot: { issueId: f.taskId, harnessValidationDispatchId: f.dispatchId } });
    await expect(seatPermitService(db).issue({ ...f.identity, runId, lease: randomUUID() }, protocols)).rejects.toThrow("其他运行");
    expect(await permits(runId)).toHaveLength(0);
  });
  it("rejects invalid scope and unknown authority fields before creating an authorization", async () => {
    const f = await fixture();
    for (const selection of [{ ...f.selection, companyId: randomUUID() }, { ...f.selection, taskId: randomUUID() },
      { ...f.selection, script: "/tmp/anything.py" }]) {
      vi.stubEnv("DSP7_HARNESS_VALIDATION_TASKS", JSON.stringify([selection]));
      await expect(f.grant()).rejects.toThrow();
    }
    vi.stubEnv("DSP7_HARNESS_VALIDATION_TASKS", JSON.stringify([f.selection, f.selection]));
    await expect(f.grant()).rejects.toThrow("范围配置无效");
  });
  it("exposes manager-only preparation and revocation without starting a run", async () => {
    const f = await fixture();
    let actor: any = { type: "board", source: "local_implicit" };
    const app = express(); app.use(express.json());
    app.use((req, _res, next) => { req.actor = actor; next(); });
    app.use(harnessValidationRoutes(db));
    app.use((err: any, _req: any, res: any, _next: any) => res.status(err.status ?? 500).json({ error: err.message }));
    const endpoint = `/companies/${f.companyId}/dsp7-seats/${f.seatId}/harness-validation/${f.taskId}`;
    const body = { dispatchId: f.dispatchId, expectedBundleDigest: f.bundle.bundleDigest };
    await request(app).post(endpoint).send({ ...body, script: "/tmp/a.py" }).expect(400);
    const response = await request(app).post(endpoint).send(body).expect(200);
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.body).toMatchObject({ dispatched: false, executionStarted: false });
    expect(await permits(f.runId)).toHaveLength(0);
    await request(app).delete(endpoint + "/" + f.dispatchId).expect(200);
    await request(app).post(endpoint).send(body).expect(409);
    actor = { type: "agent", source: "agent_key", companyId: f.companyId, agentId: f.seatId };
    await request(app).post(endpoint).send(body).expect(403);
    actor = { type: "board", source: "session", userId: "owner", companyIds: [f.companyId], memberships: [{ companyId: f.companyId, status: "active", membershipRole: "member" }] };
    await request(app).post(endpoint).send(body).expect(403);
    actor = { type: "board", source: "session", userId: "admin", companyIds: [] };
    await request(app).post(endpoint).send(body).expect(403);
  });
});
