import express from "express";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";
import type { Db } from "@paperclipai/db";
vi.mock("../services/heartbeat.js", () => ({ heartbeatService: () => ({}) }));
import { analysisExecutionRoutes } from "./analysis-executions.js";

function fixture(
  results: unknown[][],
  {
    userId = "owner",
    role = "member",
    companyId = "company",
    agent = false,
  } = {},
) {
  const select = vi.fn(() => {
    const result = Promise.resolve(results.shift() ?? []);
    const chain = Object.assign(result, {
      from: () => chain,
      where: () => chain,
      orderBy: () => chain,
      limit: () => chain,
    });
    return chain;
  });
  const app = express();
  app.use((req, _res, next) => {
    req.actor = agent
      ? {
          type: "agent",
          source: "agent_key",
          companyId,
          companyIds: [companyId],
          agentId: "seat",
        }
      : {
          type: "board",
          source: "session",
          userId,
          companyIds: [companyId],
          memberships: [{ companyId, membershipRole: role, status: "active" }],
        };
    next();
  });
  app.use(analysisExecutionRoutes({ select } as unknown as Db));
  app.use(
    (
      err: { status?: number; message: string },
      _req: express.Request,
      res: express.Response,
      _next: express.NextFunction,
    ) => res.status(err.status ?? 500).json({ error: err.message }),
  );
  return { app, select };
}
const task = {
  id: "task",
  companyId: "company",
  ownerUserId: "owner",
  state: "waiting",
  activeRunId: "run",
  delivery: null,
};
const path = "/companies/company/analysis-executions/by-task/task";
describe("analysis detail selection for the unified task page", () => {
  it("returns explicit absence for a generic task with no mutations", async () => {
    const { app, select } = fixture([[]]);
    const response = await request(app).get(path);
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ analysis: null });
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(select).toHaveBeenCalledTimes(1);
  });
  it("retains decisions, run errors and interrupted-state projection", async () => {
    const decisions = [
      { id: "decision", contentDigest: "frozen", answer: "approved" },
    ];
    const run = { id: "run", status: "cancelled", error: "Stopped by owner" };
    const { app } = fixture([[task], decisions, [run]]);
    const response = await request(app).get(path);
    expect(response.status).toBe(200);
    expect(response.body.analysis).toEqual({
      execution: { ...task, state: "interrupted" },
      decisions,
      run,
    });
  });
  it("does not turn an unauthorized analysis into a generic task", async () => {
    const { app, select } = fixture([[task]], { userId: "other" });
    expect((await request(app).get(path)).status).toBe(404);
    expect(select).toHaveBeenCalledTimes(1);
  });
  it("allows organization managers to inspect analysis owned by someone else", async () => {
    const { app } = fixture([[{ ...task, activeRunId: null }], []], {
      userId: "manager",
      role: "admin",
    });
    expect((await request(app).get(path)).body.analysis.execution.id).toBe(
      task.id,
    );
  });
  it("rejects agents and other companies before querying any records", async () => {
    for (const actor of [{ agent: true }, { companyId: "other-company" }]) {
      const { app, select } = fixture([], actor);
      expect((await request(app).get(path)).status).toBe(403);
      expect(select).not.toHaveBeenCalled();
    }
  });
  it("does not turn a database read failure into absence", async () => {
    const { app, select } = fixture([]);
    select.mockImplementationOnce(() => {
      throw new Error("Read failed");
    });
    const response = await request(app).get(path);
    expect(response.status).toBe(500);
    expect(response.body).not.toHaveProperty("analysis");
  });
});
