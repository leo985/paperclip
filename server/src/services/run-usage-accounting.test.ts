import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { agentRuntimeState, agents, budgetPolicies, companies, costEvents, createDb, heartbeatRuns } from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "../__tests__/helpers/embedded-postgres.js";
import { accountFinalRunUsage } from "./run-usage-accounting.js";
const support = await getEmbeddedPostgresTestSupport();
(support.supported ? describe : describe.skip)("atomic final run usage receipts", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  beforeAll(async () => { database = await startEmbeddedPostgresTestDatabase("run-usage-"); db = createDb(database.connectionString); });
  afterAll(async () => { await database?.cleanup(); });
  async function seed(withState = true) {
    const companyId = randomUUID(), agentId = randomUUID(), heartbeatRunId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Usage", issuePrefix: `U${companyId.slice(0, 6)}` });
    await db.insert(agents).values({ id: agentId, companyId, name: "Seat", role: "engineer", adapterType: "claude_local" });
    await db.insert(heartbeatRuns).values({ id: heartbeatRunId, companyId, agentId, status: "succeeded" });
    if (withState) await db.insert(agentRuntimeState).values({ companyId, agentId, adapterType: "claude_local" });
    return { companyId, data: { agentId, heartbeatRunId, provider: "relay", model: "claude", inputTokens: 100,
      outputTokens: 20, cachedInputTokens: 30, costCents: 12, occurredAt: new Date() } };
  }
  it("commits concurrent final replays once in both ledger and runtime totals", async () => {
    const f = await seed();
    const events = await Promise.all(Array.from({ length: 4 }, () => accountFinalRunUsage(db, f.companyId, f.data)));
    expect(new Set(events.map(event => event.id)).size).toBe(1);
    const [state] = await db.select().from(agentRuntimeState).where(eq(agentRuntimeState.agentId, f.data.agentId));
    expect(state).toMatchObject({ totalInputTokens: 100, totalOutputTokens: 20, totalCachedInputTokens: 30, totalCostCents: 12 });
    await expect(accountFinalRunUsage(db, f.companyId, { ...f.data, outputTokens: 40 })).rejects.toThrow("different content");
  });
  it("rolls back the ledger if runtime accounting cannot commit", async () => {
    const f = await seed(false);
    await expect(accountFinalRunUsage(db, f.companyId, f.data)).rejects.toThrow("Runtime state must exist");
    expect(await db.select().from(costEvents).where(eq(costEvents.heartbeatRunId, f.data.heartbeatRunId))).toHaveLength(0);
  });
  it("retries remote budget enforcement after a post-commit failure without recharging", async () => {
    const f = await seed();
    await db.insert(budgetPolicies).values({ companyId: f.companyId, scopeType: "agent", scopeId: f.data.agentId,
      metric: "billed_cents", windowKind: "lifetime", amount: 10, hardStopEnabled: true, notifyEnabled: false });
    const stop = vi.fn().mockRejectedValueOnce(new Error("temporary transport failure")).mockResolvedValue(undefined);
    await expect(accountFinalRunUsage(db, f.companyId, f.data, { cancelWorkForScope: stop })).rejects.toThrow("temporary transport failure");
    await accountFinalRunUsage(db, f.companyId, f.data, { cancelWorkForScope: stop });
    expect(stop).toHaveBeenCalledTimes(2);
    expect(await db.select().from(costEvents).where(eq(costEvents.heartbeatRunId, f.data.heartbeatRunId))).toHaveLength(1);
    const [state] = await db.select().from(agentRuntimeState).where(eq(agentRuntimeState.agentId, f.data.agentId));
    expect(state!.totalCostCents).toBe(12);
  });
  it("preserves unknown pricing while recording tokens exactly once", async () => {
    const f = await seed();
    const data = { ...f.data, costCents: 0, billingType: "unknown", costStatus: "unpriced" };
    const event = await accountFinalRunUsage(db, f.companyId, data);
    await accountFinalRunUsage(db, f.companyId, data);
    expect(event).toMatchObject({ costCents: 0, costStatus: "unpriced", billingType: "unknown", inputTokens: 100 });
  });
});
