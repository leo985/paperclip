import { describe, expect, it } from "vitest";
import { DEFAULT_SEAT_WORK_SCHEDULE as schedule, seatWorkScheduleSchema } from "@paperclipai/shared";
import { seatOnlineIntervals, worktimeFor } from "./seat-worktime.js";

const at = (value: string) => Date.parse(`${value}+08:00`);
const interval = (start: string, end: string) => ({ start: at(start), end: at(end) });
const monday = at("2026-10-19T00:00:00"), tuesday = at("2026-10-20T00:00:00");
const HOUR = 3_600_000;

describe("seat work-time connectivity", () => {
  it("excludes lunch and nights from a full day of connectivity", () => {
    expect(worktimeFor([{ start: monday, end: tuesday }], schedule, monday, tuesday))
      .toEqual({ onlineMs: 8 * HOUR, onlineGaps: [] });
  });
  it("excludes weekends and supports configured working days", () => {
    const from = at("2026-10-24T00:00:00"), to = at("2026-10-25T00:00:00");
    expect(worktimeFor([{ start: from, end: to }], schedule, from, to)).toEqual({ onlineMs: 0, onlineGaps: [] });
    expect(worktimeFor([{ start: from, end: to }], { days: [6], periods: [{ start: "10:00", end: "11:30" }] }, from, to).onlineMs).toBe(1.5 * HOUR);
  });
  it("stops at the current time and does not count time before activation", () => {
    const from = at("2026-10-19T10:00:00"), now = at("2026-10-19T11:00:00");
    expect(worktimeFor([{ start: monday, end: tuesday }], schedule, from, now))
      .toEqual({ onlineMs: HOUR, onlineGaps: [] });
    expect(worktimeFor([], schedule, tuesday, monday)).toEqual({ onlineMs: 0, onlineGaps: [] });
  });
  it("takes the union across devices and duplicate heartbeat ranges", () => {
    const online = [interval("2026-10-19T09:00:00", "2026-10-19T11:00:00"), interval("2026-10-19T10:00:00", "2026-10-19T12:00:00")];
    expect(worktimeFor([...online, ...online], schedule, monday, at("2026-10-19T12:00:00")))
      .toEqual({ onlineMs: 3 * HOUR, onlineGaps: [] });
  });
  it("reports uncovered working ranges without manufacturing offline time", () => {
    const result = worktimeFor([interval("2026-10-19T10:00:00", "2026-10-19T11:00:00")], schedule, monday, at("2026-10-19T12:00:00"));
    expect(result).toEqual({ onlineMs: HOUR, onlineGaps: [
      { from: new Date(at("2026-10-19T09:00:00")).toISOString(), to: new Date(at("2026-10-19T10:00:00")).toISOString() },
      { from: new Date(at("2026-10-19T11:00:00")).toISOString(), to: new Date(at("2026-10-19T12:00:00")).toISOString() },
    ] });
    expect(worktimeFor([], schedule, monday, tuesday).onlineGaps).toHaveLength(2);
  });
  it("expires heartbeats after 90 seconds and does not bridge a disconnect", () => {
    const sample = (time: string) => ({ at: new Date(at(time)), through: new Date(at(time)), ownerUserId: "owner" });
    const intervals = seatOnlineIntervals([sample("2026-10-19T09:10:00"), sample("2026-10-19T09:00:00")], "owner", tuesday);
    expect(intervals).toEqual([
      interval("2026-10-19T09:00:00", "2026-10-19T09:01:30"),
      interval("2026-10-19T09:10:00", "2026-10-19T09:11:30"),
    ]);
    expect(worktimeFor(intervals, schedule, monday, tuesday).onlineMs).toBe(180_000);
  });
  it("clips compressed spans and ownership handoffs at the next observation", () => {
    const samples = [
      { at: new Date(at("2026-10-19T09:00:00")), through: new Date(at("2026-10-19T10:00:00")), ownerUserId: "old" },
      { at: new Date(at("2026-10-19T10:00:20")), through: new Date(at("2026-10-19T11:00:00")), ownerUserId: "new" },
    ];
    expect(seatOnlineIntervals(samples, "old", tuesday)).toEqual([interval("2026-10-19T09:00:00", "2026-10-19T10:00:20")]);
    expect(seatOnlineIntervals(samples, "new", at("2026-10-19T10:30:00"))).toEqual([interval("2026-10-19T10:00:20", "2026-10-19T10:30:00")]);
  });
  it("uses Shanghai dates across UTC midnight and a year boundary", () => {
    const from = at("2026-12-31T00:00:00"), to = at("2027-01-02T00:00:00");
    expect(worktimeFor([{ start: from, end: to }], schedule, from, to).onlineMs).toBe(16 * HOUR);
  });
});

describe("work schedule validation", () => {
  it("accepts split shifts and rejects empty, duplicate, overlapping or cross-day rules", () => {
    expect(seatWorkScheduleSchema.safeParse(schedule).success).toBe(true);
    for (const invalid of [
      { ...schedule, days: [] }, { ...schedule, days: [1, 1] }, { ...schedule, days: [0] },
      { ...schedule, periods: [] },
      { ...schedule, periods: [{ start: "12:00", end: "09:00" }] },
      { ...schedule, periods: [{ start: "09:00", end: "12:00" }, { start: "11:00", end: "13:00" }] },
      { ...schedule, periods: [{ start: "25:00", end: "26:00" }] },
      { ...schedule, periods: [{ start: "9:00", end: "12:00" }] },
    ]) expect(seatWorkScheduleSchema.safeParse(invalid).success).toBe(false);
  });
});
