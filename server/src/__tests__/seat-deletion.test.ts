import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { activityLog, agentApiKeys, agents, companies, createDb, heartbeatRuns, issues } from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { dsp7SeatOwnerRoutes } from "../routes/dsp7-seat-owners.js";

const support = await getEmbeddedPostgresTestSupport();
const describeDatabase = support.supported ? describe : describe.skip;

describeDatabase("administrator seat deletion", () => {
  let db: ReturnType<typeof createDb>;
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("paperclip-seat-deletion-");
    db = createDb(database.connectionString);
  }, 30_000);
  afterAll(async () => { await database?.cleanup(); });

  async function fixture(role = "admin", overrides: Record<string, unknown> = {}) {
    const [company] = await db.insert(companies).values({ name: "Seat deletion", issuePrefix: "D"+randomUUID().slice(0,7) }).returning();
    const [seat] = await db.insert(agents).values({ companyId: company.id, name: "Old computer", role: "engineer", adapterType: "process", status: "idle", adapterConfig: { dsp7Seat: { ownerUserId: "user" }, dsp7WebJiraIntake: true } }).returning();
    const actor = { type: "board", source: "session", userId: "user", companyIds: [company.id], memberships: [{companyId: company.id, status: "active", membershipRole: role}], ...overrides } as Express.Request["actor"];
    const app = express(); app.use(express.json());
    app.use((req, _res, next) => { req.actor = actor; next(); });
    app.use("/api", dsp7SeatOwnerRoutes(db));
    app.use((error: {status?: number; message: string}, _req: express.Request, res: express.Response, _next: express.NextFunction) => { res.status(error.status ?? 500).json({error: error.message}); });
    const remove = (id=seat.id) => request(app).delete(`/api/companies/${company.id}/dsp7-seats/${id}`);
    return {company, seat, remove};
  }

  it.each(["member", "operator", "viewer"])("rejects a %s even when they own the seat", async role => {
    const {seat, remove} = await fixture(role);
    expect((await remove()).status).toBe(403);
    expect(await db.select().from(agents).where(eq(agents.id,seat.id))).toHaveLength(1);
  });
  it("rejects machine credentials", async () => {
    const {remove}=await fixture("admin",{type:"agent",source:"agent_key"});
    expect((await remove()).status).toBe(403);
  });
  it("does not delete a seat in another company", async () => {
    const own=await fixture();const foreign=await fixture();
    expect((await own.remove(foreign.seat.id)).status).toBe(404);
    expect(await db.select().from(agents).where(eq(agents.id,foreign.seat.id))).toHaveLength(1);
  });
  it("does not delete an ordinary agent through the seat endpoint", async () => {
    const {seat,remove}=await fixture();
    await db.update(agents).set({adapterConfig:{}}).where(eq(agents.id,seat.id));
    expect((await remove()).status).toBe(404);
  });
  it("rejects an online seat", async () => {
    const {seat,remove}=await fixture();
    await db.update(agents).set({adapterConfig:{dsp7Seat:{},dsp7SeatPresence:{lastSeenAt:new Date().toISOString()}}}).where(eq(agents.id,seat.id));
    const result=await remove();expect(result.status).toBe(409);expect(result.body.error).toContain("仍在线");
  });
  it.each(["queued","running","scheduled_retry"])("rejects a %s run even when the computer is offline",async status=>{
    const {company,seat,remove}=await fixture();
    await db.insert(heartbeatRuns).values({companyId:company.id,agentId:seat.id,status});
    expect((await remove()).status).toBe(409);
  });
  it("requires unfinished tasks to be completed or reassigned", async () => {
    const {company,seat,remove}=await fixture();
    await db.insert(issues).values({companyId:company.id,title:"Unfinished",assigneeAgentId:seat.id,status:"blocked"});
    const result=await remove();expect(result.status).toBe(409);expect(result.body.error).toContain("转派");
  });
  it.each(["admin","owner","instance"])("lets an %s delete an idle offline seat, revoke its key and retain a deletion audit",async role=>{
    const {company,seat,remove}=await fixture(role,role==="instance"?{isInstanceAdmin:true}:{});
    await db.insert(agentApiKeys).values({companyId:company.id,agentId:seat.id,name:"DSP7 outbound personal seat",keyHash:randomUUID()});
    const result=await remove();expect(result.status).toBe(200);
    expect(await db.select().from(agents).where(eq(agents.id,seat.id))).toHaveLength(0);
    expect(await db.select().from(agentApiKeys).where(eq(agentApiKeys.agentId,seat.id))).toHaveLength(0);
    const events=await db.select().from(activityLog).where(eq(activityLog.entityId,seat.id));
    expect(events).toEqual(expect.arrayContaining([expect.objectContaining({companyId:company.id,action:"dsp7.seat.deleted",actorId:"user"})]));
  });
});
