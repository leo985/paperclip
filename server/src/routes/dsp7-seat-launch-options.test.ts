import express from "express";
import request from "supertest";
import { describe, expect, it } from "vitest";
import type { Db } from "@paperclipai/db";
import { dsp7SeatControlRoutes } from "./dsp7-seat-control.js";
import { errorHandler } from "../middleware/error-handler.js";

const companyId = "c7bcc01e-0741-4dca-8ff6-825e25f706da";
const id = "a8661763-c814-4116-bee6-70ef4025e727";
const machineId = "bc4998cb-b33f-43d1-8fb7-52e397b7dfab";
function fixture({ userId = "owner", type = "board", company = companyId, capability = true, changedOwner = false } = {}) {
  const agent = { id, companyId, adapterConfig: { dsp7WebJiraIntake: true, dsp7Seat: { ownerUserId: "owner", machineId, machineFingerprint: "a".repeat(64) }, dsp7SeatPresence: { capabilities: capability ? ["seat-launch-options-v1"] : [] } } };
  const events: any[] = []; let locked = false;
  const db = {
    select: () => {
      const chain: any = { from: () => chain, where: () => chain, for: () => { locked = true; return chain; }, then: (ok: any) => Promise.resolve([{ ...agent, adapterConfig: { ...agent.adapterConfig, dsp7Seat: { ...agent.adapterConfig.dsp7Seat, ownerUserId: locked && changedOwner ? "new-owner" : "owner" } } }]).then(ok) }; return chain;
    },
    update: () => ({ set: (value: any) => ({ where: async () => Object.assign(agent, value) }) }),
    insert: () => ({ values: async (value: any) => { events.push(value); } }),
    transaction: async (fn: any) => fn(db),
  };
  const app = express(); app.use(express.json());
  app.use((req, _res, next) => {
    req.actor = { type, userId, source: type === "agent" ? "agent_key" : "session", agentId: id, companyId: company, companyIds: [company], memberships: [{ companyId: company, status: "active", membershipRole: "operator" }] } as typeof req.actor; next();
  });
  app.use(dsp7SeatControlRoutes(db as unknown as Db)); app.use(errorHandler);
  return { app, agent, events };
}
const url = `/companies/${companyId}/dsp7-seats/${id}/launch-options`;
describe("seat launch configuration routes", () => {
  it("persists only a separate seat setting with revision and audit", async () => {
    const { app, agent, events } = fixture();
    const saved = await request(app).put(url).send({ extraArgs: ["--dangerously-skip-permissions"] });
    expect(saved.status).toBe(200); expect(saved.body).toEqual({ configured: true, extraArgs: ["--dangerously-skip-permissions"], revision: 1 });
    expect(agent.adapterConfig.dsp7Seat.ownerUserId).toBe("owner");
    expect(events[0].action).toBe("dsp7.seat.launch_options.updated");
    expect((await request(app).put(url).send({ extraArgs: [] })).body.revision).toBe(2);
  });
  it("enforces company and owner authorization including a change under the row lock", async () => {
    for (const options of [{ userId: "other" }, { company: "other-company" }, { changedOwner: true }]) {
      const { app, events } = fixture(options);
      expect((await request(app).put(url).send({ extraArgs: [] })).status).toBe(403);
      expect(events).toEqual([]);
    }
  });
  it("rejects old clients and reserved protocol arguments", async () => {
    expect((await request(fixture({ capability: false }).app).put(url).send({ extraArgs: [] })).status).toBe(409);
    expect((await request(fixture().app).put(url).send({ extraArgs: ["--session-id", "foreign"] })).status).toBe(400);
  });
  it("resolves settings only for the registered machine", async () => {
    const { app } = fixture({ type: "agent" });
    const body = { seat_id: id, machine_id: machineId, machine_fingerprint: "a".repeat(64) };
    const path = `/agents/${id}/dsp7-seat-launch-options`;
    expect((await request(app).post(path).send(body)).body).toEqual({ configured: false, extraArgs: [], revision: 0 });
    expect((await request(app).post(path).send({ ...body, machine_fingerprint: "b".repeat(64) })).status).toBe(403);
    expect((await request(fixture().app).post(path).send(body)).status).toBe(403);
  });
});
