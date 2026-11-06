import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Db } from "@paperclipai/db";
import { PgDialect } from "drizzle-orm/pg-core";
const secrets = vi.hoisted(() => ({ create: vi.fn(), rotate: vi.fn() }));
vi.mock("../services/secrets.js", () => ({ secretService: () => secrets }));
vi.mock("./dsp7-seat-bots.js", () => ({ seatNotificationBots: async () => [{ id: "a8661763-c814-4116-bee6-70ef4025e727", corpId: "corp", enabled: true }] }));
import { seatGroupRoutes } from "./dsp7-seat-groups.js";
import { errorHandler } from "../middleware/error-handler.js";

const companyId = "c7bcc01e-0741-4dca-8ff6-825e25f706da";
const fields = { name: "研发通知群", botId: "a8661763-c814-4116-bee6-70ef4025e727", enabled: true };
const credentials = { webhookUrl: "https://oapi.dingtalk.com/robot/send?access_token=private-token", signingSecret: "SEC0123456789abcdef" };
function fixture(role = "admin", type = "board", allowedCompany = companyId) {
  const events: any[] = [], predicates: any[] = [];
  const db = {
    select: () => {
      const chain: Record<string, unknown> = { then: (ok: (value: unknown) => unknown) => Promise.resolve([...events].reverse()).then(ok) };
      chain.from = () => chain; chain.orderBy = () => chain;
      chain.where = (condition:any) => { predicates.push(new PgDialect().sqlToQuery(condition)); return chain; };
      return chain;
    },
    insert: () => ({ values: async (value:unknown) => { events.push(value); } }),
    execute: async () => {},
    transaction: async (fn:(tx:unknown)=>unknown) => fn(db),
  };
  const app = express(); app.use(express.json());
  app.use((req, _res, next) => {
    req.actor = { type, source: "session", userId: "admin", companyId: allowedCompany, companyIds: [allowedCompany], memberships: [{ companyId: allowedCompany, status: "active", membershipRole: role }] } as typeof req.actor; next();
  });
  app.use(seatGroupRoutes(db as unknown as Db)); app.use(errorHandler);
  return { app, events, predicates };
}
beforeEach(() => { vi.clearAllMocks(); secrets.create.mockResolvedValue({ id: "encrypted-secret-id" }); });
describe("company notification group registry", () => {
  const url = `/companies/${companyId}/dsp7-notification-groups`;
  it("stores credentials only through the vault and never returns or audits them", async () => {
    const { app, events, predicates } = fixture();
    const created = await request(app).post(url).send({ ...fields, credentials });
    expect(created.status).toBe(200);
    expect(secrets.create).toHaveBeenCalledWith(companyId, expect.objectContaining({ provider: "local_encrypted", value: JSON.stringify(credentials) }), expect.anything());
    expect(events[0].details).toMatchObject({ ...fields, secretId: "encrypted-secret-id" });
    expect(JSON.stringify(events)).not.toMatch(/private-token|SEC0123456789abcdef/);
    expect(JSON.stringify(created.body)).not.toMatch(/secretId|private-token|SEC0123456789abcdef/);
    const listed = await request(app).get(url);
    expect(listed.status).toBe(200); expect(listed.body).toEqual([created.body]);
    expect(predicates.every(query => query.params.includes(companyId))).toBe(true);
    const disabled = await request(app).post(`${url}/${created.body.id}`).send({ ...fields, enabled: false });
    expect(disabled.status).toBe(200); expect(disabled.body.enabled).toBe(false);
    expect(secrets.create).toHaveBeenCalledTimes(1); expect(secrets.rotate).not.toHaveBeenCalled();
  });
  it("rotates group credentials without exposing old or new values", async () => {
    const { app } = fixture();
    const created = await request(app).post(url).send({ ...fields, credentials });
    const edited = await request(app).post(`${url}/${created.body.id}`).send({ ...fields, credentials });
    expect(edited.status).toBe(200); expect(secrets.rotate).toHaveBeenCalledWith("encrypted-secret-id", { value: JSON.stringify(credentials) }, expect.anything());
  });
  it("requires admin writes, company access and a board actor", async () => {
    expect((await request(fixture("operator").app).post(url).send({ ...fields, credentials })).status).toBe(403);
    expect((await request(fixture("admin", "agent").app).get(url)).status).toBe(403);
    expect((await request(fixture("admin", "board", "other-company").app).get(url)).status).toBe(403);
    expect(secrets.create).not.toHaveBeenCalled();
  });
  it("rejects missing credentials, foreign bots and unsafe webhooks", async () => {
    const { app } = fixture();
    expect((await request(app).post(url).send(fields)).status).toBe(400);
    expect((await request(app).post(url).send({ ...fields, botId: "a8661763-c814-4116-bee6-70ef4025e728", credentials })).status).toBe(400);
    expect((await request(app).post(url).send({ ...fields, credentials: { ...credentials, webhookUrl: "https://attacker.test/send" } })).status).toBe(400);
    expect(secrets.create).not.toHaveBeenCalled();
  });
});
