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
const completionReference = z.string().trim().url().max(2000).refine(value => {
  try {
    const url = new URL(value);
    return ["http:", "https:"].includes(url.protocol) && !url.username && !url.password;
  } catch { return false; }
}, "请使用不含凭据的正式 HTTP(S) 链接");
export const deliveryPriorCompletionSchema = z.object({
  stage: z.enum(DELIVERY_STAGES),
  jiraKey: z.string().regex(/^[A-Z][A-Z0-9_]*-\d+$/).nullable(),
  source: z.literal("jira").optional(),
  version: z.string().trim().max(500).default(""),
  artifactReferences: z.array(completionReference.or(z.literal(""))).max(20).default([]),
  reviewReference: completionReference.or(z.literal("")).default(""),
  passedTests: z.number().int().positive().max(1_000_000).optional(),
}).strict().superRefine((value, ctx) => {
  if (value.passedTests !== undefined && value.stage !== "functional-test")
    ctx.addIssue({ code: "custom", message: "只有功能测试可以登记测试结果" });
  if (value.stage === "functional-test" && value.source !== "jira" && value.passedTests === undefined)
    ctx.addIssue({ code: "custom", message: "人工登记已有功能测试须填写全部通过的测试总数" });
  if (value.source === "jira") {
    if (!value.jiraKey || value.stage === "analysis") ctx.addIssue({code:"custom",message:"Jira 已有交付须绑定真实子工单"});
    if (value.version || value.artifactReferences.length || value.reviewReference) ctx.addIssue({code:"custom",message:"Jira 来源依据由平台读取，不能手工覆盖"});
    return;
  }
  if (!value.version || !value.artifactReferences.length || value.artifactReferences.some(v=>!v) || !value.reviewReference)
    ctx.addIssue({code:"custom",message:"请填写已有交付版本、成果及完成依据"});
  if (value.jiraKey) {
    let path: string | undefined;
    try { path = new URL(value.reviewReference).pathname; } catch { /* Invalid URLs are reported by completionReference. */ }
    if (path !== "/browse/" + value.jiraKey) ctx.addIssue({code:"custom",message:"请引用本节点真实工单的正式完成结论"});
  }
});
export type DeliveryPriorCompletion = z.infer<typeof deliveryPriorCompletionSchema>;
export const deliveryWorkflowStartSchema = z
  .object({
    automaticRepairAuthorized: z.boolean().optional(),
    priorCompletions: z.array(deliveryPriorCompletionSchema).max(200).optional(),
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
    workTasks: z.array(z.object({
      stage: z.enum(["design", "coding", "test-cases", "functional-test"]),
      jiraKey: z.string().regex(/^[A-Z][A-Z0-9_]*-\d+$/),
      seatId: uuid.or(z.literal("")),
    }).strict()).min(1).max(200).optional(),
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
> & { template?: DeliveryTemplateSnapshot; seatAssignment?: "jira_assignee";
  automaticPlan?: { digest: string; inputDigest: string; sourceDigest: string; seatDigests: Record<string, string>; priorVersions: Record<string, string> };
  historicalVerifications?: Record<string, string>;
  entryScope?: {
    jiraOrigin: string;
    checkedSnapshotId?: string;
    acceptanceDigest?: string;
    branches: Record<string, { digest: string; snapshotId: string; afterParentKey?: string; skipTestCases?: true }>;
    ignoredParentKeys?: string[];
    requests: Record<string, { actor: string; digest: string; inputDigest: string }>;
  };
  automaticRepairGrant?: {jiraOrigin:string; seats:Array<{seatId:string;account:string;ownerUserId:string}>};
};
/** Exceptions are instance-scoped; planning never edits the project template. */
export const deliveryAutomaticPlanSchema = z.object({
  snapshotId: uuid,
  parentKey: z.string().regex(/^[A-Z][A-Z0-9_]*-\d+$/).optional(),
  entryScope: z.literal(true).optional(),
  selectedParentKeys: z.array(z.string().regex(/^[A-Z][A-Z0-9_]*-\d+$/)).max(20)
    .refine(keys => new Set(keys).size === keys.length).optional(),
  ignoredParentKeys: z.array(z.string().regex(/^[A-Z][A-Z0-9_]*-\d+$/)).max(20)
    .refine(keys => new Set(keys).size === keys.length).optional(),
  skipTestCasesParentKeys: z.array(z.string().regex(/^[A-Z][A-Z0-9_]*-\d+$/)).max(20)
    .refine(keys => new Set(keys).size === keys.length).optional(),
  branchDependencies: z.array(z.object({
    parentKey: z.string().regex(/^[A-Z][A-Z0-9_]*-\d+$/),
    afterParentKey: z.string().regex(/^[A-Z][A-Z0-9_]*-\d+$/),
  }).strict()).max(20).refine(values => new Set(values.map(value => value.parentKey)).size === values.length).optional(),
  environmentReference: completionReference.or(z.literal("")).default(""),
  reviewTasks: deliveryWorkflowStartSchema.shape.reviewTasks,
  workSeats: deliveryWorkflowStartSchema.shape.workSeats,
  analysisSeatId: uuid.optional(),
  passedTests: z.array(z.object({jiraKey:z.string().regex(/^[A-Z][A-Z0-9_]*-\d+$/), total:z.number().int().positive().max(1_000_000)}).strict()).max(100).optional(),
}).strict();
export type DeliveryAutomaticPlanInput = z.infer<typeof deliveryAutomaticPlanSchema>;
export const deliveryAutomaticStartSchema = z.object({
  requestId: uuid,
  plan: deliveryAutomaticPlanSchema,
  expectedDigest: hash,
  parentKeys: z.array(z.string().regex(/^[A-Z][A-Z0-9_]*-\d+$/)).max(20).refine(keys => new Set(keys).size === keys.length).optional(),
  authorized: z.literal(true),
  automaticRepairAuthorized: z.boolean().default(false),
}).strict();
export type DeliveryAutomaticStartInput = z.infer<typeof deliveryAutomaticStartSchema>;
export interface DeliveryAutomaticPlan {
  digest: string;
  generatedAt?: string;
  workflowScope?: { id: string; requestCount: number } | null;
  ready: boolean;
  template: DeliveryTemplateSnapshot;
  parents: string[];
  parentKey: string | null;
  canSaveIgnored?: boolean;
  branches?: Array<{ parentKey: string; scopeChanged?: boolean; canIgnore?: boolean; canSkipTestCases?: boolean; skipTestCases?: true; afterParentKey?: string; impactedParents?: string[]; state: "ready" | "blocked" | "started" | "verified" | "ignored"; nodes: DeliveryAutomaticPlan["nodes"]; blockers: DeliveryAutomaticPlan["blockers"]; excluded: DeliveryAutomaticPlan["excluded"] }>;
  nodes: Array<{
    stage: DeliveryStage;
    jiraKey: string | null;
    title: string;
    reviewWorkKeys?: string[];
    dependsOn: string[];
    mode: "reuse" | "human" | "seat";
    seatId: string;
    executor: string;
    jiraAssignee?: string;
    startMode: "automatic" | "confirmation";
    completionReview: boolean;
    revalidate?: boolean;
    verificationNote?: string;
    evidenceVersion?: string;
    passedTests?: number;
    testResult?: string;
    seatChoices: Array<{id:string; name:string}>;
  }>;
  excluded: Array<{jiraKey:string; reason:string}>;
  blockers: Array<{code:string; message:string; jiraKey?:string}>;
}
export interface DeliverySavedAutomaticPlan {
  input: DeliveryAutomaticPlanInput;
  plan: DeliveryAutomaticPlan;
}
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
    "原编码、原代码评审和原功能测试必须为不同工单",
  );
export type DeliveryRepairConfig = z.infer<typeof deliveryRepairStartSchema>;
export const deliveryFailureReportSchema = z.object({
  sourcePath: z.literal("delivery-failures.json"), sourceSha256: hash,
  defects: z.array(z.object({
    caseId: z.string().trim().min(1).max(200),
    module: z.string().trim().min(1).max(100),
    kind: z.enum(["product", "environment", "test-case"]),
    summary: z.string().trim().min(1).max(200),
    steps: z.string().trim().min(1).max(4000),
    expected: z.string().trim().min(1).max(2000),
    actual: z.string().trim().min(1).max(2000),
  }).strict()).min(1).max(100),
}).strict().refine(r=>new Set(r.defects.map(d=>d.caseId)).size===r.defects.length,"失败用例不能重复");
export const deliveryBuildSchema = z.object({
  version: z.string().trim().min(1).max(500),
  environmentReference: completionReference,
  observationUrl: completionReference,
  sourcePath: z.literal("delivery-build.json"), sourceSha256: hash,
}).strict();
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
    failureReport: deliveryFailureReportSchema.optional(),
    build: deliveryBuildSchema.optional(),
    codeReview: z
      .object({
        decision: z.enum(["passed", "rejected"]),
        note: z.string().trim().min(1).max(2000).optional(),
        reviewedVersionDigest: hash,
        sourcePath: z.string().min(1).max(1000),
        sourceSha256: hash,
      })
      .strict().refine(r=>r.decision!=="rejected" || !!r.note,"退回评审须提供修改说明")
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
  priorCompletion?: DeliveryPriorCompletion & { by: string; at: string; snapshotId: string; jiraEvidence?: { updated: string; status: string; reviewResult?: string; testResult?: string; artifacts: Array<{path: string; sha256: string; downloadUrl: string}>; comments: Array<{id: string; body: string; updated: string}> } };
  historicalVerification?: { jiraOrigin: string };
  deferredPriorCompletion?: { prior: DeliveryPriorCompletion; version: string; reference: string; by: string; snapshotId: string };
  intent?: "bugfix" | "code-review" | "retest" | "design-review" | "test-case-review";
  executionMode?: "seat" | "human";
  reviewWorkKeys?: string[];
  automaticRepair?: {
    status: "provisioning" | "blocked" | "ready";
    message?: string;
    route: { module: string; developmentSeatId: string; reviewSeatId: string; qaSeatId: string };
    operations: Array<{ marker: string; kind: "defect" | "fix" | "review" | "retest"; caseId?: string; state: "pending" | "creating" | "created"; claimedAt?: string; key?: string }>;
  };
  automaticRepairGenerated?: boolean;
  /** QA repair reopens this same node; Jira/native identity and intent stay fixed. */
  repairReused?: boolean;
  expectedBuild?: z.infer<typeof deliveryBuildSchema>;
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
    automaticRepair?: DeliveryStageRecord["automaticRepair"];
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
  branchBlocked?: boolean;
  environmentReference?: string;
  authorizedBy?: string;
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
    kind?: "scope_change";
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

/** Read-only projection of actions currently permitted by an instance. */
export interface DeliveryWorkflowAction {
  id: string;
  workflowId: string;
  projectId: string;
  snapshotId: string;
  taskId?: string;
  ownerUserId: string;
  kind: "work" | "review" | "answer" | "confirm-start" | "accept" | "recovery";
  title: string;
  reason: string;
  actionLabel: string;
  href: string;
  createdAt: string;
}
export interface DeliveryWorkflowInbox {
  actions: DeliveryWorkflowAction[];
  managedTaskIds: string[];
}
export interface DeliveryWorkflowTaskContext {
  workflowId: string;
  demandNo: string;
  state: DeliveryWorkflow["state"];
  stage: DeliveryStageRecord;
  href: string;
  actions: DeliveryWorkflowAction[];
}
