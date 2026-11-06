import express from "express";
import request from "supertest";
import { describe, expect, it } from "vitest";
import type { Db } from "@paperclipai/db";
import { commandState, dsp7SeatControlRoutes } from "./dsp7-seat-control.js";
import { errorHandler } from "../middleware/error-handler.js";

const companyId = "c7bcc01e-0741-4dca-8ff6-825e25f706da";
const id = "a8661763-c814-4116-bee6-70ef4025e727";
const machineId = "bc4998cb-b33f-43d1-8fb7-52e397b7dfab";
function fixture({ userId = "owner", type = "board", company = companyId, capability = true, changedOwner = false } = {}) {
  const agent = { id, companyId, runtimeConfig: {}, adapterConfig: { dsp7Transport: "outbound", dsp7WebJiraIntake: true, dsp7Seat: { ownerUserId: "owner", machineId, machineFingerprint: "a".repeat(64) }, dsp7SeatPresence: { capabilities: capability ? ["seat-concurrency-v1"] : [] } } };
  const events: any[] = []; let locked = false;
  const db = {
    select: () => {
      const chain: any = { from: () => chain, where: () => chain, for: () => { locked = true; return chain; }, then: (ok: any) => Promise.resolve([{ ...agent, adapterConfig: { ...agent.adapterConfig, dsp7Seat: { ...agent.adapterConfig.dsp7Seat, ownerUserId: locked && changedOwner ? "new-owner" : "owner" } } }]).then(ok) }; return chain;
    },
    update: () => ({ set: (value: any) => ({ where: async () => Object.assign(agent, value) }) }),
    insert: () => ({ values: async (value: any) => { events.push(value); } }),
    execute: async () => undefined,
    transaction: async (fn: any) => fn(db),
  };
  const app = express(); app.use(express.json());
  app.use((req, _res, next) => {
    req.actor = { type, userId, source: type === "agent" ? "agent_key" : "session", agentId: id, companyId: company, companyIds: [company], memberships: [{ companyId: company, status: "active", membershipRole: "operator" }] } as typeof req.actor; next();
  });
  app.use(dsp7SeatControlRoutes(db as unknown as Db)); app.use(errorHandler);
  return { app, agent, events };
}
const url = `/companies/${companyId}/dsp7-seats/${id}/concurrency`;
describe("per-seat concurrency settings", () => {
  it("saves an independently scoped limit and audit", async () => {
    const { app, agent, events } = fixture();
    const saved = await request(app).put(url).send({ maxConcurrentRuns: 3 });
    expect(saved.status).toBe(200); expect(saved.body).toEqual({ maxConcurrentRuns: 3 });
    expect((agent as any).runtimeConfig.heartbeat.maxConcurrentRuns).toBe(3);
    expect(events[0]).toMatchObject({ companyId, agentId: id, action: "dsp7.seat.concurrency.updated", details: { previous: 1, maxConcurrentRuns: 3 } });
    expect((await request(app).put(url).send({ maxConcurrentRuns: 1 })).status).toBe(200);
  });
  it("rechecks ownership under lock and enforces company boundaries", async () => {
    for (const options of [{ userId: "other" }, { company: "other-company" }, { changedOwner: true }]) {
      const { app, events } = fixture(options);
      expect((await request(app).put(url).send({ maxConcurrentRuns: 2 })).status).toBe(403); expect(events).toEqual([]);
    }
  });
  it("rejects invalid limits and old clients without enabling parallel execution", async () => {
    for (const count of [0, 51, 2.5, "2"]) expect((await request(fixture().app).put(url).send({ maxConcurrentRuns: count })).status).toBe(400);
    expect((await request(fixture({ capability: false }).app).put(url).send({ maxConcurrentRuns: 2 })).status).toBe(409);
    expect((await request(fixture({ capability: false }).app).put(url).send({ maxConcurrentRuns: 1 })).status).toBe(200);
  });
});

describe("seat queue deadlines", () => {
  it("retains waiting starts and starts confirmation timeout when delivered", () => {
    const now = Date.now();
    const start = { commandId: id, kind: "start", expiresAt: new Date(now - 60_000).toISOString() };
    expect(commandState(start, [], now).status).toBe("queued");
    const events = [{ details: { commandId: id, sequence: 1, status: "awaiting_local", expiresAt: new Date(now + 900_000).toISOString() } }];
    expect(commandState(start, events, now).status).toBe("awaiting_local");
    expect(commandState(start, events, now + 900_001).status).toBe("expired");
    expect(commandState({ ...start, kind: "check" }, [], now).status).toBe("expired");
  });
});
