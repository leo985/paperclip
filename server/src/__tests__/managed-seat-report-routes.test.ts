import express from "express";
import type { Db } from "@paperclipai/db";
import { activityLog, agents, authUsers, managedSeatSamples, managedSeatReportSettings } from "@paperclipai/db";
import { DEFAULT_SEAT_WORK_SCHEDULE } from "@paperclipai/shared";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";
import { managedReportRoutes } from "../routes/managed-session-reports.js";
import { HttpError } from "../errors.js";

const companyId = "10000000-0000-4000-8000-000000000001";
function actor(role = "admin"): Express.Request["actor"] {
  return { type: "board", source: "session", userId: "user", companyIds: [companyId],
    memberships: [{ companyId, membershipRole: role, status: "active" }] } as Express.Request["actor"];
}
function appFor(db: Db, who = actor()) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.actor = who; next(); });
  app.use("/api", managedReportRoutes(db));
  app.use((err: HttpError, _req: express.Request, res: express.Response, _next: express.NextFunction) => res.status(err.status ?? 500).json({ error: err.message }));
  return app;
}
const url = `/api/companies/${companyId}/managed-seat-report/work-schedule`;

describe("seat report work schedule permissions and persistence", () => {
  it("rejects agents, ordinary members and cross-company admins before storage", async () => {
    const db = new Proxy({}, { get() { throw new Error("unexpected DB access"); } }) as Db;
    await request(appFor(db, actor("member"))).put(url).send(DEFAULT_SEAT_WORK_SCHEDULE).expect(403);
    await request(appFor(db, { type: "agent", source: "agent_key", agentId: "agent", companyId })).put(url).send(DEFAULT_SEAT_WORK_SCHEDULE).expect(403);
    await request(appFor(db)).put(url.replace(companyId, "10000000-0000-4000-8000-000000000002")).send(DEFAULT_SEAT_WORK_SCHEDULE).expect(403);
  });
  it("rejects invalid periods before a write", async () => {
    const transaction = vi.fn();
    await request(appFor({ transaction } as unknown as Db)).put(url).send({ days: [1], periods: [{ start: "18:00", end: "09:00" }] }).expect(400);
    expect(transaction).not.toHaveBeenCalled();
  });
  it("saves normalized company settings and audit attribution in one transaction", async () => {
    const writes: Array<{ table: unknown; data: Record<string, unknown> }> = [];
    const insert = vi.fn((table: unknown) => ({ values: (data: Record<string, unknown>) => {
      writes.push({ table, data });
      return { onConflictDoUpdate: vi.fn().mockResolvedValue(undefined) };
    } }));
    const transaction = vi.fn(async callback => callback({ insert }));
    const response = await request(appFor({ transaction } as unknown as Db)).put(url).send({ days: [5, 1], periods: [{ start: "14:00", end: "18:00" }, { start: "09:00", end: "12:00" }] }).expect(200);
    expect(response.body.days).toEqual([1, 5]);
    expect(response.body.periods[0].start).toBe("09:00");
    expect(transaction).toHaveBeenCalledOnce();
    expect(writes[0]).toMatchObject({ table: managedSeatReportSettings, data: { companyId, workSchedule: response.body } });
    expect(writes[1]).toMatchObject({ table: activityLog, data: { companyId, actorId: "user", action: "dsp7.seat.work_schedule.updated" } });
  });
  it("uses the saved schedule and busy heartbeats without deriving connectivity from execution", async () => {
    const now = Date.parse("2026-10-19T04:00:00Z");
    const clock = vi.spyOn(Date, "now").mockReturnValue(now);
    const schedule = { days: [1], periods: [{ start: "10:00", end: "12:00" }] };
    const rows = new Map<unknown, unknown[]>([
      [managedSeatReportSettings, [{ companyId, workSchedule: schedule }]],
      [agents, [{ id: "seat", name: "电脑", createdAt: new Date("2026-10-18T16:00:00Z"), adapterConfig: { dsp7WebJiraIntake: true, dsp7Seat: { ownerUserId: "user" } } }]],
      [authUsers, [{ id: "user", name: "负责人" }]],
      [managedSeatSamples, [{ seatId: "seat", ownerUserId: "user", state: "busy", taskId: "task", backlog: 1, at: new Date("2026-10-19T01:00:00Z"), through: new Date(now) }]],
    ]);
    const db = { select: () => ({ from: (table: unknown) => {
      const query = { where: () => query, orderBy: () => query,
        then: (resolve: (value: unknown[]) => unknown) => Promise.resolve(rows.get(table) ?? []).then(resolve) };
      return query;
    } }) } as unknown as Db;
    try {
      const response = await request(appFor(db)).get(`/api/companies/${companyId}/managed-seat-report?period=day&date=2026-10-19`).expect(200);
      expect(response.body.workSchedule).toEqual(schedule);
      expect(response.body.canConfigureWorkSchedule).toBe(true);
      expect(response.body.seats[0]).toMatchObject({ onlineMs: 7_200_000, onlineGaps: [], executingMs: 0 });
      expect(response.body.people[0]).toMatchObject({ onlineMs: 7_200_000, onlineGaps: [] });
    } finally { clock.mockRestore(); }
  });
});
