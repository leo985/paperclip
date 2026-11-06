import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { activityLog, authUsers, companies, companyMemberships, createDb, issues, type Db } from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "../__tests__/helpers/embedded-postgres.js";
import { errorHandler } from "../middleware/error-handler.js";
import { managementFollowUpRoutes } from "./management-follow-ups.js";

const support = await getEmbeddedPostgresTestSupport();
(support.supported ? describe : describe.skip)("durable management follow-up", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>, db: Db;
  const companyId = randomUUID(), foreignCompany = randomUUID(), issueId = randomUUID(), foreignIssue = randomUUID();
  const users = [randomUUID(), randomUUID(), randomUUID()];
  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("management-follow-up-"); db = createDb(database.connectionString);
    await db.insert(companies).values([{ id: companyId, name: "Follow up", issuePrefix: "FU" }, { id: foreignCompany, name: "Other", issuePrefix: "OTH" }]);
    await db.insert(authUsers).values(users.map((id, i) => ({ id, name: "Member " + i, email: id + "@example.test", createdAt: new Date(), updatedAt: new Date() })));
    await db.insert(companyMemberships).values(users.map((principalId, i) => ({ companyId, principalType: "user", principalId, status: "active", membershipRole: i === 2 ? "viewer" : "member" })));
    await db.insert(issues).values([{ id: issueId, companyId, title: "Coordinate", status: "blocked", assigneeUserId: users[0] }, { id: foreignIssue, companyId: foreignCompany, title: "Private" }]);
  });
  afterAll(async () => { await database?.cleanup(); });
  const path = `/companies/${companyId}/management-follow-ups`;
  function app(userId = users[0], admin = false, agent = false) {
    const app = express(); app.use(express.json());
    app.use((req, _res, next) => {
      req.actor = (agent ? { type: "agent", agentId: randomUUID(), companyId, source: "agent_key" } : { type: "board", userId, source: "session", isInstanceAdmin: admin, companyIds: [companyId], memberships: [{ companyId, status: "active", membershipRole: userId === users[2] ? "viewer" : "member" }] }) as typeof req.actor;
      next();
    });
    app.use(managementFollowUpRoutes(db)); app.use(errorHandler); return app;
  }
  it("atomically claims one coordinator, rejects stale writes and preserves task assignment", async () => {
    const responses = await Promise.all(users.slice(0, 2).map(ownerUserId => request(app(ownerUserId)).put(path + "/" + issueId).send({ expectedVersion: 0, ownerUserId })));
    expect(responses.map(r => r.status).sort()).toEqual([200, 409]);
    const row = responses.find(r => r.status === 200)!.body;
    const other = users.find(u => u !== row.ownerUserId && u !== users[2])!;
    expect((await request(app(other)).put(path + "/" + issueId).send({ expectedVersion: 1, ownerUserId: other })).status).toBe(403);
    const remindAt = new Date(Date.now() + 3600000).toISOString();
    expect((await request(app(row.ownerUserId)).put(path + "/" + issueId).send({ expectedVersion: 1, remindAt })).status).toBe(200);
    const read = await request(app()).get(path).query({ issueIds: issueId + "," + foreignIssue });
    expect(read.status).toBe(200); expect(read.body).toHaveLength(1);
    expect(read.body[0].remindAt).toBe(remindAt);
    expect(read.body[0].version).toBe(2);
    const [issue] = await db.select().from(issues).where(eq(issues.id, issueId));
    expect(issue.assigneeUserId).toBe(users[0]); expect(issue.status).toBe("blocked");
    expect(await db.select().from(activityLog).where(eq(activityLog.action, "management.follow_up.updated"))).toHaveLength(2);
  });
  it("requires board write access, active local targets and current versions for transfer", async () => {
    expect((await request(app(users[2])).put(path + "/" + issueId).send({ expectedVersion: 2, ownerUserId: users[2] })).status).toBe(403);
    expect((await request(app(users[0], false, true)).get(path).query({ issueIds: issueId })).status).toBe(403);
    expect((await request(app(users[0], true)).put(path + "/" + foreignIssue).send({ expectedVersion: 0, ownerUserId: users[0] })).status).toBe(404);
    expect((await request(app(users[0], true)).put(path + "/" + issueId).send({ expectedVersion: 2, ownerUserId: randomUUID() })).status).toBe(400);
    expect((await request(app(users[0], true)).put(path + "/" + issueId).send({ expectedVersion: 2, ownerUserId: users[1], remindAt: new Date(Date.now() + 3600000).toISOString() })).status).toBe(200);
    const release = await request(app(users[1])).put(path + "/" + issueId).send({ expectedVersion: 3, ownerUserId: null });
    expect(release.status).toBe(200); expect(release.body.ownerUserId).toBeNull(); expect(release.body.remindAt).toBeNull();
  });
});
