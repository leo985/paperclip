import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Db } from "@paperclipai/db";
import { dsp7JiraDispatchRoutes } from "./dsp7-jira-dispatch.js";
const mocks = vi.hoisted(() => ({ reason: vi.fn(), acknowledge: vi.fn() }));
vi.mock("../services/seat-startup-retry.js", () => ({ startupRetryBlockedReason: mocks.reason }));
vi.mock("../services/seat-execution-stop.js", () => ({ acknowledgeStoppedSeatConversation: mocks.acknowledge, hasSeatStopIntent: vi.fn() }));
vi.mock("../services/delivery-admission.js", () => ({ assertDeliveryCodingAdmission: async () => {} }));
vi.mock("./dsp7-seat-owners.js", () => ({ canConfigureSeat: () => true, isSeatManager: () => true }));
vi.mock("./jira-intake-sync.js", () => ({ jiraIntakeSyncRoutes: () => express.Router(), syncJiraIntake: async () => ({ eligible: true, ruleRevision: 1 }) }));
const id = "87ed3723-6fff-40b8-ab01-d0183580686d", taskId = "37f4f46e-de05-4164-9e14-39d2abe4eb48";
const intake = { version: 3, status_source: "seat_rule", seat_id: id, jira_key: "ATSES-491887", project_id: "project" };
const agent: any = { id, companyId: "company", adapterConfig: { dsp7Seat: {}, dsp7JiraDispatch: { revision: 1, enabled: true, jiraSecretId: "secret", readyStatuses: ["待受理"], jiraProjectKey: "ATSES", projectId: "project", ownerUserId: "owner" }, dsp7SeatPresence: { capabilities: ["platform-dispatch-v1"], tasks: [{ taskId, stoppedRunId: "old-run" }] } } };
function fixture(status = "in_progress", previous?: any) {
  const task: any = { id: taskId, companyId: "company", projectId: "project", status, assigneeAgentId: id, createdByUserId: "owner", description: `<!-- DSP7-JIRA-INTAKE ${JSON.stringify(intake)} -->` };
  const rows = [[task], [agent], [task], [{ entityId: "command" }], [{ details: { status: "failed" } }], [], previous ? [previous] : []];
  const updates: any[] = [], events: any[] = [];
  const db: any = { execute: async () => {}, transaction: (fn: any) => fn(db), select: () => { const result = rows.shift(); if (!result) throw new Error("Unexpected query"); const chain: any = { then: (ok: any, no: any) => Promise.resolve(result).then(ok, no) }; for (const key of ["from", "where", "for", "limit", "orderBy"]) chain[key] = () => chain; return chain; }, update: () => ({ set: (value: any) => ({ where: async () => updates.push(value) }) }), insert: () => ({ values: (value: any) => { events.push(value); return { returning: async () => [{ id: "new-authorization" }] }; } }) };
  const enqueue = vi.fn(async (..._args: any[]) => ({ commandId: "new-command" }));
  const app = express(); app.use(express.json()); app.use((req: any, _res, next) => { req.actor = { userId: "owner" }; next(); });
  app.use(dsp7JiraDispatchRoutes(db as Db, async () => agent, async () => agent, enqueue));
  app.use((err: any, _req: any, res: any, _next: any) => res.status(err.status ?? 500).json({ error: err.message }));
  return { app, updates, events, enqueue };
}
const url = `/companies/company/dsp7-seats/${id}/platform-dispatch`;
beforeEach(() => { mocks.reason.mockReset().mockResolvedValue(null); mocks.acknowledge.mockReset().mockResolvedValue(undefined); });
describe("startup retry dispatch transaction", () => {
  it("acknowledges stopped execution before resetting a stale in_progress task and enqueueing one fresh start", async () => {
    const f = fixture(); const response = await request(f.app).post(url).send({ taskId });
    expect(response.status).toBe(200);
    expect(mocks.acknowledge).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ runId: "old-run", actorId: "owner" }));
    expect(f.updates).toEqual([expect.objectContaining({ status: "backlog" })]);
    expect(f.enqueue).toHaveBeenCalledTimes(1); expect(f.enqueue.mock.calls[0]?.[2]).toMatchObject({ status: "backlog" });
    expect(f.events[0].details.startupRecovery).toBe(true);
  });
  it("allows a fresh dispatch after the previous dispatch was cancelled", async () => {
    const f = fixture("backlog", { details: { state: "cancelled" } });
    const response = await request(f.app).post(url).send({ taskId });
    expect(response.status).toBe(200); expect(f.enqueue).toHaveBeenCalledTimes(1);
    expect(mocks.reason).not.toHaveBeenCalled(); expect(mocks.acknowledge).not.toHaveBeenCalled();
  });
  it("rejects active execution without changing status or enqueueing", async () => {
    mocks.reason.mockResolvedValue("工单仍有活动运行，不能重复启动");
    const f = fixture(); const response = await request(f.app).post(url).send({ taskId });
    expect(response.status).toBe(409); expect(response.body.error).toContain("活动运行");
    expect(f.updates).toEqual([]); expect(f.enqueue).not.toHaveBeenCalled(); expect(mocks.acknowledge).not.toHaveBeenCalled();
  });
  it("retains execution protection when stopped-session acknowledgement fails", async () => {
    mocks.acknowledge.mockRejectedValue(Object.assign(new Error("旧执行仍有控制器"), { status: 409 }));
    const f = fixture(); const response = await request(f.app).post(url).send({ taskId });
    expect(response.status).toBe(409); expect(f.updates).toEqual([]); expect(f.enqueue).not.toHaveBeenCalled();
  });
});
