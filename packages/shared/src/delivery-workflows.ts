import type { DeliveryTemplateSnapshot } from "./delivery-templates.js";
import { z } from "zod";
const uuid = z.string().uuid(),
  hash = z.string().regex(/^[a-f0-9]{64}$/);
export const DELIVERY_STAGE_MAX_RESUMES = 3;
export const DELIVERY_MAX_REPAIR_CYCLES = 3;
export const DELIVERY_STAGES = [
  "analysis",
  "design",
  "coding",
  "test-cases",
  "functional-test",
] as const;
export type DeliveryStage = (typeof DELIVERY_STAGES)[number];
export const DELIVERY_STAGE_LABELS: Record<DeliveryStage, string> = {
  analysis: "需求分析",
  design: "研发设计",
  coding: "编码与代码评审",
  "test-cases": "测试用例",
  "functional-test": "功能测试",
};
export const deliveryWorkflowStartSchema = z
  .object({
    requestId: uuid,
    snapshotId: uuid,
    analysisSeatId: uuid.or(z.literal("")),
    developmentSeatId: uuid.or(z.literal("")),
    qaSeatId: uuid.or(z.literal("")),
    designKey: z
      .string()
      .regex(/^[A-Z][A-Z0-9_]*-\d+$/)
      .or(z.literal("")),
    codingKey: z
      .string()
      .regex(/^[A-Z][A-Z0-9_]*-\d+$/)
      .or(z.literal("")),
    testCasesKey: z
      .string()
      .regex(/^[A-Z][A-Z0-9_]*-\d+$/)
      .or(z.literal("")),
    testExecutionKey: z
      .string()
      .regex(/^[A-Z][A-Z0-9_]*-\d+$/)
      .or(z.literal("")),
    environmentReference: z.string().trim().url().max(2000).or(z.literal("")),
    workSeats: z.array(z.object({jiraKey:z.string().regex(/^[A-Z][A-Z0-9_]*-\d+$/),seatId:uuid.or(z.literal(""))}).strict()).max(100).refine(bindings=>new Set(bindings.map(b=>b.jiraKey)).size===bindings.length,"工单席位绑定不能重复").optional(),
    codingTasks: z
      .array(
        z
          .object({
            jiraKey: z.string().regex(/^[A-Z][A-Z0-9_]*-\d+$/),
            seatId: uuid.or(z.literal("")),
          })
          .strict(),
      )
      .min(1)
      .max(50)
      .optional(),
    reviewTasks: z.array(z.object({
      stage: z.enum(["design", "coding", "test-cases"]),
      jiraKey: z.string().regex(/^[A-Z][A-Z0-9_]*-\d+$/),
      workKeys: z.array(z.string().regex(/^[A-Z][A-Z0-9_]*-\d+$/)).min(1).max(50),
      seatId: uuid.optional(),
    }).strict()).max(100).optional(),
    expectedTemplate: z
      .object({ id: z.string().min(1), revision: z.number().int().positive() })
      .strict()
      .optional(),
  })
  .strict();
export type DeliveryWorkflowConfig = z.infer<
  typeof deliveryWorkflowStartSchema
> & { template?: DeliveryTemplateSnapshot; seatAssignment?: "jira_assignee" };
export const deliveryRepairStartSchema = z
  .object({
    expectedReceiptDigest: hash,
    defectKey: z.string().regex(/^[A-Z][A-Z0-9_]*-\d+$/),
    reviewKey: z.string().regex(/^[A-Z][A-Z0-9_]*-\d+$/),
    retestKey: z.string().regex(/^[A-Z][A-Z0-9_]*-\d+$/),
    developmentSeatId: uuid,
    reviewSeatId: uuid,
    qaSeatId: uuid,
  })
  .strict()
  .refine(
    (value) => value.developmentSeatId !== value.reviewSeatId,
    "修复和独立评审必须使用不同席位",
  )
  .refine(
    (value) =>
      new Set([value.defectKey, value.reviewKey, value.retestKey]).size === 3,
    "修复、评审和重测必须使用各自工单",
  );
