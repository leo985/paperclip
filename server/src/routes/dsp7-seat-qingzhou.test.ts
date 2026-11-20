import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { getTableName, type SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { agents, seatQingzhouAccounts, companySecrets, activityLog, type Db } from "@paperclipai/db";
import { describe, expect, it, vi } from "vitest";
import { seatQingzhouRoutes } from "./dsp7-seat-qingzhou.js";
import { secretService } from "../services/secrets.js";

const companyId = randomUUID(), seatId = randomUUID();
const base = `/companies/${companyId}/dsp7-seats/${seatId}/qingzhou-account`;
type Row = Record<string, any>;
// In-memory persistence for route contracts. Actual SQL predicates are evaluated,
// so company/seat authorization checks do not depend on canned select ordering.
function fixture(actor: Row = { type: "board", source: "session", userId: "owner", companyIds: [companyId] }) {
  const tables = new Map<string, Row[]>([
    [getTableName(agents), [{ id: seatId, companyId, adapterConfig: { dsp7Seat: { ownerUserId: "owner" } } }]],
    [getTableName(seatQingzhouAccounts), []], [getTableName(companySecrets), []], [getTableName(activityLog), []],
  ]);
  const dialect = new PgDialect();
  function matches(row: Row, condition?: SQL) {
    if (!condition) return true;
    const query = dialect.sqlToQuery(condition);
    return [...query.sql.matchAll(/"\w+"\."(\w+)" = \$(\d+)/g)].every(([, column, index]) => {
      const field = column.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());
      return row[field] === query.params[Number(index) - 1];
    });
  }
  const db: any = {
    select: () => ({ from: (table: any) => {
      let condition: SQL | undefined;
      const chain: any = { where: (value: SQL) => { condition = value; return chain; }, for: () => chain,
        then: (resolve: any, reject: any) => Promise.resolve(tables.get(getTableName(table))!.filter(row => matches(row, condition))).then(resolve, reject) };
      return chain;
    } }),
    insert: (table: any) => ({ values: (input: Row) => {
      const row = { id: randomUUID(), updatedAt: new Date(), lastCheckedAt: null, ...input };
      tables.get(getTableName(table))!.push(row);
      return { returning: async () => [row], then: (resolve: any, reject: any) => Promise.resolve().then(resolve, reject) };
    } }),
    update: (table: any) => ({ set: (fields: Row) => ({ where: (condition: SQL) => {
      const rows = tables.get(getTableName(table))!.filter(row => matches(row, condition)); rows.forEach(row => Object.assign(row, fields));
      return { returning: async () => rows, then: (resolve: any, reject: any) => Promise.resolve().then(resolve, reject) };
    } }) }),
    execute: vi.fn(async () => {}), transaction: async (fn: any) => fn(db),
  };
  const values = new Map<string, string>();
  const secrets = {
    create: vi.fn(async (cid: string, input: Row) => {
      const id = randomUUID(); values.set(id, input.value);
      tables.get(getTableName(companySecrets))!.push({ id, companyId: cid, scope: "company", status: "active", deletedAt: null });
      return { id };
    }),
    rotate: vi.fn(async (id: string, input: Row) => { values.set(id, input.value); }),
    remove: vi.fn(async (id: string) => { values.delete(id); }),
    resolveSecretValue: vi.fn(async (_cid: string, id: string) => values.get(id)),
  };
  const fetcher = vi.fn(async () => new Response(JSON.stringify({ accessToken: "fixture-access-token" })));
  const app = express(); app.use(express.json()); app.use((req, _res, next) => { req.actor = actor as any; next(); });
  app.use(seatQingzhouRoutes(db as Db, { secrets: (() => secrets) as unknown as typeof secretService, fetch: fetcher as typeof fetch }));
  app.use((error: any, _req: any, res: any, _next: any) => res.status(error.status ?? 500).json({ error: error.message }));
  return { app, db, secrets, fetcher, tables, values };
}

