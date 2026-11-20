import { z } from "zod";
export const DELIVERY_ENTRY_CHECKS = {
  title: "条目标题已填写",
  owner: "需求拆分人员已指定",
  main_issue: "已关联 Jira 主工单",
  entry_task: "开始节点对应工单已存在（分析节点使用需求条目）",
  source_consistent: "轻舟与 Jira 无结构差异",
  analysis_approved: "已有正式分析通过结论",
  design_approved: "已登记正式设计评审通过结论",
  environment_reference: "测试环境与待测构建准入引用已填写（启动配置）",
} as const;
export type DeliveryEntryCheck = keyof typeof DELIVERY_ENTRY_CHECKS;
export const deliveryEntryCheckSchema = z.enum(["title", "owner", "main_issue", "entry_task", "source_consistent", "analysis_approved", "design_approved", "environment_reference"]);
const stages = [
  "analysis",
  "design",
  "coding",
  "test-cases",
  "functional-test",
] as const;
export const deliveryTemplateStageSchema = z
  .object({
    enabled: z.boolean(),
    entryChecks: z.array(deliveryEntryCheckSchema).min(1).max(8).refine(checks => new Set(checks).size === checks.length, "准入检查项不能重复").optional(),
    start: z.enum(["automatic", "confirmation"]),
    review: z.enum(["none", "seat_owner", "specified_user"]),
    reviewerUserId: z.string().min(1).max(200).optional(),
    seatId: z.string().uuid().optional(),
    workExecution: z.enum(["human", "agent"]).optional(),
    reviewExecution: z.enum(["human", "agent"]).optional(),
    workExecutorUserId: z.string().min(1).max(200).optional(),
    reviewExecutorUserId: z.string().min(1).max(200).optional(),
    taskSequence: z.enum(["work_only", "work_then_review"]).optional(),
    reviewSeatId: z.string().uuid().optional(),
    rejectionHandling: z.enum(["automatic_rework", "pause"]).optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.review === "specified_user" && !value.reviewerUserId)
      ctx.addIssue({ code: "custom", message: "指定审核人时请选择组织成员" });
    if (value.review !== "specified_user" && value.reviewerUserId)
      ctx.addIssue({ code: "custom", message: "仅指定人员审核可设置审核人" });
  });
export const deliveryAutomaticRepairSchema = z.object({
  mode: z.literal("reuse_existing").optional(),
  buildObservationUrl: z.string().url().max(2000).refine(value=>{try {const u=new URL(value);return ["http:","https:"].includes(u.protocol)&&!u.username&&!u.password;}catch{return false;}}, "构建回读地址须为不含凭据的 HTTP(S) 地址"),
  maxCycles: z.number().int().min(1).max(3),
  jiraProjectKey: z.string().regex(/^[A-Z][A-Z0-9_]*$/).optional(),
  defectIssueTypeId: z.string().regex(/^\d+$/).optional(),
  fixIssueTypeId: z.string().regex(/^\d+$/).optional(),
  reviewIssueTypeId: z.string().regex(/^\d+$/).optional(),
  retestIssueTypeId: z.string().regex(/^\d+$/).optional(),
  routes: z.array(z.object({
    module: z.string().trim().min(1).max(100),
    developmentSeatId: z.string().uuid(),
    reviewSeatId: z.string().uuid(),
    qaSeatId: z.string().uuid(),
  }).strict().refine(r=>r.developmentSeatId!==r.reviewSeatId,"修复与独立评审必须使用不同席位")).min(1).max(50),
}).strict().refine(value=>new Set(value.routes.map(r=>r.module)).size===value.routes.length,"模块路由不能重复");
export type DeliveryAutomaticRepairPolicy = z.infer<typeof deliveryAutomaticRepairSchema>;
export const deliveryTemplateDefinitionSchema = z
  .object({
    inheritOrganization: z.boolean().optional(),
    name: z.string().trim().min(1).max(100),
    stages: z
      .object({
        analysis: deliveryTemplateStageSchema,
        design: deliveryTemplateStageSchema,
        coding: deliveryTemplateStageSchema,
        "test-cases": deliveryTemplateStageSchema,
        "functional-test": deliveryTemplateStageSchema,
      })
      .strict(),
    automaticRepair: deliveryAutomaticRepairSchema.optional(),
    codingExecution: z.enum(["parallel", "serial"]),
    waitingNotifications: z.boolean(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.automaticRepair && (!value.stages["functional-test"].enabled || value.stages["functional-test"].workExecution === "human"))
      ctx.addIssue({code:"custom",message:"自动修复需要启用 Agent 功能测试"});
    if (!stages.some((stage) => value.stages[stage].enabled))
      ctx.addIssue({ code: "custom", message: "至少启用一个交付阶段" });
    for (const stage of ["analysis", "functional-test"] as const)
      if (value.stages[stage].taskSequence === "work_then_review")
        ctx.addIssue({ code: "custom", message: "该阶段不支持独立评审工单" });
    if (value.stages.analysis.workExecution === "human")
      ctx.addIssue({code:"custom",message:"需求分析沿用独立分析与正式发布流程"});
    if (value.stages.analysis.review !== "none")
      ctx.addIssue({
        code: "custom",
        message: "需求分析沿用正式发布审核，不重复设置交付审核",
      });
  });
