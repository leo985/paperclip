import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { activityLog, agents, companies, createDb, environmentLeases, heartbeatRuns, issueRecoveryActions, issues } from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "../__tests__/helpers/embedded-postgres.js";
import { getExecutionBlocker } from "./execution-blocker.js";
import { acknowledgeStoppedSeatConversation, recordBudgetSeatStopIntent } from "./seat-execution-stop.js";

const support = await getEmbeddedPostgresTestSupport();
(support.supported ? describe : describe.skip)("explicit seat resume stop acknowledgement", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("seat-stop-");
    db = createDb(database.connectionString);
  });
  afterAll(async () => { await database?.cleanup(); });
  async function seed() {
    const companyId = randomUUID(), agentId = randomUUID(), taskId = randomUUID(), runId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Seat resume", issuePrefix: `S${companyId.slice(0, 6)}` });
    const [agent] = await db.insert(agents).values({ id: agentId, companyId, name: "Local seat", role: "engineer", adapterType: "claude_local",
      adapterConfig: { dsp7Transport: "outbound", dsp7Seat: { machineId: randomUUID() }, dsp7SeatPresence: {
        lastSeenAt: new Date().toISOString(), state: "idle", capabilities: ["execution-recovery-v1"],
        tasks: [{ taskId, stoppedRunId: runId }],
      } } }).returning();
    const [task] = await db.insert(issues).values({ id: taskId, companyId, title: "Continue design", status: "blocked", assigneeAgentId: agentId }).returning();
    await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId, status: "cancelled", runtimeMode: "legacy",
      finishedAt: new Date(), errorCode: "cancelled", runnerProfileJson: { adapterDispatch: { adapterType: "claude_local" } },
      contextSnapshot: { issueId: taskId, wakeReason: "本地研发人员主动启动交互会话；测试" },
      resultJson: { preserved: "prior work", localStopRequiresVerification: true, executionCancellation: { state: "requested" } } });
    await db.insert(issueRecoveryActions).values({ companyId, sourceIssueId: taskId, kind: "active_run_watchdog",
      cause: "legacy_execution_requires_reconciliation", fingerprint: runId, status: "resolved", outcome: "blocked",
      nextAction: "Automatic recovery stopped", evidence: { runId, automaticRecovery: { replay: "blocked", actionOutcome: "unknown" } } });
    return { agent: agent!, task: task!, runId, actorId: "owner" };
  }
  it("persists a deduplicated budget stop intent without claiming the machine has exited", async () => {
    const f=await seed();
    const [run]=await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id,f.runId));
    await recordBudgetSeatStopIntent(db,run!);await recordBudgetSeatStopIntent(db,run!);
    const [stored]=await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id,f.runId));
    expect(stored.resultJson).toMatchObject({preserved:"prior work",localStopRequiresVerification:true,dsp7StopIntent:{source:"budget",stopRequiresVerification:true}});
    const events=await db.select().from(activityLog).where(eq(activityLog.entityId,f.runId));
    expect(events.filter(e=>e.action==="dsp7.seat.stop.requested")).toHaveLength(1);
    expect(events[0]).toMatchObject({actorType:"system",actorId:"budget_service"});
  });
  it("makes a cancelled outbound conversation eligible after verified explicit resume without inventing outcomes or launching a run", async () => {
    const f = await seed();
    expect(await getExecutionBlocker(db, f.agent.companyId, f.task.id)).not.toBeNull();
    await db.transaction(tx => acknowledgeStoppedSeatConversation(tx as unknown as typeof db, f));
    expect(await getExecutionBlocker(db, f.agent.companyId, f.task.id)).toBeNull();
    const runs = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.companyId, f.agent.companyId));
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ status: "cancelled", resultJson: { preserved: "prior work", localStopRequiresVerification: false,
      executionCancellation: { state: "acknowledged" }, seatStopVerification: { actorId: "owner" } } });
    const [recovery] = await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.companyId, f.agent.companyId));
    expect(recovery.evidence.automaticRecovery).toEqual({ replay: "blocked", actionOutcome: "unknown" });
    const audit = await db.select().from(activityLog).where(eq(activityLog.companyId, f.agent.companyId));
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ actorType: "user", actorId: "owner", details: { runId: f.runId, actionOutcome: "unknown" } });
  });
  it.each(["stale", "mismatched_stop", "company", "owner", "active", "lease", "other_adapter", "other_hold"])("retains protection when %s", async gate => {
    const f = await seed();
    const presence = f.agent.adapterConfig.dsp7SeatPresence as Record<string, unknown>;
    if (gate === "stale") presence.lastSeenAt = "2020-01-01T00:00:00Z";
    if (gate === "mismatched_stop") presence.tasks = [{ taskId: f.task.id, stoppedRunId: randomUUID() }];
    if (gate === "company") f.task.companyId = randomUUID();
    if (gate === "owner") f.task.assigneeAgentId = randomUUID();
    if (gate === "active") await db.insert(heartbeatRuns).values({ companyId: f.agent.companyId, agentId: f.agent.id, status: "running" });
    if (gate === "lease") await db.insert(environmentLeases).values({ companyId: f.agent.companyId, heartbeatRunId: f.runId,
      provider: "local", status: "active", leasePolicy: "ephemeral" });
    if (gate === "other_adapter") await db.update(heartbeatRuns).set({ runnerProfileJson: { adapterDispatch: { adapterType: "process" } } }).where(eq(heartbeatRuns.id, f.runId));
    if (gate === "other_hold") await db.insert(issueRecoveryActions).values({ companyId: f.agent.companyId, sourceIssueId: f.task.id,
      kind: "active_run_watchdog", cause: "uncertain_external_action", fingerprint: randomUUID(), status: "active",
      nextAction: "Inspect other action", evidence: { runId: f.runId } });
    await expect(db.transaction(tx => acknowledgeStoppedSeatConversation(tx as unknown as typeof db, f))).rejects.toThrow();
    const [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.runId));
    expect(run.resultJson?.executionCancellation).toEqual({ state: "requested" });
    expect(await getExecutionBlocker(db, f.agent.companyId, f.task.id)).not.toBeNull();
  });
});
