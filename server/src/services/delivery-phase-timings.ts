import type { DeliveryPhaseTiming, ManagedTimelineEvent } from "@paperclipai/shared";
import { executionIntervals, unionMs } from "./managed-sessions.js";

/** Phase boundaries come from observed phase events; no token apportioning by time. */
export function deliveryPhaseTimings(
  sessions: { id: string; startedAt: Date; endedAt: Date | null }[],
  events: (ManagedTimelineEvent & { sessionId: string })[],
  from: number, to: number, now: number,
): DeliveryPhaseTiming[] {
  const groups = new Map<string | null, { start: number; end: number; state: string }[]>();
  for (const session of sessions) {
    const own = events.filter(event => event.sessionId === session.id && Date.parse(event.occurredAt) <= now);
    const phases = own.filter(event => event.eventType === "phase" && typeof event.payload.phase === "string" && event.payload.phase.trim()).sort((a, b) => Date.parse(a.occurredAt) - Date.parse(b.occurredAt) || a.id.localeCompare(b.id));
    let phaseIndex = -1;
    for (const interval of executionIntervals(session, own, now)) {
      const start = Math.max(from, interval.start), end = Math.min(to, now, interval.end);
      if (end <= start) continue;
      while (phaseIndex + 1 < phases.length && Date.parse(phases[phaseIndex + 1].occurredAt) <= start) phaseIndex++;
      let position = start;
      while (position < end) {
        const next = phaseIndex + 1 < phases.length ? Date.parse(phases[phaseIndex + 1].occurredAt) : Infinity;
        const until = Math.min(end, next);
        const name = phaseIndex >= 0 ? String(phases[phaseIndex].payload.phase) : null;
        const parts = groups.get(name) ?? [];
        if (until > position) parts.push({ start: position, end: until, state: interval.state });
        groups.set(name, parts); position = until;
        if (next <= end) phaseIndex++;
      }
    }
  }
  return [...groups].map(([name, parts]) => {
    const busy = parts.filter(part => part.state === "executing"), waiting = parts.filter(part => part.state === "waiting");
    const executingMs = unionMs(busy, from, to);
    const overlap = waiting.flatMap(w => busy.map(b => ({ start: Math.max(w.start, b.start), end: Math.min(w.end, b.end) })));
    const waitingMs = Math.max(0, unionMs(waiting, from, to) - unionMs(overlap, from, to));
    return { name, executingMs, waitingMs, unknownMs: Math.max(0, unionMs(parts, from, to) - executingMs - waitingMs), tokenAttribution: "unavailable" as const };
  });
}
