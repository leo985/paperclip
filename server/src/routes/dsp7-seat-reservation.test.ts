import express from "express";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";
import type { Db } from "@paperclipai/db";

vi.mock("./dsp7-seat-control.js", async () => {
  const { Router } = await import("express");
  return { dsp7SeatControlRoutes: () => Router(), defaultSeatPolicy: {}, isSeatOnline: () => false };
});

import { dsp7SeatRoutes } from "./dsp7-seats.js";
import { errorHandler } from "../middleware/error-handler.js";

const companyId = "11111111-1111-4111-8111-111111111111";
const seatId = "22222222-2222-4222-8222-222222222222";
const identity = {
  seat_id: seatId,
  machine_id: "33333333-3333-4333-8333-333333333333",
  machine_fingerprint: "a".repeat(64),
};

function appFor(taskCompanyId: string | null, description?: string) {
  const select = vi.fn();
  select.mockImplementationOnce(() => ({
    from: () => ({ where: async () => taskCompanyId ? [{ companyId: taskCompanyId, description }] : [] }),
  }));
  select.mockImplementationOnce(() => ({ from: () => ({ where: async () => [] }) }));
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.actor = { type: "agent", source: "agent_key", agentId: seatId, companyId };
    next();
  });
  app.use(dsp7SeatRoutes({ select } as unknown as Db));
  app.post("/issues/:id/checkout", (_req, res) => res.status(404).json({ error: "Issue not found" }));
  app.use(errorHandler);
  return { app, select };
}

describe("seat reservation company boundary", () => {
  it("returns identical not-found responses for missing and cross-company tasks before looking up a seat", async () => {
    const missing = appFor(null);
    const foreign = appFor("44444444-4444-4444-8444-444444444444");
    const absent = await request(missing.app).post("/issues/task/dsp7-reservation").send(identity);
    const hidden = await request(foreign.app).post("/issues/task/dsp7-reservation").send(identity);
    expect(absent.status).toBe(404);
    expect(hidden.status).toBe(404);
    expect(hidden.body).toEqual(absent.body);
    expect(hidden.body).toEqual({ error: "Task not found" });
    expect(missing.select).toHaveBeenCalledTimes(1);
    expect(foreign.select).toHaveBeenCalledTimes(1);
  });

  it("continues to validate the registered machine for a same-company task", async () => {
    const { app, select } = appFor(companyId);
    const response = await request(app).post("/issues/task/dsp7-reservation").send(identity);
    expect(response.status).toBe(403);
    expect(select).toHaveBeenCalledTimes(2);
  });

  it("hides cross-company checkout metadata before parsing even an invalid intake", async () => {
    const foreign = appFor("44444444-4444-4444-8444-444444444444", "<!-- DSP7-JIRA-INTAKE invalid-json -->");
    const missing = appFor(null);
    const hidden = await request(foreign.app).post("/issues/task/checkout").send({ agentId: seatId });
    const absent = await request(missing.app).post("/issues/task/checkout").send({ agentId: seatId });
    expect(hidden.status).toBe(404);
    expect(hidden.body).toEqual(absent.body);
    expect(foreign.select).toHaveBeenCalledTimes(1);
    const own = appFor(companyId, "<!-- DSP7-JIRA-INTAKE invalid-json -->");
    expect((await request(own.app).post("/issues/task/checkout").send({ agentId: seatId })).status).toBe(409);
  });
});
