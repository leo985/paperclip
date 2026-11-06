import { z } from "zod";
const uuid = z.string().uuid(),
  hash = z.string().regex(/^[a-f0-9]{64}$/);
export const analysisCreateSchema = z
  .object({
    requestId: uuid,
    projectId: uuid,
    seatId: uuid,
    title: z.string().trim().min(1).max(300),
    brief: z.string().trim().min(10).max(20000),
    demandNo: z.string().trim().max(100).optional(),
    supersedesId: uuid.optional(),
  })
  .strict();
export const analysisSnapshotSchema = z
  .object({
    protocolVersion: z.literal(1),
    binding: z
      .object({
        protocolVersion: z.literal(1),
        companyId: uuid,
        taskId: uuid,
        revision: z.number().int().positive(),
        nativeId: z.string().regex(/^pc-[a-f0-9-]{36}-r\d+$/),
        profile: z.string().max(64),
        repository: z.string().max(500),
      })
      .strict(),
    phase: z.enum(["P0", "P1", "P2", "P3", "P4"]),
    nativeStatus: z.enum(["in-progress", "completed"]),
    completedPhases: z.array(z.enum(["P0", "P1", "P2", "P3", "P4"])).max(5),
    gateErrors: z.array(z.string().max(500)).max(100),
    localCompleted: z.boolean(),
    formalPublication: z.literal("unverified"),
  })
  .strict();
export const analysisDeliverySchema = analysisSnapshotSchema
  .extend({
    inputDigest: hash,
    handoffDigest: hash,
    artifacts: z
      .array(
        z
          .object({
            path: z.enum([
              "intake.md",
              "evidence.json",
              "requirements.json",
              "analysis.md",
              "review.json",
              "handoff.md",
              "state.json",
            ]),
            sha256: hash,
          })
          .strict(),
      )
      .length(7),
  })
  .strict();
export const analysisQuestionSchema = z
  .object({
    key: z.string().regex(/^[A-Za-z0-9_.-]{1,100}$/),
    kind: z.enum(["question", "review"]),
    text: z.string().trim().min(1).max(4000),
    inputDigest: hash,
    contentDigest: hash,
  })
  .strict();
export type AnalysisSnapshot = z.infer<typeof analysisSnapshotSchema>;
export type AnalysisDelivery = z.infer<typeof analysisDeliverySchema>;
export interface AnalysisExecution {
  id: string;
  companyId: string;
  projectId: string;
  seatId: string;
  ownerUserId: string;
  revision: number;
  supersedesId: string | null;
  title: string;
  brief: string;
  demandNo: string | null;
  state: string;
  dispatchId: string | null;
  activeRunId: string | null;
  capabilityId: string | null;
  registryRevision: number | null;
  snapshot: AnalysisSnapshot | null;
  delivery: AnalysisDelivery | null;
  publication: {
    url: string;
    note: string;
    verifiedBy: string;
    verifiedAt: string;
    method: "manual-attestation";
    inputDigest: string;
    handoffDigest: string;
  } | null;
  createdAt: string;
  updatedAt: string;
}
export interface AnalysisDecision {
  id: string;
  executionId: string;
  runId: string;
  key: string;
  kind: "question" | "review";
  text: string;
  inputDigest: string;
  contentDigest: string;
  status: string;
  answer: string | null;
  answeredBy: string | null;
  answeredAt: string | null;
  ackedAt: string | null;
  createdAt: string;
}
