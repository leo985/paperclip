import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { agents, budgetPolicies, companies, costEvents, createDb, heartbeatRuns, issues, seatExecutionPermits } from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "../__tests__/helpers/embedded-postgres.js";
import { seatPermitService } from "./seat-execution-permits.js";
import { seatOccupancy } from "./seat-concurrency.js";
const support = await getEmbeddedPostgresTestSupport();
(support.supported ? describe : describe.skip)("native seat execution permit lifecycle", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>, db: ReturnType<typeof createDb>;
  beforeAll(async () => { database = await startEmbeddedPostgresTestDatabase("seat-permits-"); db = createDb(database.connectionString); });
  afterAll(async () => { await database?.cleanup(); });
  afterEach(() => vi.unstubAllEnvs());
  async function seed() {
    const companyId = randomUUID(), agentId = randomUUID(), runId = randomUUID(), machineId = randomUUID(), taskId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Permits", issuePrefix: `P${companyId.slice(0, 6)}` });
    await db.insert(agents).values({ id: agentId, companyId, name: "Seat", role: "engineer", status: "idle", adapterType: "claude_local", adapterConfig: { dsp7Transport: "outbound", dsp7Seat: { machineId } } });
    await db.insert(issues).values({ id: taskId, companyId, assigneeAgentId: agentId, title: "test", status: "in_progress" });
    await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId, status: "running", contextSnapshot: { issueId: taskId } });
    return { companyId, agentId, runId, machineId, lease: randomUUID(), taskId };
  }
  async function observerFixture() {
    const f = await seed();
    const bundle = { protocolVersion: 1, bundleDigest: "a".repeat(64), project: "history-pilot", mode: "candidate",
      packages: [
        { id: "runtime", version: "1.0.0", layer: "L3", manifestDigest: "b".repeat(64), skills: [] },
        { id: "methods", version: "1.0.0", layer: "L4", manifestDigest: "c".repeat(64), skills: ["history-pilot"] },
      ] };
    const registry = { version: 1, revision: 1, items: [{ ...bundle, checkedAt: new Date().toISOString(),
      validation: "seat-reported-local-files", executionReady: false, loadState: "unconfirmed" }] };
    const [seat] = await db.select().from(agents).where(eq(agents.id, f.agentId));
    const adapterConfig = { ...seat.adapterConfig, dsp7HarnessBundles: registry };
    await db.update(agents).set({ adapterConfig }).where(eq(agents.id, f.agentId));
    vi.stubEnv("DSP7_HARNESS_OBSERVER_BINDINGS_ENABLED", "true");
    vi.stubEnv("DSP7_HARNESS_OBSERVATION_ENABLED", "true");
    vi.stubEnv("DSP7_HARNESS_BUNDLES_ENABLED", "true");
    vi.stubEnv("DSP7_HARNESS_V2_SEATS", JSON.stringify([{ companyId: f.companyId, seatId: f.agentId }]));
    const selection = { companyId: f.companyId, seatId: f.agentId, taskId: f.taskId, projectId: null, bundleDigest: bundle.bundleDigest };
    vi.stubEnv("DSP7_HARNESS_OBSERVER_BINDINGS", JSON.stringify([selection]));
    return { f, registry, adapterConfig, selection };
  }
  it("requires negotiation, freezes the observer in the original permit and returns it unchanged on renewal", async () => {
    const { f } = await observerFixture(), service = seatPermitService(db);
    await expect(service.issue(f)).rejects.toThrow("观察绑定");
    await expect(service.issue(f, { kind: "development", observerProtocol: 1, supervisionProtocol: 1 })).rejects.toThrow("观察绑定");
    expect(await db.select().from(seatExecutionPermits).where(eq(seatExecutionPermits.runId, f.runId))).toHaveLength(0);
    const issued = await service.issue(f, { kind: "development", observerProtocol: 1 });
    expect(issued.executionRoute).toBeNull();
    expect(issued.harnessObserver).toMatchObject({ schema: "harness.observer-binding/1", companyId: f.companyId,
      seatId: f.agentId, taskId: f.taskId, runId: f.runId, machineId: f.machineId,
      executionReady: false, loadState: "unconfirmed", purpose: "observation-only", registryRevision: 1 });
    const renewed = await service.renew(f);
    expect(renewed.alive && renewed.permit.harnessObserver).toEqual(issued.harnessObserver);
    const [stored] = await db.select().from(seatExecutionPermits).where(eq(seatExecutionPermits.runId, f.runId));
    expect(stored.ledgerScope?.harnessObserver).toEqual(issued.harnessObserver);
  });
  it.each(["selection", "bundle", "capability"] as const)("freezes a formal composition in the native permit and revokes after %s drift", async change => {
    const { f, registry, adapterConfig } = await observerFixture();
    vi.stubEnv("DSP7_HARNESS_OBSERVER_BINDINGS_ENABLED", "false");
    const native = { version: 1, revision: 2, items: [{ id: "native", kind: "development", repository: "git.example/harness", root: "/native",
      profile: "default", commit: "a".repeat(40), manifestDigest: "b".repeat(64), roles: ["coding"], protocolVersion: 1,
      checkedAt: new Date().toISOString(), validation: "local-files", executionReady: false }] };
    const selected = { companyId: f.companyId, seatId: f.agentId, machineId: f.machineId, taskId: f.taskId,
      capabilityId: "native", capabilityRegistryRevision: 2, selectionRevision: 1, bundleRegistryRevision: 1,
      bundleDigest: registry.items[0]!.bundleDigest, nativeSkill: "jira-feature-dev", entryId: "history-pilot" };
    const config = { ...adapterConfig, dsp7HarnessCapabilities: native };
    await db.update(agents).set({ adapterConfig: config }).where(eq(agents.id, f.agentId));
    vi.stubEnv("DSP7_HARNESS_EXECUTION_BINDINGS_ENABLED", "true");
    vi.stubEnv("DSP7_HARNESS_EXECUTION_BINDINGS", JSON.stringify([selected]));
    const service = seatPermitService(db), issued = await service.issue(f);
    expect(issued.executionRoute).toMatchObject({ protocolVersion: 2, composition: { entryId: "history-pilot", selectionRevision: 1 } });
    const renewed = await service.renew(f);
    expect(renewed.alive).toBe(true);
    const [unchanged] = await db.select().from(seatExecutionPermits).where(eq(seatExecutionPermits.runId, f.runId));
    expect(unchanged.executionRoute).toEqual(issued.executionRoute);
    if (change === "selection") vi.stubEnv("DSP7_HARNESS_EXECUTION_BINDINGS", JSON.stringify([{ ...selected, selectionRevision: 2 }]));
    else {
      if (change === "bundle") registry.revision++;
      else native.revision++;
      await db.update(agents).set({ adapterConfig: config }).where(eq(agents.id, f.agentId));
    }
    expect((await service.renew(f)).alive).toBe(false);
    const [stored] = await db.select().from(seatExecutionPermits).where(eq(seatExecutionPermits.runId, f.runId));
    expect(stored.revokedAt).toBeInstanceOf(Date);
    expect(stored.executionRoute).toEqual(issued.executionRoute);
    expect((await service.renew(f)).alive).toBe(false);
  });
  it.skipIf(!process.env.HARNESS_V2_ROOT)("carries a real server-issued attachment into the actual pinned Bridge package launcher", async () => {
    const root = process.env.HARNESS_V2_ROOT;
    if (!root) throw new Error("Set HARNESS_V2_ROOT for cross-runtime acceptance");
    const python = process.env.HARNESS_TEST_PYTHON ?? "python3";
    const folder = await mkdtemp(join(tmpdir(), "observer-cross-runtime-"));
    const bridge = fileURLToPath(new URL("../../../integrations/dsp7-bridge", import.meta.url));
    try {
      const script = `import json,subprocess,sys
from pathlib import Path
sys.path.insert(0,sys.argv[1])
from harness_bundle_registry import descriptor
root=Path(sys.argv[2]);bundle=Path(sys.argv[3]).resolve()/'bundle'
result=subprocess.run([sys.executable,str(root/'packaging/packages.py'),'build','--repo',str(root.parents[1]),'--output',str(bundle)],check=True,capture_output=True,text=True)
catalog=json.loads(result.stdout)
config=dict(enabled=True,bundleRoot=str(bundle),bundleDigest=catalog['bundleDigest'],project='base-harness-infrastructure')
print(json.dumps(dict(config=config,descriptor=descriptor(config))))
`;
      const built = JSON.parse((await promisify(execFile)(python, ["-c", script, bridge, root, folder])).stdout);
      const { f, adapterConfig, registry } = await observerFixture();
      registry.items[0] = { ...registry.items[0], ...built.descriptor };
      await db.update(agents).set({ adapterConfig: { ...adapterConfig, dsp7HarnessBundles: registry } }).where(eq(agents.id, f.agentId));
      vi.stubEnv("DSP7_HARNESS_OBSERVER_BINDINGS", JSON.stringify([{ companyId:f.companyId,seatId:f.agentId,taskId:f.taskId,projectId:null,bundleDigest:built.descriptor.bundleDigest }]));
      const issued = await seatPermitService(db).issue(f, {kind:"development",observerProtocol:1});
      const launch = `import json,sys
from pathlib import Path
sys.path.insert(0,sys.argv[1])
from managed_sessions import Collector,register_local
from harness_observation_runtime import prepare
root=Path(sys.argv[2]).resolve();f=json.loads(sys.argv[3]);config=json.loads(sys.argv[4]);attachment=json.loads(sys.argv[5])
cwd=root/'workspace';cwd.mkdir()
cfg=dict(database=str(root/'local.db'),company_id=f['companyId'],agent_id=f['agentId'],seat=dict(machine_id=f['machineId']),harness_v2_observation=config,harness_v2_pilot=dict(companyId=f['companyId'],seatId=f['agentId'],taskIds=[f['taskId']]))
register_local(cfg,f['runId'],f['taskId'],cwd,cwd/'state.json',root,root/'config.json')
c=Collector(cfg,f['runId'])
try:
 args,env=prepare(c,['--session-id',f['runId']],platform_attachment=attachment)
 print(json.dumps(dict(args=args,digest=env['HARNESS_BUNDLE_DIGEST'],frozen=c.meta('harness_observer_runtime')['platformAttachment'])))
finally:c.db.close()
`;
      const observed = JSON.parse((await promisify(execFile)(python, ["-c", launch, bridge, folder,
        JSON.stringify(f), JSON.stringify(built.config), JSON.stringify(issued.harnessObserver)])).stdout);
      expect(observed.digest).toBe(built.descriptor.bundleDigest);
      expect(observed.frozen).toEqual(issued.harnessObserver);
      expect(observed.args.filter((arg:string)=>arg==="--plugin-dir")).toHaveLength(2);
    } finally { await rm(folder, {recursive:true,force:true}); }
  });
  it.each(["digest", "revision", "descriptor", "gate", "selection", "disabled", "malformed"])("revokes rather than replacing a frozen observer after %s changes", async change => {
    const { f, adapterConfig, registry, selection } = await observerFixture(), service = seatPermitService(db);
    const issued = await service.issue(f, { kind: "development", observerProtocol: 1 });
    if (change === "digest") vi.stubEnv("DSP7_HARNESS_OBSERVER_BINDINGS", JSON.stringify([{ ...selection, bundleDigest: "d".repeat(64) }]));
    if (change === "revision" || change === "descriptor") {
      if (change === "revision") registry.revision++;
      else registry.items[0].packages[1].version = "1.0.1";
      await db.update(agents).set({ adapterConfig: { ...adapterConfig, dsp7HarnessBundles: registry } }).where(eq(agents.id, f.agentId));
    }
    if (change === "gate") vi.stubEnv("DSP7_HARNESS_OBSERVATION_ENABLED", "false");
    if (change === "selection") vi.stubEnv("DSP7_HARNESS_OBSERVER_BINDINGS", "[]");
    if (change === "disabled") vi.stubEnv("DSP7_HARNESS_OBSERVER_BINDINGS_ENABLED", "false");
    if (change === "malformed") vi.stubEnv("DSP7_HARNESS_OBSERVER_BINDINGS", "{");
    expect((await service.renew(f)).alive).toBe(false);
    const [stored] = await db.select().from(seatExecutionPermits).where(eq(seatExecutionPermits.runId, f.runId));
    expect(stored.revokedAt).toBeInstanceOf(Date);
    expect(stored.ledgerScope?.harnessObserver).toEqual(issued.harnessObserver);
    expect((await service.renew(f)).alive).toBe(false);
  });
  it("keeps unselected tasks compatible and refuses invalid selection scope/duplicates without granting permits", async () => {
    const { f, selection } = await observerFixture(), service = seatPermitService(db);
    const other = await seed();
    expect((await service.issue(other)).harnessObserver).toBeUndefined();
    for (const raw of [JSON.stringify([{ ...selection, projectId: randomUUID() }]), JSON.stringify([selection, selection]),
      JSON.stringify([{ ...selection, unknown: true }]), JSON.stringify([{ ...selection, companyId: "*" }])]) {
      vi.stubEnv("DSP7_HARNESS_OBSERVER_BINDINGS", raw);
      await expect(service.issue(f, { kind: "development", observerProtocol: 1 })).rejects.toThrow();
    }
    expect(await db.select().from(seatExecutionPermits).where(eq(seatExecutionPermits.runId, f.runId))).toHaveLength(0);
  });
  it("counts each occupied task once, excludes queued work and isolates other seats", async () => {
    const f = await seed(), other = await seed();
    const [seat] = await db.select().from(agents).where(eq(agents.id, f.agentId));
    await seatPermitService(db).issue(other);
    await db.update(heartbeatRuns).set({ status: "queued" }).where(eq(heartbeatRuns.id, f.runId));
    expect((await seatOccupancy(db, seat)).occupied).toBe(0);
    expect((await seatOccupancy(db, seat, [{ kind: "start", status: "queued", taskId: f.taskId }])).occupied).toBe(0);
    expect((await seatOccupancy(db, seat, [{ kind: "start", status: "running", taskId: f.taskId }])).occupied).toBe(0);
    expect((await seatOccupancy(db, seat, [{ kind: "start", status: "awaiting_local", taskId: f.taskId }])).occupied).toBe(1);
    await db.update(heartbeatRuns).set({ status: "running" }).where(eq(heartbeatRuns.id, f.runId));
    await seatPermitService(db).issue(f);
    const commands = [{ kind: "start", status: "accepted", taskId: f.taskId }];
    expect((await seatOccupancy(db, seat, commands)).occupied).toBe(1);
    expect((await seatOccupancy(db, seat, commands, f.taskId)).occupied).toBe(0);
    await db.update(heartbeatRuns).set({ status: "succeeded" }).where(eq(heartbeatRuns.id, f.runId));
    expect((await seatOccupancy(db, seat)).occupied).toBe(1);
  });
  it("atomically admits up to the seat limit, queues excess, and allows a slot after proven exit", async () => {
    const f = await seed();
    const [seat] = await db.select().from(agents).where(eq(agents.id, f.agentId));
    await db.update(agents).set({ adapterConfig: { ...seat.adapterConfig, dsp7SeatPresence: { capabilities: ["seat-concurrency-v1"] } }, runtimeConfig: { heartbeat: { maxConcurrentRuns: 2 } } }).where(eq(agents.id, f.agentId));
    const createNext = async () => {
      const taskId = randomUUID(), runId = randomUUID();
      await db.insert(issues).values({ id: taskId, companyId: f.companyId, assigneeAgentId: f.agentId, title: "parallel", status: "in_progress" });
      await db.insert(heartbeatRuns).values({ id: runId, companyId: f.companyId, agentId: f.agentId, status: "running", contextSnapshot: { issueId: taskId } });
      return { ...f, taskId, runId, lease: randomUUID() };
    };
    const second = await createNext(), third = await createNext();
    const service = seatPermitService(db);
    await service.issue(f);
    const attempts = await Promise.allSettled([service.issue(second), service.issue(third)]);
    expect(attempts.filter(result => result.status === "fulfilled")).toHaveLength(1);
    const waiting = attempts[0].status === "rejected" ? second : third;
    const proof = { protocolVersion: 1 as const, runId: f.runId, isolation: "posix-sessions" as const, firstObservedAt: new Date(Date.now() - 500).toISOString(), observedAt: new Date().toISOString(), observations: 2, remaining: 0 as const };
    await service.observeExit(f, proof);
    expect((await service.issue(waiting)).validForMs).toBeGreaterThan(59_000);
    await db.update(agents).set({ runtimeConfig: { heartbeat: { maxConcurrentRuns: 1 } } }).where(eq(agents.id, f.agentId));
    expect((await service.renew(waiting)).alive).toBe(true);
    await expect(service.issue(await createNext())).rejects.toThrow("旧运行");
  });
  it("issues once, renews from server time and never resurrects an expired permit", async () => {
    const f = await seed();let time = Date.now();const service = seatPermitService(db, () => time);
    const issued = await service.issue(f);expect(issued.validForMs).toBe(60_000);
    await expect(service.issue(f)).rejects.toThrow("已经签发");
    time += 20_000;expect((await service.renew(f)).alive).toBe(true);
    time += 60_001;expect(await service.renew(f)).toMatchObject({ alive: false, reason: "permit_expired" });
    time -= 60_000;expect((await service.renew(f)).alive).toBe(false);
  });
  it("revokes on manual pause and permits a durable exit receipt without claiming full stop verification", async () => {
    const f = await seed(), service = seatPermitService(db);await service.issue(f);
    await db.update(agents).set({ status: "paused", pauseReason: "manual" }).where(eq(agents.id, f.agentId));
    expect(await service.renew(f)).toMatchObject({ alive: false, reason: "scope_paused" });
    expect(await service.observeExit(f)).toMatchObject({ received: true, executionStopVerified: false });
    await service.observeExit(f);
    const [stored] = await db.select().from(seatExecutionPermits).where(eq(seatExecutionPermits.runId, f.runId));
    expect(stored!.processExitObservedAt).toBeInstanceOf(Date);
  });
  it("does not allow wrong machine, company, lease or task ownership", async () => {
    const f = await seed(), service = seatPermitService(db);await service.issue(f);
    for (const changed of [{ machineId: randomUUID() }, { companyId: randomUUID() }, { lease: randomUUID() }]) {
      await expect(service.renew({ ...f, ...changed })).rejects.toThrow("身份不匹配");
      await expect(service.observeExit({ ...f, ...changed })).rejects.toThrow("不匹配");
    }
    await db.update(issues).set({ assigneeAgentId: null }).where(eq(issues.id, f.taskId));
    expect((await service.renew(f)).alive).toBe(false);
  });
  it("keeps an expired run unresolved until its exit receipt; cannot grant a replacement", async () => {
    const f = await seed();let time = Date.now();const service = seatPermitService(db, () => time);await service.issue(f);time += 60_001;
    await service.renew(f);
    const next = { ...f, runId: randomUUID(), lease: randomUUID() };
    await db.insert(heartbeatRuns).values({ id: next.runId, companyId: f.companyId, agentId: f.agentId, status: "running", contextSnapshot: { issueId: f.taskId } });
    await expect(service.issue(next)).rejects.toThrow("旧运行");
    await service.observeExit(f);await expect(service.issue(next)).rejects.toThrow("旧运行");
    await service.observeExit(f,{protocolVersion:1,runId:f.runId,isolation:"posix-sessions",firstObservedAt:new Date(time-500).toISOString(),observedAt:new Date(time).toISOString(),observations:2,remaining:0});
    expect((await service.issue(next)).validForMs).toBe(60_000);
  });
  it("accepts real local watchdog tree evidence, rejecting invalid proofs and withholding replacement until verified", async () => {
    const f=await seed(),service=seatPermitService(db);await service.issue(f);
    const script=`import sys,json,time,subprocess
sys.path.insert(0,sys.argv[1])
from process_tree import ProcessTree
from execution_permit import ExecutionPermit
child=subprocess.Popen([sys.executable,'-c','import time;time.sleep(30)'],start_new_session=True)
tree=ProcessTree(sys.argv[2]);tree.attach(child)
guard=ExecutionPermit(terminate=tree.stop)
start=time.monotonic()
try:
 guard.renew({'protocolVersion':1,'permitId':'test','mode':'observed_cost','validForMs':400},start)
 guard.attach(child);guard.start();child.wait(timeout=5)
 print(json.dumps({'elapsed':time.monotonic()-start,'proof':tree.proof()}))
finally:
 tree.stop();guard.close()
`;
    const {stdout}=await promisify(execFile)("python3",["-c",script,fileURLToPath(new URL("../../../integrations/dsp7-bridge",import.meta.url)),f.runId],{timeout:10000});
    const observed=JSON.parse(stdout);expect(observed.elapsed).toBeLessThan(5);
    await expect(service.observeExit(f,{...observed.proof,runId:randomUUID()})).rejects.toThrow("证明无效");
    expect((await service.observeExit(f,observed.proof)).executionStopVerified).toBe(true);
    expect((await db.select().from(seatExecutionPermits).where(eq(seatExecutionPermits.runId,f.runId)))[0]!.treeStopVerifiedAt).toBeInstanceOf(Date);
  });
  it("checks every active hard budget on renewal", async () => {
    const f = await seed(), service = seatPermitService(db);await service.issue(f);
    // A generous monthly policy must not mask a stricter lifetime policy.
    await db.insert(budgetPolicies).values([
      { companyId: f.companyId, scopeType: "agent", scopeId: f.agentId, windowKind: "calendar_month", metric: "billed_cents", amount: 10000, hardStopEnabled: true },
      { companyId: f.companyId, scopeType: "agent", scopeId: f.agentId, windowKind: "lifetime", metric: "billed_cents", amount: 1, hardStopEnabled: true },
    ]);
    await db.insert(costEvents).values({ companyId: f.companyId, agentId: f.agentId, provider: "test", model: "test", costCents: 2, occurredAt: new Date() });
    expect((await service.renew(f)).alive).toBe(false);
  });
});