export type DeliveryTemplateDefinition = z.infer<
  typeof deliveryTemplateDefinitionSchema
>;
export interface DeliveryTemplateSnapshot {
  id: string;
  revision: number;
  scope: "builtin" | "organization" | "project";
  definition: DeliveryTemplateDefinition;
}
export const DEFAULT_DELIVERY_TEMPLATE: DeliveryTemplateDefinition = {
  name: "设计评审与并行编码评审交付",
  stages: {
    analysis: { enabled: false, start: "automatic", review: "none" },
    design: { enabled: true, start: "automatic", review: "seat_owner", rejectionHandling: "automatic_rework", taskSequence: "work_then_review" },
    coding: { enabled: true, start: "automatic", review: "none", rejectionHandling: "automatic_rework", taskSequence: "work_then_review" },
    "test-cases": { enabled: true, start: "automatic", review: "seat_owner", rejectionHandling: "automatic_rework", taskSequence: "work_then_review" },
    "functional-test": { enabled: true, start: "automatic", review: "none" },
  },
  codingExecution: "parallel",
  waitingNotifications: true,
};
export const BUILTIN_DELIVERY_TEMPLATE: DeliveryTemplateSnapshot = {
  id: "builtin-entry-checks-v4",
  revision: 4,
  scope: "builtin",
  definition: DEFAULT_DELIVERY_TEMPLATE,
};
export const publishDeliveryTemplateSchema = z
  .object({
    projectId: z.string().uuid().optional(),
    expectedRevision: z.number().int().nonnegative(),
    definition: deliveryTemplateDefinitionSchema,
  })
  .strict()
  .superRefine((value, ctx) => {
    const first = stages.find(stage => value.definition.stages[stage].enabled);
    if (!value.definition.inheritOrganization && first && !value.definition.stages[first].entryChecks?.length)
      ctx.addIssue({code:"custom",message:"请为交付链开始节点至少选择一项准入检查条件"});
  });
export interface DeliveryTemplateSettings {
  effective: DeliveryTemplateSnapshot;
  own: DeliveryTemplateSnapshot | null;
  history: DeliveryTemplateSnapshot[];
}

export const DELIVERY_WORK_LABELS = { analysis: "需求分析", design: "设计单", coding: "编码单", "test-cases": "用例编写单", "functional-test": "测试执行单" } as const;
export const DELIVERY_REVIEW_LABELS = { design: "设计评审单", coding: "代码评审单", "test-cases": "用例评审单" } as const;
export type DeliveryReviewStage = keyof typeof DELIVERY_REVIEW_LABELS;
export function deliverySequenceLabel(stage: keyof typeof DELIVERY_WORK_LABELS, policy: DeliveryTemplateDefinition["stages"]["design"]) {
  const review = DELIVERY_REVIEW_LABELS[stage as DeliveryReviewStage];
  return DELIVERY_WORK_LABELS[stage] + (policy.workExecution ? (policy.workExecution === "human" ? "（人工）" : "（Agent）") : "") + (policy.taskSequence === "work_then_review" && review ? " → " + review + (deliveryReviewExecution(stage, policy) === "agent" ? "（独立席位执行）" : "（负责人评审）") : "");
}
export function matchesDeliveryWorkType(stage: string, review: boolean, type: string) {
  const isReview = /评审|审查/.test(type);
  if (review !== isReview) return false;
  if (stage === "design") return /设计/.test(type) && !/测试|用例/.test(type);
  if (stage === "coding") return /编码|开发|代码/.test(type) && !/设计|测试|用例/.test(type);
  if (stage === "test-cases") return /用例/.test(type);
  return stage === "functional-test" && /功能测试|测试执行/.test(type);
}

export function deliveryReviewExecution(stage: string, policy: DeliveryTemplateDefinition["stages"]["design"]) { return policy.reviewExecution ?? (stage === "coding" ? "agent" : "human"); }
