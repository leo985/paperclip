import { z } from "zod";
const uuid = z.string().uuid(),
  hash = z.string().regex(/^[a-f0-9]{64}$/);
export const analysisQingzhouOptionsSchema = z.object({
  workGenerality: z.enum(["1", "2"]).optional(),
  workHour: z.string().regex(/^\d+(\.\d{1,2})?$/).refine(v => Number(v) > 0 && Number(v) <= 10000).optional(),
  startDate: z.string().date().optional(),
  endDate: z.string().date().optional(),
}).strict().refine(v => !v.startDate || !v.endDate || v.startDate <= v.endDate, "分析开始日期不能晚于结束日期");
export type AnalysisQingzhouOptions = z.infer<typeof analysisQingzhouOptionsSchema>;
export interface AnalysisQingzhouWriteback {
  status: "pending" | "saved" | "failed";
  options?: AnalysisQingzhouOptions;
  inputDigest?: string;
  contentDigest?: string;
  previousContentDigest?: string;
  demandId?: string;
  connectionRevision?: number;
  credentialSource?: "project" | "seat";
  credentialSeatId?: string;
  seatAccountRevision?: number;
  attemptedAt?: string;
  savedAt?: string;
  /** Saving content and entering Qingzhou review are separately verified. */
  reviewStatus?: "pending" | "submitted" | "failed";
  reviewerId?: string;
  reviewAttemptedAt?: string;
  reviewVerifiedAt?: string;
  sourceState?: string;
  reviewError?: string;
  error?: string;
}
export const analysisCreateSchema = z
  .object({
    requestId: uuid,
    projectId: uuid,
    seatId: uuid,
    title: z.string().trim().min(1).max(300),
    brief: z.string().trim().min(10).max(20000),
    demandNo: z.string().trim().max(100).optional(),
    supersedesId: uuid.optional(),
    qingzhouOptions: analysisQingzhouOptionsSchema.optional(),
  })
  .strict();
export const analysisReviewMaterialsSchema = z.object({
  runId: uuid,
  inputDigest: hash,
  capturedAt: z.string().datetime(),
  documents: z.array(z.object({
    path: z.enum(["intake.md", "requirements.json", "analysis.md"]),
    sha256: hash,
    content: z.string().max(120000),
  }).strict()).length(3).refine(files => new Set(files.map(f => f.path)).size === 3),
  evidenceSha256: hash,
  evidence: z.array(z.object({
    id: z.string().max(200), kind: z.string().max(100),
    source: z.string().max(2000), locator: z.string().max(2000),
    path: z.string().max(2000), sha256: z.string().max(64),
  }).strict()).max(500),
}).strict();
export type AnalysisReviewMaterials = z.infer<typeof analysisReviewMaterialsSchema>;
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
    reviewMaterials: analysisReviewMaterialsSchema.optional(),
  })
  .strict();
export const analysisDeliverySchema = analysisSnapshotSchema
  .extend({
    inputDigest: hash,
    handoffDigest: hash,
    /** Only analysis.md is transferred for a bound Qingzhou demand. */
    analysisMarkdown: z.string().min(1).max(120000).refine(value => !!value.trim()).optional(),
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
  qingzhouWriteback?: AnalysisQingzhouWriteback | null;
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

/** Compact current-run actions for the workbench; excludes report bodies and credentials. */
export interface AnalysisPendingAction {
  id: string;
  taskId: string;
  projectId: string;
  ownerUserId: string;
  seatId: string;
  runId: string;
  key: string;
  kind: "question" | "review";
  title: string;
  prompt: string;
  createdAt: string;
}

/** Task details retain the analysis record's own visibility and lifecycle. */
export interface AnalysisTaskDetail {
  /** A rejected dispatch must not be presented as an accepted queued run. */
  dispatchProblem?: string | null;
  execution: AnalysisExecution;
  decisions: AnalysisDecision[];
  run: { id: string; status: string; error: string | null } | null;
}
