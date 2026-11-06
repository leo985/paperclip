import { z } from "zod";

export const SEAT_MAX_CONCURRENT_RUNS = 50;
export const SEAT_CONCURRENCY_CAPABILITY = "seat-concurrency-v1";
export const seatConcurrencySchema = z.object({ maxConcurrentRuns: z.number().int().min(1).max(SEAT_MAX_CONCURRENT_RUNS) }).strict();

/** Seat defaults differ from general agents. Older bridges remain serial. */
export function seatConcurrencyLimit(agent: { adapterConfig: Record<string, unknown>; runtimeConfig?: Record<string, unknown> | null }): number {
  const presence = agent.adapterConfig.dsp7SeatPresence as { capabilities?: string[] } | undefined;
  if (agent.adapterConfig.dsp7Transport !== "outbound" || !presence?.capabilities?.includes(SEAT_CONCURRENCY_CAPABILITY)) return 1;
  const heartbeat = agent.runtimeConfig?.heartbeat as Record<string, unknown> | undefined;
  const value = heartbeat?.maxConcurrentRuns;
  return typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= SEAT_MAX_CONCURRENT_RUNS ? value : 1;
}
export function seatCanAcceptWork(presence: { state?: unknown; acceptingWork?: unknown } | null | undefined): boolean {
  return !!presence && presence.acceptingWork !== false && ["idle", "busy", "waiting_decision", "awaiting_local"].includes(String(presence.state));
}
