import { z } from "zod";
import { harnessObservationSchema } from "./harness-observation.js";

/** Private task conversation data. Never pass these payloads to telemetry/run logs. */
export const MANAGED_SESSION_PROTOCOL = 1;
export const MANAGED_PART_BYTES = 32 * 1024;
export const MANAGED_BATCH_BYTES = 256 * 1024;
export const managedIdentitySchema = z.object({ seat_id: z.string().uuid(), machine_id: z.string().uuid(), machine_fingerprint: z.string().regex(/^[a-f0-9]{64}$/) });
export const managedEventSchema = z.object({
  eventId: z.string().uuid(), streamId: z.string().min(1).max(160), sequence: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  eventType: z.enum(["content.part", "content.manifest", "lifecycle", "coverage", "phase", "execution", "observation", "harness.observation"]),
  occurredAt: z.string().datetime({ offset: true }), observedAt: z.string().datetime({ offset: true }),
  sourceGeneration: z.string().max(160), sourceOffset: z.number().int().nonnegative(), parserVersion: z.literal(1),
  payload: z.record(z.string(), z.unknown()),
}).strict();
export const managedBatchSchema = managedIdentitySchema.extend({ protocolVersion: z.literal(1), events: z.array(managedEventSchema).min(1).max(100) }).strict();
export const managedRegisterSchema = managedIdentitySchema.extend({ protocolVersion: z.literal(1), runId: z.string().uuid(), taskId: z.string().uuid(), nativeSessionId: z.string().uuid() }).strict();
export const managedControlSchema = z.object({ action: z.enum(["pause_upload", "resume_upload", "pause_collection", "resume_collection", "delete"]) }).strict();
export const managedPartSchema = z.object({ contentId: z.string().max(160).min(1), revision: z.string().max(64).min(1), partIndex: z.number().int().min(0).max(50000), data: z.string().max(MANAGED_PART_BYTES), encoding: z.enum(["utf8", "base64"]) }).strict();
export const managedManifestSchema = z.object({
  contentId: z.string().min(1).max(160), revision: z.string().min(1).max(64),
  kind: z.enum(["user", "assistant", "tool_call", "tool_result", "terminal", "attachment", "control", "compaction"]),
  parentStreamId: z.string().max(160).nullable(), messageId: z.string().max(200), toolCallId: z.string().max(200).nullable(),
  name: z.string().max(200).nullable(), mime: z.string().max(150).nullable(),
  parts: z.number().int().min(0).max(50000), bytes: z.number().int().min(0).max(100 * 1024 * 1024), sha256: z.string().regex(/^[a-f0-9]{64}$/),
  redacted: z.boolean(), sourceTruncated: z.boolean(), unavailableReason: z.string().max(500).nullable(),
}).strict();
export type ManagedEvent = z.infer<typeof managedEventSchema>;
export type ManagedManifest = z.infer<typeof managedManifestSchema>;
export interface ManagedSession {
  id: string; companyId: string; taskId: string; seatId: string; runId: string; nativeSessionId: string;
  ownerUserId: string | null; startedAt: string; lastReceivedAt: string; endedAt: string | null;
  coverage: string; syncState: string; collectionPaused: boolean; uploadPaused: boolean;
  deletedAt: string | null; finalizedAt: string | null; lastObservation: Record<string, unknown>;
}
export interface ManagedContent {
  id: string; streamId: string; contentId: string; revision: string; occurredAt: string; sequence: number;
  manifest: ManagedManifest; complete: boolean;
}
export interface ManagedTimelineEvent { id: string; eventType: string; occurredAt: string; observedAt: string; payload: Record<string, unknown>; }
export interface ManagedSessionDetail {
  quality:{observedAt:string;windowDays:number;defects:Array<{key:string;createdAt:string;severity:string}>;source:string}|null;
  health:string; session: ManagedSession; streams: Array<{ streamId: string; ackSequence: number }>;
  phases: ManagedTimelineEvent[]; timing: { executingMs: number; waitingMs: number; unknownMs: number; elapsedMs: number; coverage: number; state: string; since: string | null };
}
export interface SeatPeriodReport {
  timezone: string; from: string; to: string; period: string; simulatedExcluded: boolean;
  workSchedule: SeatWorkSchedule; canConfigureWorkSchedule: boolean;
  seats: Array<{ seatId: string; ownerUserId: string | null; name: string; ownerName: string | null; backlog: number | null; jiraBacklog: number | null; jiraScope: Record<string,unknown> | null; started: number; delivered: number; cancelled: number; executingMs: number; waitingMs: number; idleMs: number; unknownMs: number; coverage: number; defects: number | null; qualityCoverage: number; matureDeliveries: number; defectRate: number | null; matureEligible?:number; affectedMature?:number } & SeatWorktime>;
  people: Array<{ownerUserId:string;name:string;executingMs:number;waitingMs:number;idleMs:number;unknownMs:number} & SeatWorktime>;
  note: string;
}

const workTime = z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/);
export const seatWorkScheduleSchema = z.object({
  days: z.array(z.number().int().min(1).max(7)).min(1).max(7)
    .refine(days => new Set(days).size === days.length, "工作日不能重复"),
  periods: z.array(z.object({ start: workTime, end: workTime }).strict())
    .min(1).max(4)
    .refine(periods => periods.every(p => p.start < p.end), "结束时间须晚于开始时间，跨日请拆分")
    .refine(periods => {
      const sorted = [...periods].sort((a, b) => a.start.localeCompare(b.start));
      return sorted.every((p, i) => i === 0 || p.start >= sorted[i - 1]!.end);
    }, "工作时段不能重叠"),
}).strict();
export type SeatWorkSchedule = z.infer<typeof seatWorkScheduleSchema>;
export const DEFAULT_SEAT_WORK_SCHEDULE: SeatWorkSchedule = {
  days: [1, 2, 3, 4, 5],
  periods: [{ start: "09:00", end: "12:00" }, { start: "13:00", end: "18:00" }],
};
export interface SeatWorktime {
  onlineMs: number;
  /** Work-time ranges without heartbeat evidence; never inferred to be offline. */
  onlineGaps: Array<{ from: string; to: string }>;
}

/** Closed metadata contracts prevent arbitrary conversation copies in phase/status rows. */
export const managedMetadataSchemas = {
  "harness.observation": harnessObservationSchema,
  lifecycle: z.object({state:z.enum(["started","exited"]),policy:z.string().max(80).optional(),boundary:z.string().max(100).optional()}).strict(),
  coverage: z.object({reason:z.string().max(500),source:z.string().max(160)}).strict(),
  phase: z.object({phase:z.string().min(1).max(100),status:z.enum(["started","passed","failed","reopened","skipped","observed"]),source:z.string().max(100).optional(),evidence:z.union([z.string().max(2000),z.array(z.object({script:z.string().max(500),scriptSha256:z.string().regex(/^[a-f0-9]{64}$/),exitCode:z.number().int()}).strict()).max(100)]).nullable().optional(),gateVersion:z.string().max(160).nullable().optional(),flowVersion:z.string().max(160).nullable().optional(),note:z.string().max(500).optional()}).strict(),
  execution: z.object({state:z.enum(["executing","waiting","unknown"]),source:z.string().max(120).nullable().optional(),monotonic:z.number().finite().nullable().optional(),engagementId:z.union([z.string().max(160),z.number()]).nullable().optional()}).strict(),
  observation: z.object({queuedBytes:z.number().int().nonnegative(),policy:z.string().max(80),sourceFiles:z.number().int().nonnegative(),queueWarning:z.boolean(),waitingResume:z.boolean()}).strict(),
};
