import type { SeatWorkSchedule, SeatWorktime } from "@paperclipai/shared";

export type TimeInterval = { start: number; end: number };
const DAY = 86_400_000;
const SHANGHAI_OFFSET = 8 * 3_600_000;
export const SEAT_HEARTBEAT_TTL = 90_000;

/** Every accepted seat heartbeat proves connectivity, regardless of task/intake state. */
export function seatOnlineIntervals(
  samples: Array<{ at: Date; through: Date; ownerUserId: string | null }>,
  ownerUserId: string | null,
  now: number,
): TimeInterval[] {
  const ordered = [...samples].sort((a, b) => a.at.getTime() - b.at.getTime());
  return ordered.flatMap((sample, index) => {
    if (sample.ownerUserId !== ownerUserId) return [];
    const start = sample.at.getTime();
    const end = Math.min(sample.through.getTime() + SEAT_HEARTBEAT_TTL, ordered[index + 1]?.at.getTime() ?? now, now);
    return end > start ? [{ start, end }] : [];
  });
}

/** Fixed Asia/Shanghai windows. Day numbers are ISO weekdays (Monday=1, Sunday=7). */
export function workIntervals(schedule: SeatWorkSchedule, from: number, to: number): TimeInterval[] {
  const windows: TimeInterval[] = [];
  const minuteOfDay = (value: string) => {
    const [hour, minute] = value.split(":").map(Number);
    return (hour! * 60 + minute!) * 60_000;
  };
  for (let day = Math.floor((from + SHANGHAI_OFFSET) / DAY) * DAY - SHANGHAI_OFFSET; day < to; day += DAY) {
    const weekday = new Date(day + SHANGHAI_OFFSET).getUTCDay() || 7;
    if (!schedule.days.includes(weekday)) continue;
    for (const period of schedule.periods) {
      const start = Math.max(from, day + minuteOfDay(period.start));
      const end = Math.min(to, day + minuteOfDay(period.end));
      if (end > start) windows.push({ start, end });
    }
  }
  return windows.sort((a, b) => a.start - b.start);
}

export function worktimeFor(online: TimeInterval[], schedule: SeatWorkSchedule, from: number, to: number): SeatWorktime {
  const merged: TimeInterval[] = [];
  for (const interval of [...online].filter(i => i.end > i.start).sort((a, b) => a.start - b.start)) {
    const last = merged.at(-1);
    if (last && interval.start <= last.end) last.end = Math.max(last.end, interval.end);
    else merged.push({ ...interval });
  }
  let onlineMs = 0;
  let first = 0;
  const gaps: TimeInterval[] = [];
  for (const window of workIntervals(schedule, from, to)) {
    let cursor = window.start;
    while (first < merged.length && merged[first]!.end <= window.start) first++;
    for (let index = first; index < merged.length; index++) {
      const interval = merged[index]!;
      if (interval.end <= cursor) continue;
      if (interval.start >= window.end) break;
      const start = Math.max(cursor, interval.start), end = Math.min(window.end, interval.end);
      if (start > cursor) gaps.push({ start: cursor, end: start });
      onlineMs += end - start;
      cursor = end;
    }
    if (cursor < window.end) gaps.push({ start: cursor, end: window.end });
  }
  return { onlineMs, onlineGaps: gaps.map(gap => ({ from: new Date(gap.start).toISOString(), to: new Date(gap.end).toISOString() })) };
}
