import { z } from "zod";

export const HARNESS_OBSERVATION_CAPABILITY = "harness.observation/1";
const id = z.string().regex(/^[a-zA-Z0-9_-]{1,128}$/);
const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
/** Private, bounded observation only. Never an execution or delivery receipt. */
export const harnessObservationSchema = z.object({
  schema: z.literal("harness.v2.observation-summary/1"),
  runId: z.string().uuid(), companyId: z.string().uuid(), taskId: z.string().uuid(),
  streamId: id,
  sourceDigest: z.string().regex(/^[a-f0-9]{64}$/),
  resourceDigest: z.string().regex(/^[a-f0-9]{64}$/),
  observedEvents: count.min(1).max(512), droppedEvents: count,
  observedSessionEnd: z.boolean(), pendingObservedCalls: count.max(512),
  hostSessionConfirmed: z.literal(false), processExitConfirmed: z.literal(false),
  platformAccepted: z.literal(false), durationMinutes: z.null(),
}).strict().refine(v => v.pendingObservedCalls <= v.observedEvents &&
  (v.droppedEvents === 0 || v.observedEvents === 512), "Invalid coverage");
export type HarnessObservation = z.infer<typeof harnessObservationSchema>;
export function parseBoundHarnessObservation(value: unknown, scope: { runId: string; companyId: string; taskId: string }, stream: string) {
  const parsed = harnessObservationSchema.parse(value);
  if (parsed.runId !== scope.runId || parsed.companyId !== scope.companyId ||
      parsed.taskId !== scope.taskId || stream !== `harness:${parsed.streamId}`) {
    throw new Error("Harness observation scope mismatch");
  }
  return parsed;
}