describe("seat Qingzhou account routes", () => {
  it("stores credentials only through the encrypted vault and returns safe account metadata", async () => {
    const f = fixture();
    expect((await request(f.app).get(base)).body).toMatchObject({ configured: false, revision: 0 });
    const response = await request(f.app).put(base).send({ expectedRevision: 0, username: "seat-analyst", password: "fixture-password" });
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ seatId, username: "seat-analyst", configured: true, revision: 1, lastCheckStatus: "not_checked" });
    expect(f.secrets.create).toHaveBeenCalledWith(companyId, expect.objectContaining({ provider: "local_encrypted", value: JSON.stringify({ username: "seat-analyst", password: "fixture-password" }) }), expect.any(Object));
    const metadata = [...f.tables.values()].flat();
    expect(JSON.stringify(metadata)).not.toContain("fixture-password");
    const read = await request(f.app).get(base);
    expect(read.headers["cache-control"]).toBe("no-store");
    expect(JSON.stringify(read.body)).not.toMatch(/credentialSecretId|password|fixture-access-token/);
  });
  it("preserves an unchanged password, requires a new one for a changed identity and fences stale writes", async () => {
    const f = fixture();
    await request(f.app).put(base).send({ expectedRevision: 0, username: "analyst", password: "fixture-password" });
    expect((await request(f.app).put(base).send({ expectedRevision: 1, username: "other" })).status).toBe(400);
    expect((await request(f.app).put(base).send({ expectedRevision: 1, username: "analyst" })).body.revision).toBe(2);
    expect(f.secrets.rotate).not.toHaveBeenCalled();
    expect((await request(f.app).put(base).send({ expectedRevision: 1, username: "analyst", password: "replacement" })).status).toBe(409);
    expect((await request(f.app).put(base).send({ expectedRevision: 2, username: "other", password: "replacement" })).body.username).toBe("other");
    expect(f.secrets.rotate).toHaveBeenCalledOnce();
  });
  it("checks the saved seat account without returning tokens or performing business writes", async () => {
    const f = fixture();
    await request(f.app).put(base).send({ expectedRevision: 0, username: "analyst", password: "fixture-password" });
    const result = await request(f.app).post(base + "/check").send({ expectedRevision: 1 });
    expect(result.body).toMatchObject({ lastCheckStatus: "valid", revision: 1 });
    expect(f.fetcher).toHaveBeenCalledOnce();
    const call = (f.fetcher.mock.calls as unknown as [string, RequestInit][])[0];
    expect(call[0]).toContain("/api/auth/login"); expect(String(call[1].body)).toContain("analyst");
    expect(JSON.stringify(result.body)).not.toContain("fixture-access-token");
    f.fetcher.mockRejectedValueOnce(Error("private password and token"));
    const failed = await request(f.app).post(base + "/check").send({ expectedRevision: 1 });
    expect(failed.body.lastCheckStatus).toBe("failed"); expect(failed.body.error).toContain("无法连接轻舟");
    expect(JSON.stringify(failed.body)).not.toContain("private");
  });
  it("removes credentials, preserves a revision tombstone and rejects delayed edits", async () => {
    const f = fixture();
    await request(f.app).put(base).send({ expectedRevision: 0, username: "analyst", password: "fixture-password" });
    expect((await request(f.app).delete(base).send({ expectedRevision: 1 })).body).toMatchObject({ configured: false, username: null, revision: 2 });
    expect(f.secrets.remove).toHaveBeenCalledOnce();
    expect((await request(f.app).put(base).send({ expectedRevision: 1, username: "analyst", password: "old-edit" })).status).toBe(409);
  });
  it("requires the seat owner or an administrator and denies machine/cross-company access", async () => {
    for (const actor of [
      { type: "board", source: "session", userId: "unrelated", companyIds: [companyId] },
      { type: "board", source: "session", userId: "owner", companyIds: [randomUUID()] },
      { type: "agent", source: "agent_key", agentId: seatId, companyId },
    ]) {
      const f = fixture(actor);
      expect((await request(f.app).get(base)).status).toBe(403);
      expect((await request(f.app).put(base).send({ expectedRevision: 0, username: "analyst", password: "fixture-password" })).status).toBe(403);
      expect((await request(f.app).post(base + "/check").send({ expectedRevision: 0 })).status).toBe(403);
      expect((await request(f.app).delete(base).send({ expectedRevision: 0 })).status).toBe(403);
      expect(f.secrets.create).not.toHaveBeenCalled(); expect(f.fetcher).not.toHaveBeenCalled();
    }
    const admin = fixture({ type: "board", source: "session", userId: "admin", companyIds: [companyId], memberships: [{ companyId, status: "active", membershipRole: "admin" }] });
    expect((await request(admin.app).put(base).send({ expectedRevision: 0, username: "analyst", password: "fixture-password" })).status).toBe(200);
  });
  it("does not read another seat's account or another company's secret", async () => {
    const f = fixture();
    expect((await request(f.app).get(base.replace(seatId, randomUUID()))).status).toBe(404);
    await request(f.app).put(base).send({ expectedRevision: 0, username: "analyst", password: "fixture-password" });
    f.tables.get(getTableName(companySecrets))![0].companyId = randomUUID();
    const failed = await request(f.app).post(base + "/check").send({ expectedRevision: 1 });
    expect(failed.body.lastCheckStatus).toBe("failed"); expect(f.secrets.resolveSecretValue).not.toHaveBeenCalled();
  });
  it("rejects a secret whose stored identity differs from the bound username", async () => {
    const f = fixture();
    await request(f.app).put(base).send({ expectedRevision: 0, username: "analyst", password: "fixture-password" });
    const secretId = [...f.values.keys()][0];
    f.values.set(secretId, JSON.stringify({ username: "another-person", password: "other-password" }));
    const failed = await request(f.app).post(base + "/check").send({ expectedRevision: 1 });
    expect(failed.body.lastCheckStatus).toBe("failed"); expect(f.fetcher).not.toHaveBeenCalled();
  });
  it("allows replacing or removing a credential revoked in the vault", async () => {
    const f = fixture();
    await request(f.app).put(base).send({ expectedRevision: 0, username: "analyst", password: "fixture-password" });
    const secret = f.tables.get(getTableName(companySecrets))![0];
    secret.status = "deleted"; secret.deletedAt = new Date();
    expect((await request(f.app).put(base).send({ expectedRevision: 1, username: "analyst" })).status).toBe(400);
    expect((await request(f.app).put(base).send({ expectedRevision: 1, username: "analyst", password: "replacement" })).status).toBe(200);
    expect(f.secrets.create).toHaveBeenCalledTimes(2);
    const replacement = f.tables.get(getTableName(companySecrets))![1];
    replacement.status = "deleted"; replacement.deletedAt = new Date();
    expect((await request(f.app).delete(base).send({ expectedRevision: 2 })).status).toBe(200);
  });
});
