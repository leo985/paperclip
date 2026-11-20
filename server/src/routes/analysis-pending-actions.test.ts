import express from "express";
import request from "supertest";
import { PgDialect } from "drizzle-orm/pg-core";
import { describe, expect, it, vi } from "vitest";
import type { Db } from "@paperclipai/db";
vi.mock("../services/heartbeat.js", () => ({ heartbeatService: () => ({}) }));
import { analysisExecutionRoutes } from "./analysis-executions.js";

function fixture({ role = "admin", company = "company", agent = false } = {}) {
  const where: Array<{ sql: string; params: unknown[] }> = [];
  const dialect = new PgDialect();
  const values = [
    { id: "new-question", taskId: "task", runId: "current", key: "Q1" },
    { id: "old-version", taskId: "task", runId: "current", key: "Q1" },
    { id: "review", taskId: "task", runId: "current", key: "P3-review" },
  ];
  const replies: unknown[][] = role === "admin" ? [[], [{ role: "admin" }], values] : [[], [{ role: "member" }], [{ id: "seat", adapterConfig: { dsp7WebJiraIntake: true, dsp7Seat: { ownerUserId: "me" } } }], values];
  const select = vi.fn(() => {
    const promise = Promise.resolve(replies.shift() ?? []);
    const chain = Object.assign(promise, { from: () => chain, innerJoin: (_table: unknown, condition: Parameters<PgDialect["sqlToQuery"]>[0]) => { where.push(dialect.sqlToQuery(condition)); return chain; },
      where: (condition: Parameters<PgDialect["sqlToQuery"]>[0]) => { where.push(dialect.sqlToQuery(condition)); return chain; }, orderBy: () => chain, limit: () => chain });
    return chain;
  });
  const app = express();
  app.use((req, _res, next) => { req.actor = agent ? { type: "agent", agentId: "seat", companyId: company, companyIds: [company], source: "agent_key" } : { type: "board", source: "session", userId: "me", companyIds: [company], memberships: [{ companyId: company, membershipRole: role, status: "active" }] }; next(); });
  app.use(analysisExecutionRoutes({ select } as unknown as Db));
  app.use((error: { status?: number; message: string }, _req: express.Request, res: express.Response, _next: express.NextFunction) => res.status(error.status ?? 500).json({ error: error.message }));
  return { app, select, where };
}

describe("current-run workbench analysis actions", () => {
  const path = "/companies/company/analysis-executions/pending-actions";
  it("deduplicates question versions without returning report bodies", async () => {
    const { app } = fixture();
    const response = await request(app).get(path);
    expect(response.status).toBe(200); expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.body.map((item: { id: string }) => item.id)).toEqual(["new-question", "review"]);
    expect(response.body[0]).not.toHaveProperty("snapshot");
  });
  it("requires an open decision, its current running run, an unfinished task and no delivery", async () => {
    const { app, where } = fixture(); await request(app).get(path);
    const query = where.map(condition => condition.sql).join(" ");
    expect(query).toContain('"analysis_decisions"."run_id" = "analysis_executions"."active_run_id"');
    expect(query).toContain('"analysis_executions"."delivery" is null');
    expect(query).toContain("not in ('done', 'cancelled')");
    expect(where.flatMap(condition => condition.params)).toEqual(expect.arrayContaining(["company", "open", "running"]));
  });
  it("applies personal task/owned-seat restrictions for members", async () => {
    const { app, where } = fixture({ role: "member" });
    expect((await request(app).get(path)).status).toBe(200);
    const last = where.at(-1)!;
    expect(last.sql).toContain('"issues"."assignee_user_id"'); expect(last.sql).toContain('"issues"."assignee_agent_id"');
    expect(last.params).toEqual(expect.arrayContaining(["me", "seat"]));
  });
  it("rejects cross-company and agent access before reading data", async () => {
    for (const options of [{ company: "another" }, { agent: true }]) {
      const { app, select } = fixture(options);
      expect((await request(app).get(path)).status).toBe(403); expect(select).not.toHaveBeenCalled();
    }
  });
});
