import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { agents, companies, createDb, heartbeatRuns, issues, costEvents, agentRuntimeState } from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "../__tests__/helpers/embedded-postgres.js";
import { acceptSeatFinalUsage } from "./seat-final-usage.js";
import { seatPermitService } from "./seat-execution-permits.js";
import { accountFinalRunUsage } from "./run-usage-accounting.js";
import { dsp7QuickSeatRoutes } from "../routes/dsp7-quick-seats.js";
const support = await getEmbeddedPostgresTestSupport();
(support.supported ? describe : describe.skip)("deferred final seat usage", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>, db: ReturnType<typeof createDb>;
  beforeAll(async () => { database = await startEmbeddedPostgresTestDatabase("seat-final-usage-"); db = createDb(database.connectionString); });
  afterAll(async () => { await database?.cleanup(); });
  async function seed() {
    const companyId = randomUUID(), agentId = randomUUID(), runId = randomUUID(), machineId = randomUUID(), taskId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Final usage", issuePrefix: `F${companyId.slice(0, 6)}` });
    await db.insert(agents).values({ id: agentId, companyId, name: "Seat", role: "engineer", status: "idle", adapterType: "claude_local", adapterConfig: { dsp7Transport: "outbound", dsp7Seat: { machineId, machineFingerprint: "a".repeat(64) } } });
    await db.insert(issues).values({ id: taskId, companyId, assigneeAgentId: agentId, title: "test", status: "in_progress" });
    await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId, status: "running", contextSnapshot: { issueId: taskId } });
    const f = { companyId, agentId, runId, machineId, lease: randomUUID(), taskId };
    await seatPermitService(db).issue(f);
    return f;
  }
  const input = { model: "claude", usage: { inputTokens: 100, outputTokens: 20, cachedInputTokens: 30 } };
  it("accepts late usage after cancellation, deduplicates with native final accounting and rejects changed replays", async () => {
    const f = await seed(), finishedAt = new Date();
    await db.update(heartbeatRuns).set({ status: "cancelled", finishedAt }).where(eq(heartbeatRuns.id, f.runId));
    const accepted = await acceptSeatFinalUsage(db, f, input);
    await accountFinalRunUsage(db, f.companyId, { heartbeatRunId: f.runId, agentId: f.agentId, issueId: f.taskId, projectId: null, billingCode: null,
      model: "claude", provider: "unknown", biller: "unknown", billingType: "unknown", costStatus: "unpriced", ...input.usage, costCents: 0, occurredAt: finishedAt });
    expect((await acceptSeatFinalUsage(db, f, input)).eventId).toBe(accepted.eventId);
    expect(await db.select().from(costEvents).where(eq(costEvents.heartbeatRunId, f.runId))).toHaveLength(1);
    const [state] = await db.select().from(agentRuntimeState).where(eq(agentRuntimeState.agentId, f.agentId));
    expect(state!.totalInputTokens).toBe(100);
    await expect(acceptSeatFinalUsage(db, f, { ...input, usage: { ...input.usage, inputTokens: 200 } })).rejects.toThrow("different content");
    await expect(acceptSeatFinalUsage(db, { ...f, lease: randomUUID() }, input)).rejects.toThrow("不匹配");
  });
  it("keeps active-run usage pending rather than inventing a final timestamp", async () => {
    const f = await seed();await expect(acceptSeatFinalUsage(db, f, input)).rejects.toThrow("尚未结算");
    expect(await db.select().from(costEvents).where(eq(costEvents.heartbeatRunId, f.runId))).toHaveLength(0);
  });
  it("allows paused seats to acknowledge exit and report usage but cannot claim work", async () => {
    const f = await seed();await db.update(agents).set({ status: "paused", pauseReason: "budget" }).where(eq(agents.id, f.agentId));
    await db.update(heartbeatRuns).set({ status: "cancelled", finishedAt: new Date() }).where(eq(heartbeatRuns.id, f.runId));
    const app = express();app.use(express.json());app.use((req, _res, next) => { Object.assign(req, { actor: { type: "agent", source: "agent_key", agentId: f.agentId, companyId: f.companyId } });next(); });
    app.use(dsp7QuickSeatRoutes(db));app.use((err: any, _req: any, res: any, _next: any) => res.status(err.status ?? 500).json({ error: err.message }));
    const body = { seat_id: f.agentId, machine_id: f.machineId, machine_fingerprint: "a".repeat(64), lease: f.lease };
    const base = `/agents/${f.agentId}/dsp7-outbound-runs/${f.runId}`;
    expect((await request(app).post(base + "/usage-checkpoint").send({ ...body, sequence:1,model:"claude",observedAt:new Date().toISOString(),usage:{inputTokens:50,outputTokens:10,cachedInputTokens:10} })).status).toBe(200);
    expect((await request(app).post(base + "/stopped").send({ ...body, exitObserved: true })).status).toBe(200);
    expect((await request(app).post(base + "/usage-final").send({ ...body, ...input })).status).toBe(200);
    expect((await request(app).post(`/agents/${f.agentId}/dsp7-outbound-poll`).send(body)).status).toBe(403);
    const board=express();board.use((req,_res,next)=>{Object.assign(req,{actor:{type:"board",source:"local_implicit"}});next();});board.use(dsp7QuickSeatRoutes(db));board.use((err:any,_req:any,res:any,_next:any)=>res.status(err.status??500).json({error:err.message}));
    const control=await request(board).get(`/companies/${f.companyId}/seat-run-control/${f.runId}`);
    expect(control.status).toBe(200);expect(control.body).toMatchObject({stopStatus:"pending",meteringStatus:"final_reported",tokens:{inputTokens:100,outputTokens:20,cachedInputTokens:30},costStatus:"unpriced"});
    expect(JSON.stringify(control.body)).not.toContain(f.lease);
    expect((await request(board).get(`/companies/${randomUUID()}/seat-run-control/${f.runId}`)).status).toBe(404);
  });
});
