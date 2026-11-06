import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { agents, budgetPolicies, companies, costEvents, createDb, heartbeatRuns, issues, seatExecutionPermits } from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "../__tests__/helpers/embedded-postgres.js";
import { seatPermitService } from "./seat-execution-permits.js";
import { seatOccupancy } from "./seat-concurrency.js";
const support = await getEmbeddedPostgresTestSupport();
(support.supported ? describe : describe.skip)("native seat execution permit lifecycle", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>, db: ReturnType<typeof createDb>;
  beforeAll(async () => { database = await startEmbeddedPostgresTestDatabase("seat-permits-"); db = createDb(database.connectionString); });
  afterAll(async () => { await database?.cleanup(); });
  async function seed() {
    const companyId = randomUUID(), agentId = randomUUID(), runId = randomUUID(), machineId = randomUUID(), taskId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Permits", issuePrefix: `P${companyId.slice(0, 6)}` });
    await db.insert(agents).values({ id: agentId, companyId, name: "Seat", role: "engineer", status: "idle", adapterType: "claude_local", adapterConfig: { dsp7Transport: "outbound", dsp7Seat: { machineId } } });
    await db.insert(issues).values({ id: taskId, companyId, assigneeAgentId: agentId, title: "test", status: "in_progress" });
    await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId, status: "running", contextSnapshot: { issueId: taskId } });
    return { companyId, agentId, runId, machineId, lease: randomUUID(), taskId };
  }
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
