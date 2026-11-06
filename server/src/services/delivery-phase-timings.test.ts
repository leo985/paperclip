import { expect, it } from "vitest";
import { deliveryPhaseTimings } from "./delivery-phase-timings.js";
const origin = Date.parse("2026-10-30T00:00:00Z");
const at = (ms: number) => new Date(origin + ms).toISOString();
const session = { id: "s", startedAt: new Date(origin), endedAt: new Date(origin + 10_000) };
const event = (ms: number, eventType: string, payload: Record<string, unknown>) => ({ id: String(ms), sessionId: "s", occurredAt: at(ms), observedAt: at(ms), eventType, payload });
it("clips phase boundaries and preserves unknown phase and unknown execution coverage", () => {
  const events = [event(2_000, "phase", { phase: "Design", status: "started" }), event(5_000, "phase", { phase: "Review", status: "started" })];
  const result = deliveryPhaseTimings([session], events, origin + 1_000, origin + 9_000, origin + 20_000);
  expect(result.map(row => [row.name, row.unknownMs])).toEqual([[null, 1_000], ["Design", 3_000], ["Review", 4_000]]);
  expect(result.every(row => row.tokenAttribution === "unavailable")).toBe(true);
  expect(result.every(row => row.executingMs === 0 && row.waitingMs === 0)).toBe(true);
});
it("ignores future and foreign-session phases and retains pre-window phase context", () => {
  const events = [event(2_000, "phase", { phase: "Design" }), { ...event(3_000, "phase", { phase: "Foreign" }), sessionId: "other" }, event(20_000, "phase", { phase: "Future" })];
  expect(deliveryPhaseTimings([session], events, origin + 4_000, origin + 8_000, origin + 10_000)).toEqual([{ name: "Design", executingMs: 0, waitingMs: 0, unknownMs: 4_000, tokenAttribution: "unavailable" }]);
});
it("attributes observed execution and waiting across phase changes without guessing tokens", () => {
  const events = [event(0, "execution", { state: "executing" }), event(2_000, "phase", { phase: "Design" }), event(4_000, "execution", { state: "waiting" }), event(6_000, "phase", { phase: "Review" })];
  expect(deliveryPhaseTimings([session], events, origin, origin + 10_000, origin + 10_000)).toEqual([
    { name: null, executingMs: 2_000, waitingMs: 0, unknownMs: 0, tokenAttribution: "unavailable" },
    { name: "Design", executingMs: 2_000, waitingMs: 2_000, unknownMs: 0, tokenAttribution: "unavailable" },
    { name: "Review", executingMs: 0, waitingMs: 4_000, unknownMs: 0, tokenAttribution: "unavailable" },
  ]);
});
