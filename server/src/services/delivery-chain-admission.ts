import { and, desc, eq } from "drizzle-orm";
import { analysisExecutions, deliveryWorkflows, type Db, type deliverySnapshots } from "@paperclipai/db";
import { DELIVERY_ENTRY_CHECKS, DELIVERY_STAGES, matchesDeliveryWorkType, type DeliveryAdmission, type DeliveryChainAdmission, type DeliveryPlan, type DeliveryTemplateSnapshot } from "@paperclipai/shared";
import { deliveryAdmission, latestDeliverySnapshots } from "./delivery-admission.js";
import { deliveryTemplateSettings } from "./delivery-templates.js";

/** Entry checks apply only before entering the chain. Coding guards remain separate. */
export function evaluateDeliveryChainAdmission(plan: DeliveryPlan, template: DeliveryTemplateSnapshot, facts: { analysisPublished: boolean; evidence: DeliveryAdmission["evidence"]; environmentReference?: string }): DeliveryChainAdmission {
  const startStage = DELIVERY_STAGES.find(stage => template.definition.stages[stage].enabled) ?? null;
  const selected = startStage ? template.definition.stages[startStage].entryChecks : undefined;
  if (!selected?.length) return { state: "unconfigured", ready: false, template, startStage, checks: [], reasons: ["请在交付链设置中为开始节点选择准入检查项并发布"] };
  const values = {
    environment_reference: !!facts.environmentReference?.trim(),
    title: !!plan.title.trim(),
    owner: plan.roles.some(role => ["需求拆分人员", "条目研发负责人"].includes(role.label) && !!role.name.trim()),
    main_issue: plan.mains.some(main => plan.items.some(item => item.key === main.key && !item.parentKey)),
    entry_task: startStage === "analysis" ? !!plan.demandId : plan.items.some(item => !!item.parentKey && matchesDeliveryWorkType(startStage!, false, item.type)),
    source_consistent: plan.differences.length === 0,
    analysis_approved: facts.analysisPublished || !!facts.evidence?.analysisReference,
    design_approved: !!facts.evidence?.designRequired && !!facts.evidence.designReference,
  };
  const checks = selected.map(key => ({ key, label: DELIVERY_ENTRY_CHECKS[key], passed: values[key] }));
  const reasons = checks.filter(check => !check.passed).map(check => check.label + "：未满足");
  return { state: reasons.length ? "blocked" : "ready", ready: !reasons.length, template, startStage, checks, reasons };
}

export async function deliveryChainAdmission(db: Db, snapshot: typeof deliverySnapshots.$inferSelect, context: {
  template?: DeliveryTemplateSnapshot; codingAdmission?: DeliveryAdmission; environmentReference?: string;
  /** Request-local facts loaded with company/project scope by the monthly reader. */
  flow?: Pick<typeof deliveryWorkflows.$inferSelect, "config"> | null;
  analysis?: Pick<typeof analysisExecutions.$inferSelect, "state"> | null;
  latestSnapshotIds?: ReadonlySet<string>;
} = {}): Promise<DeliveryChainAdmission> {
  const flow = context.flow !== undefined ? context.flow : (await db.select().from(deliveryWorkflows).where(and(eq(deliveryWorkflows.companyId, snapshot.companyId), eq(deliveryWorkflows.projectId, snapshot.projectId), eq(deliveryWorkflows.demandNo, snapshot.demandNo))).limit(1))[0];
  if (flow) {
    const template = flow.config.template ?? null;
    return { state: "admitted", ready: true, template, startStage: template ? DELIVERY_STAGES.find(stage => template.definition.stages[stage].enabled) ?? null : null, checks: [], reasons: ["条目已进入交付链；后续阶段条件与阻塞在对应阶段核验"] };
  }
  const template = context.template ?? (await deliveryTemplateSettings(db, snapshot.companyId, snapshot.projectId)).effective;
  const selected = DELIVERY_STAGES.find(stage => template.definition.stages[stage].enabled);
  const checks = selected ? template.definition.stages[selected].entryChecks ?? [] : [];
  let evidence: DeliveryAdmission["evidence"] = null;
  let analysisPublished = false;
  if (checks.includes("analysis_approved") || checks.includes("design_approved")) {
    evidence = (context.codingAdmission ?? await deliveryAdmission(db, snapshot)).evidence;
    const analysis = context.analysis !== undefined ? context.analysis : (await db.select({state: analysisExecutions.state}).from(analysisExecutions).where(and(eq(analysisExecutions.companyId,snapshot.companyId),eq(analysisExecutions.projectId,snapshot.projectId),eq(analysisExecutions.demandNo,snapshot.demandNo))).orderBy(desc(analysisExecutions.createdAt),desc(analysisExecutions.revision),desc(analysisExecutions.id)).limit(1))[0];
    analysisPublished = analysis?.state === "published";
    if (analysis && !analysisPublished) evidence = null;
  }
  const result = evaluateDeliveryChainAdmission(snapshot.plan, template, {analysisPublished, evidence, environmentReference:context.environmentReference});
  const latestIds = context.latestSnapshotIds ?? new Set((await latestDeliverySnapshots(db, snapshot.companyId, snapshot.projectId)).map(row => row.id));
  if (!latestIds.has(snapshot.id)) {
    result.ready = false;
    if (result.state !== "unconfigured") result.state = "blocked";
    result.reasons.push("当前为历史来源版本，请在最新版本核验交付链准入");
  }
  return result;
}
