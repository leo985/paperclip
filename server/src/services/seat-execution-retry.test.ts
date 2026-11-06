import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, it } from "vitest";
import { activityLog, agents, companies, createDb, closeRegisteredClients, environmentLeases, heartbeatRuns, issueRecoveryActions, issues, projects } from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "../__tests__/helpers/embedded-postgres.js";
import { retryStoppedSeatExecution } from "./seat-execution-retry.js";
import { recordSeatStopIntent, recordBoardSeatStopIntent } from "./seat-execution-stop.js";
import { platformAuthorization, platformDispatchRecord } from "../routes/dsp7-jira-dispatch.js";
import { heartbeatService } from "./heartbeat.js";
import { executeOutbound, pendingOutbound } from "./dsp7-outbound.js";
import type { AdapterExecutionContext } from "../adapters/types.js";

// Optional isolated database supplied by the regression runner; never use an
// instance database. Embedded Postgres remains the normal local test path.
const external = process.env.PAPERCLIP_SEAT_RETRY_TEST_DATABASE_URL;
if (external && !/^seat_retry_verify_\d+$/.test(new URL(external).pathname.slice(1))) throw new Error("Expected a disposable seat retry database");
const supported = external || (await getEmbeddedPostgresTestSupport()).supported;
(supported ? describe : describe.skip)("one real local seat retry", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | undefined;
  let db: ReturnType<typeof createDb>;
  beforeAll(async () => {
    if (!external) database = await startEmbeddedPostgresTestDatabase("seat-retry-");
    db = createDb(external ?? database!.connectionString);
  });
  afterAll(async () => { if (external) await closeRegisteredClients(external); await database?.cleanup(); });
  async function seed() {
    const companyId = randomUUID(), agentId = randomUUID(), taskId = randomUUID(), runId = randomUUID(), projectId = randomUUID(), workspaceId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Retry test", issuePrefix: `R${companyId.slice(0, 6)}` });
    await db.insert(projects).values({ id: projectId, companyId, name: "Test" });
    const rule = { enabled: true, revision: 1, ownerUserId: "owner", jiraSecretId: randomUUID(), jiraAssignee: "owner", jiraProjectKey: "TEST", projectId, workspaceId, jiraBaseUrl: "http://jira.fingard.com:6001", readyStatuses: ["开发中"], issueTypes: ["系统设计"] };
    const [agent] = await db.insert(agents).values({ id: agentId, companyId, name: "Seat", role: "engineer", adapterType: "claude_local", adapterConfig: {
      dsp7Transport: "outbound", dsp7Seat: { machineId: randomUUID(), intakeUserIds: ["owner"] }, dsp7JiraDispatch: rule,
      dsp7SeatPresence: { lastSeenAt: new Date().toISOString(), state: "idle", capabilities: ["execution-recovery-v1", "seat-auto-retry-v1"], tasks: [{ taskId, stoppedRunId: runId }] },
    } }).returning();
    const raw = JSON.stringify({ version: 3, status_source: "seat_rule", seat_id: agentId, project_id: projectId, workspace_id: workspaceId, jira_key: "TEST-1" });
    const [task] = await db.insert(issues).values({ id: taskId, companyId, projectId, title: "Design", status: "blocked", assigneeAgentId: agentId, createdByUserId: "owner", description: `<!-- DSP7-JIRA-INTAKE ${raw} -->`, unblockDescriptor: { owner: "board", action: `执行已中断：运行编号：${runId}` } }).returning();
    await db.insert(activityLog).values({ companyId, agentId, actorType: "user", actorId: "owner", action: "dsp7.platform.dispatch.changed", entityType: "issue", entityId: taskId, createdAt: new Date(Date.now() - 5000), details: { state: "authorized", request: raw, ownerUserId: "owner" } });
    await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId, status: "failed", finishedAt: new Date(), errorCode: "adapter_failed", exitCode: 2, runtimeMode: "legacy", runnerProfileJson: { adapterDispatch: { adapterType: "claude_local" } }, contextSnapshot: { issueId: taskId, wakeReason: "本地研发人员主动启动交互会话；测试", dsp7SeatAutoRetryV1: true }, resultJson: { preserved: true, localStopRequiresVerification: true } });
    return { agent, task, runId };
  }
  it("authorizes one real local startup after exit 2, deduplicates concurrent heartbeats, and creates no phantom run", async () => {
    const f = await seed();
    const outcomes = await Promise.all([1, 2, 3].map(() => retryStoppedSeatExecution(db, f.agent.id, f.agent.companyId)));
    assert.equal(outcomes.filter(Boolean).length, 1);
    const [task] = await db.select().from(issues).where(eq(issues.id, f.task.id));
    assert.equal(task.status, "backlog"); assert.equal(task.unblockDescriptor, null);
    const runs = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.agentId, f.agent.id));
    assert.equal(runs.length, 1); assert.equal(runs[0].status, "failed"); assert.equal(runs[0].resultJson?.preserved, true);
    const auth = await platformDispatchRecord(db, f.agent, f.task.id);
    assert.deepEqual(auth?.details?.automaticRetry, { sourceRunId: f.runId, attempt: 1, state: "awaiting_local_start" });
    const second = randomUUID();
    await db.insert(heartbeatRuns).values({ ...runs[0], id: second, createdAt: new Date(), resultJson: {}, updatedAt: new Date() });
    await db.update(agents).set({ adapterConfig: { ...f.agent.adapterConfig, dsp7SeatPresence: { ...(f.agent.adapterConfig.dsp7SeatPresence as object), tasks: [{ taskId: f.task.id, stoppedRunId: second }] } } }).where(eq(agents.id, f.agent.id));
    await db.update(issues).set({ status: "blocked", unblockDescriptor: { owner: "board", action: `执行已中断：运行编号：${second}` } }).where(eq(issues.id, f.task.id));
    assert.equal(await retryStoppedSeatExecution(db, f.agent.id, f.agent.companyId), null);
  });
  it.each(["historical", "explicit_stop", "board_stop", "board_stop_result_race", "offline_stop", "cancelled", "stale", "busy", "active", "lease", "other_hold", "newer_run", "revoked", "changed_request", "paused", "intake_paused", "foreign_proof"])("keeps the gate for %s", async gate => {
    const f = await seed();
    const config = f.agent.adapterConfig;
    const presence = config.dsp7SeatPresence as Record<string, unknown>;
    if (gate === "historical") await db.update(heartbeatRuns).set({ contextSnapshot: { issueId: f.task.id, wakeReason: "本地研发人员主动启动交互会话；旧版本" } }).where(eq(heartbeatRuns.id, f.runId));
    if (gate === "explicit_stop") await db.transaction(tx => recordSeatStopIntent(tx as unknown as typeof db, f.agent, f.runId));
    if (gate === "board_stop") await db.update(heartbeatRuns).set({ resultJson: { cancelledByActorType: "user" } }).where(eq(heartbeatRuns.id, f.runId));
    if (gate === "board_stop_result_race") {
      const [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.runId));
      await recordBoardSeatStopIntent(db, run, "owner");
      await db.update(heartbeatRuns).set({ resultJson: {} }).where(eq(heartbeatRuns.id, f.runId));
    }
    if (gate === "cancelled") await db.update(heartbeatRuns).set({ status: "cancelled" }).where(eq(heartbeatRuns.id, f.runId));
    if (gate === "offline_stop") presence.tasks = [{ taskId: f.task.id, stoppedRunId: f.runId, stopRequestedRunId: f.runId }];
    if (gate === "stale") presence.lastSeenAt = "2020-01-01T00:00:00Z";
    if (gate === "busy") presence.state = "busy";
    if (gate === "foreign_proof") presence.tasks = [{ taskId: f.task.id, stoppedRunId: randomUUID() }];
    if (gate === "active") await db.insert(heartbeatRuns).values({ companyId: f.agent.companyId, agentId: f.agent.id, status: "running" });
    if (gate === "newer_run") await db.insert(heartbeatRuns).values({ companyId: f.agent.companyId, agentId: f.agent.id, status: "failed", contextSnapshot: { issueId: f.task.id, wakeReason: "本地研发人员主动启动交互会话；较新运行" } });
    if (gate === "lease") await db.insert(environmentLeases).values({ companyId: f.agent.companyId, heartbeatRunId: f.runId, provider: "local", status: "active", leasePolicy: "ephemeral" });
    if (gate === "other_hold") await db.insert(issueRecoveryActions).values({ companyId: f.agent.companyId, sourceIssueId: f.task.id, kind: "active_run_watchdog", cause: "uncertain_external_action", fingerprint: randomUUID(), status: "active", nextAction: "Inspect", evidence: { runId: f.runId } });
    if (gate === "revoked") config.dsp7Seat = { machineId: randomUUID(), intakeUserIds: [] };
    if (gate === "changed_request") await db.update(issues).set({ description: f.task.description!.replace("TEST-1", "TEST-2") }).where(eq(issues.id, f.task.id));
    if (gate === "intake_paused") config.dsp7JiraDispatch = { ...(config.dsp7JiraDispatch as object), intakePaused: true };
    await db.update(agents).set({ adapterConfig: config, ...(gate === "paused" ? { status: "paused" } : {}) }).where(eq(agents.id, f.agent.id));
    try { assert.equal(await retryStoppedSeatExecution(db, f.agent.id, f.agent.companyId), null); } catch (error) { assert.match(String(error), /保护|授权|负责人|停止|环境/); }
    const [task] = await db.select().from(issues).where(eq(issues.id, f.task.id));
    assert.equal(task.status, "blocked");
    const auth = await platformDispatchRecord(db, f.agent, f.task.id); assert.equal(auth?.details?.automaticRetry, undefined);
  });
  it("never schedules a generic placeholder retry for a local seat", async () => {
    const f = await seed();
    const result = await heartbeatService(db).scheduleBoundedRetry(f.runId);
    assert.equal(result.outcome, "not_scheduled");
    assert.equal((result as {errorCode?: string}).errorCode, "dsp7_seat_retry_managed");
    const runs = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.agentId, f.agent.id));
    assert.equal(runs.length, 1);
  });
  it("a late explicit stop fences authorized retry; explicit resume can create new authority", async () => {
    const f = await seed(); await retryStoppedSeatExecution(db, f.agent.id, f.agent.companyId);
    await db.transaction(tx => recordSeatStopIntent(tx as unknown as typeof db, f.agent, f.runId));
    const [stoppedTask] = await db.select().from(issues).where(eq(issues.id, f.task.id));
    assert.equal(stoppedTask.status, "blocked"); assert.match(stoppedTask.unblockDescriptor?.action ?? "", /用户停止/);
    await assert.rejects(platformAuthorization(db, f.agent, f.task), /明确停止/);
    await db.update(heartbeatRuns).set({ resultJson: {} }).where(eq(heartbeatRuns.id, f.runId));
    await assert.rejects(platformAuthorization(db, f.agent, f.task), /明确停止/);
    await platformAuthorization(db, f.agent, f.task, { allowStoppedRetry: true });
    const intent = await db.select().from(activityLog).where(eq(activityLog.entityId, f.runId)); assert.ok(intent.some(e => e.action === "dsp7.seat.stop.requested"));
  });
});
it("a generic retry wake cannot succeed without a local startup intent", async () => {
  const agentId = randomUUID();
  const result = await executeOutbound({ runId: randomUUID(), agent: { id: agentId }, context: { wakeReason: "transient_failure_retry" } } as unknown as AdapterExecutionContext);
  assert.equal(result.exitCode, 1); assert.equal(result.errorCode, "dsp7_local_start_required"); assert.equal(pendingOutbound(agentId), undefined);
});