export type DeliveryRepairConfig = z.infer<typeof deliveryRepairStartSchema>;
export const deliveryStageReceiptSchema = z
  .object({
    protocolVersion: z.literal(1),
    taskId: uuid,
    runId: uuid,
    stage: z.enum(DELIVERY_STAGES),
    jiraKey: z.string().regex(/^[A-Z][A-Z0-9_]*-\d+$/),
    inputDigest: hash,
    stateDigest: hash,
    trackerReceiptId: z.string().min(1).max(200),
    codeReview: z
      .object({
        decision: z.literal("passed"),
        reviewedVersionDigest: hash,
        sourcePath: z.string().min(1).max(1000),
        sourceSha256: hash,
      })
      .strict()
      .optional(),
    domainReview: z
      .object({
        decision: z.literal("passed"),
        reviewedVersionDigest: hash,
        sourcePath: z.string().min(1).max(1000),
        sourceSha256: hash,
      })
      .strict()
      .optional(),
    testResults: z
      .object({
        total: z.number().int().positive().max(1_000_000),
        passed: z.number().int().nonnegative(),
        failed: z.number().int().nonnegative(),
        blocked: z.number().int().nonnegative(),
        skipped: z.number().int().nonnegative(),
        testedVersion: z.string().trim().min(1).max(500),
        sourcePath: z.literal("execution-records.md"),
        sourceSha256: hash,
      })
      .strict()
      .refine(
        (value) =>
          value.passed + value.failed + value.blocked + value.skipped ===
          value.total,
        "测试结果总数必须对账",
      )
      .optional(),
    jiraReference: z.string().url().max(2000),
    artifacts: z
      .array(
        z
          .object({
            path: z.string().min(1).max(1000),
            sha256: hash,
            downloadUrl: z.string().url().max(2000).optional(),
          })
          .strict(),
      )
      .min(1)
      .max(100),
  })
  .strict();
export type DeliveryStageReceipt = z.infer<typeof deliveryStageReceiptSchema>;
export interface DeliveryStageRecord {
  stage: DeliveryStage;
  intent?: "bugfix" | "code-review" | "retest" | "design-review" | "test-case-review";
  executionMode?: "seat" | "human";
  reviewWorkKeys?: string[];
  repairFailure?: { receipt: DeliveryStageReceipt; receiptDigest: string };
  repairHistory?: Array<{
    attempt: number;
    taskId: string;
    runId: string;
    receipt: DeliveryStageReceipt;
    receiptDigest: string;
    defectKey: string;
    reviewKey: string;
    retestKey: string;
    by: string;
    at: string;
  }>;
  /** Task IDs are stable graph node identities; absent dependencies retain legacy serial behavior. */
  dependsOn?: string[];
  requiresReview?: boolean;
  reviewerUserId?: string;
  startMode?: "automatic" | "confirmation";
  startApprovedBy?: string;
  taskId: string;
  seatId: string;
  ownerUserId: string;
  jiraKey: string | null;
  parentKey?: string;
  dispatchId: string;
  state:
    | "pending"
    | "queued"
    | "running"
    | "waiting"
    | "review"
    | "done"
    | "interrupted";
  /** Every invalidated delivery/review retains the exact prior evidence. */
  reworkHistory?: Array<{
    round: number;
    reviewTaskId: string;
    rejection: NonNullable<DeliveryStageRecord["review"]>;
    previous: Pick<DeliveryStageRecord, "state" | "inputDigest" | "dispatchId" | "runId" | "receipt" | "receiptDigest" | "manualDelivery" | "review">;
  }>;
  /** Explicit operator resumes; legacy records start at zero. */
  resumeCount?: number;
  runId: string | null;
  capabilityId: string | null;
  registryRevision: number | null;
  inputDigest: string;
  receipt: DeliveryStageReceipt | null;
  receiptDigest: string | null;
  manualDelivery?: { version: string; artifactReferences: string[]; testResults?: {total:number;passed:number;failed:number;blocked:number;skipped:number} };
  review: null | {
    decision: "approve" | "reject";
    digest: string;
    reference: string;
    note: string;
    by: string;
    at: string;
  };
  message: string | null;
  waitingSince?: string;
  question?: {
    text: string;
    digest: string;
    answer: string | null;
    by: string | null;
    at: string | null;
  };
}
export interface DeliveryWorkflow {
  id: string;
  companyId: string;
  projectId: string;
  snapshotId: string;
  demandNo: string;
  fingerprint: string;
  createdBy: string;
  state: "active" | "blocked" | "acceptance" | "completed" | "cancelled";
  config: DeliveryWorkflowConfig;
  stages: DeliveryStageRecord[];
  message: string | null;
  acceptance: null | {
    reference: string;
    note: string;
    by: string;
    at: string;
  };
  createdAt: string;
  updatedAt: string;
}

export const deliveryReviewDigest = (stage: DeliveryStageRecord) => stage.executionMode === "human" ? stage.inputDigest : stage.receiptDigest;
export function deliveryRecordLabel(stage: DeliveryStageRecord): string {
  return stage.intent === "design-review" ? "设计评审单" : stage.intent === "test-case-review" ? "用例评审单" : stage.intent === "code-review" ? "独立代码评审" : stage.intent === "bugfix" ? "缺陷修复" : stage.intent === "retest" ? "功能重测" : DELIVERY_STAGE_LABELS[stage.stage];
}
