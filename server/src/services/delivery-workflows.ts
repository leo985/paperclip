import { canExtendDeliveryEntry, canSkipDeliveryTestCases, deliveryActiveIssueIdentity, deliveryBranchChildIdentities, deliveryBranchDigest, deliveryBranchMatches, deliveryBranchPlan, deliveryBranchTemplate, deliveryBranchVerified, deliveryDependentBranches, deliveryEntryInput, deliveryEntryScopeComplete, deliveryRepairCandidates, legacyDeliveryEntryScope } from "./delivery-entry-scope.js";
import { readAutomaticDeliverySource } from "./delivery-automatic-source.js";
import { MissingJiraPriorEvidence, readJiraPriorCompletion } from "./delivery-prior-jira.js";
import { reconcileAutomaticRepair, assertAutomaticRepairSeats, automaticRepairOrigin, automaticRepairRoute, existingRepairNodes } from "./delivery-automatic-repair.js";
import { readDeliveryJiraAssignments, deliverySeatCandidates, chooseDeliverySeat, deliverySeatMatchesAssignee } from "./delivery-seat-assignment.js";
import { completedDeliverySource } from "./delivery-automatic-selection.js";
import { deliveryChainAdmission } from "./delivery-chain-admission.js";
import { seatCanAcceptWork, seatConcurrencyLimit } from "@paperclipai/shared";
import { deliveryReworkScope, prepareDeliveryRework, reopenDeliveryStages } from "./delivery-rework.js";
import { planDeliveryWork, wireDeliveryWork } from "./delivery-work-plan.js";
import {
  deliveryTemplateSettings,
  assertTemplateReviewer,
} from "./delivery-templates.js";
import {
  assertDeliveryGraph,
  deliveryAncestors,
  isHistoricalDelivery,
  orderDeliveryGraph,
  readyDeliveryStages,
  deliveryStageCanStart,
} from "./delivery-graph.js";
import { createHash, randomUUID } from "node:crypto";
import { and, desc, eq, inArray, or, sql } from "drizzle-orm";
import {
  activityLog,
  agents,
  analysisExecutions,
  deliverySnapshots,
  deliveryWorkflows,
  heartbeatRuns,
  issues,
  projects,
  seatExecutionPermits,
  type Db,
} from "@paperclipai/db";
import {
  DELIVERY_STAGES,
  matchesDeliveryWorkType,
  deliveryReviewDigest,
  deliveryRecordLabel,
  DELIVERY_MAX_REPAIR_CYCLES,
  DELIVERY_STAGE_MAX_RESUMES,
  type DeliveryRepairConfig,
  type DeliveryWorkflow,
  DELIVERY_STAGE_LABELS,
  type DeliveryStageRecord,
  type DeliveryWorkflowConfig,
  type DeliveryStageReceipt,
} from "@paperclipai/shared";
import { conflict, forbidden, notFound } from "../errors.js";
import { isSeatManagerUser, seatOwnerId } from "../routes/dsp7-seat-owners.js";
import { dispatchAnalysisExecution } from "../routes/analysis-executions.js";
import {
  resolveHarnessRoute,
  assertNewDomainMetering,
} from "./harness-execution-routing.js";
import { assertSeatBudgetAdmission } from "./seat-budget-admission.js";
import { heartbeatService } from "./heartbeat.js";
const canonical = (value: unknown): unknown =>
  Array.isArray(value)
    ? value.map(canonical)
    : value && typeof value === "object"
      ? Object.fromEntries(
          Object.entries(value)
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([k, v]) => [k, canonical(v)]),
        )
      : value;
export const deliveryDigest = (value: unknown) =>
  createHash("sha256")
    .update(JSON.stringify(canonical(value)))
    .digest("hex");
/** Approval pins identity, dispatch authorization and Harness registry, excluding transient presence. */
export const deliverySeatAuthorizationDigest = (seat: typeof agents.$inferSelect) => deliveryDigest({
  id:seat.id, companyId:seat.companyId, name:seat.name,
  ownerUserId:seatOwnerId(seat.adapterConfig.dsp7Seat as Record<string,unknown>),
  machineId:(seat.adapterConfig.dsp7Seat as {machineId?:string})?.machineId,
  transport:seat.adapterConfig.dsp7Transport,
  dispatch:seat.adapterConfig.dsp7JiraDispatch,
  registry:seat.adapterConfig.dsp7HarnessCapabilities,
  blocked:["paused","terminated","pending_approval"].includes(seat.status),
});
export const stageKind = (stage: string) =>
  stage === "analysis"
    ? "analysis"
    : stage === "design" || stage === "coding"
      ? "development"
      : "qa";
export const stageRole = (
  stage: string,
  intent?: DeliveryStageRecord["intent"],
) =>
  intent === "bugfix"
    ? "bug-fix"
    : intent === "design-review" ? "design-review" : intent === "test-case-review" ? "test-case-review" : intent === "code-review"
      ? "code-review"
      : stage === "analysis"
        ? "requirements-analysis"
        : stage === "design"
          ? "system-design"
          : stage === "coding"
            ? "coding"
            : stage === "test-cases"
              ? "test-cases"
              : "functional-test";
export const reviewRequired = (stage: string, record?: DeliveryStageRecord) =>
  record?.requiresReview ?? ["design", "test-cases"].includes(stage);
const nativeMetricsArtifacts = new Set(["state.json","metrics-source.json","zhiyan-snapshot.json","execution-time.json","harness-report.json","payload.json","tracker-response.json","delivery-rework.json","zhiyan-delivery.json"]);
export function validateStageReceipt(
  stage: DeliveryStageRecord,
  receipt: DeliveryStageReceipt,
) {
  if (
    receipt.stage !== stage.stage ||
    receipt.runId !== stage.runId ||
    receipt.taskId !== stage.taskId ||
    receipt.jiraKey !== stage.jiraKey ||
    receipt.inputDigest !== stage.inputDigest
  )
    throw conflict("交付回执与当前任务、运行或输入版本不匹配");
  if (
    new Set(receipt.artifacts.map((a) => a.path)).size !==
      receipt.artifacts.length ||
    receipt.artifacts.some(
      (a) =>
        a.path.startsWith("/") ||
        a.path.includes("..") ||
        a.path.includes("\\"),
    )
  )
    throw conflict("产物索引不完整或路径无效");
  if (stage.intent === "code-review") {
    const review = receipt.codeReview;
    if (
      !review ||
      !receipt.artifacts.some(
        (artifact) =>
          artifact.path === review.sourcePath &&
          artifact.sha256 === review.sourceSha256,
      )
    )
      throw conflict("独立评审必须提供通过结论、被审版本和报告指纹");
    if ((stage.automaticRepairGenerated || stage.repairReused) && review.reviewedVersionDigest!==deliveryDigest({inputDigest:stage.inputDigest,workKeys:stage.reviewWorkKeys}))
      throw conflict("自动独立评审未绑定本次修复输入与工单范围");
  } else if (receipt.codeReview)
    throw conflict("只有独立评审阶段可提交评审结果");
  if (["design-review","test-case-review"].includes(stage.intent ?? "")) {
    const review=receipt.domainReview;
    if(!review || review.reviewedVersionDigest !== deliveryDigest({inputDigest:stage.inputDigest,workKeys:stage.reviewWorkKeys}) || !receipt.artifacts.some(a=>a.path===review.sourcePath&&a.sha256===review.sourceSha256)) throw conflict("领域评审须提交通过结论、被审版本和报告指纹");
  } else if(receipt.domainReview) throw conflict("仅设计／用例独立评审可提交领域评审结果");
  if (stage.stage === "functional-test") {
    const result = receipt.testResults;
    if (
      !result ||
      !receipt.artifacts.some(
        (artifact) =>
          artifact.path === result.sourcePath &&
          artifact.sha256 === result.sourceSha256,
      )
    )
      throw conflict("功能测试必须提供绑定执行记录指纹和被测版本的结果汇总");
  } else if (receipt.testResults)
    throw conflict("只有功能测试阶段可提交测试结果汇总");
  if (receipt.failureReport && (stage.stage!=="functional-test" || !receipt.testResults?.failed || receipt.failureReport.defects.length!==receipt.testResults.failed || !receipt.artifacts.some(a=>a.path===receipt.failureReport!.sourcePath && a.sha256===receipt.failureReport!.sourceSha256 && a.downloadUrl)))
    throw conflict("缺陷报告须逐条对应失败用例并绑定可回读的正式附件");
  if (receipt.build && (!(stage.intent==="bugfix" || stage.repairReused && stage.stage==="coding" && !stage.reviewWorkKeys) || !receipt.artifacts.some(a=>a.path===receipt.build!.sourcePath&&a.sha256===receipt.build!.sourceSha256&&a.downloadUrl)))
    throw conflict("修复构建须绑定正式交付附件");
  if ((stage.automaticRepairGenerated && stage.intent==="bugfix" || stage.repairReused && stage.stage==="coding" && !stage.reviewWorkKeys) && (!receipt.build || receipt.build.version===stage.repairFailure?.receipt.testResults?.testedVersion))
    throw conflict("自动修复必须交付区别于失败版本的新构建");
  if (stage.expectedBuild && receipt.testResults?.testedVersion!==stage.expectedBuild.version)
    throw conflict("重测报告的被测版本与已核验修复构建不一致");
  const previous = stage.reworkHistory?.flatMap(r => r.previous.receipt ? [r.previous.receipt] : []) ?? [];
  if (previous.length && (previous.some(r => r.stateDigest === receipt.stateDigest) || !receipt.artifacts.some(a => !nativeMetricsArtifacts.has(a.path.split("/").at(-1)!) && !previous.some(r => r.artifacts.some(old => old.path === a.path && old.sha256 === a.sha256)) && a.downloadUrl)))
    throw conflict("返工必须提交更新后的原生状态和正式交付材料，不能复用退回版本");
  const u = new URL(receipt.jiraReference);
  if (
    !["http:", "https:"].includes(u.protocol) ||
    u.username ||
    u.password ||
    u.pathname !== "/browse/" + stage.jiraKey
  )
    throw conflict("交付必须引用当前 Jira 工单");
  for (const artifact of receipt.artifacts) {
    if (!artifact.downloadUrl) continue;
    const download = new URL(artifact.downloadUrl);
    if (
      download.origin !== u.origin ||
      download.username ||
      download.password ||
      download.search ||
      download.hash ||
      !/^\/secure\/attachment\/\d+\/[^/]+$/.test(download.pathname)
    )
      throw conflict("产物下载必须引用同一 Jira 的正式附件");
  }
}
export async function workflowAudit(
  db: Db,
  companyId: string,
  actorId: string,
  action: string,
  id: string,
  details: Record<string, unknown> = {},
) {
  await db.insert(activityLog).values({
    companyId,
    actorType: actorId.startsWith("agent:") ? "agent" : "user",
    actorId: actorId.startsWith("agent:") ? actorId.slice(6) : actorId,
    ...(actorId.startsWith("agent:") ? {agentId:actorId.slice(6)} : {}),
    action,
    entityType: "delivery_workflow",
    entityId: id,
    details,
  });
}
async function authorized(db: Db, c: string, u: string) {
  if (
    !(
      u === "local-board" &&
      process.env.PAPERCLIP_DEPLOYMENT_MODE === "local_trusted"
    ) &&
    !(await isSeatManagerUser(db, c, u))
  )
    throw forbidden("启动人的组织管理权限已失效，请由管理员处理");
}
export async function startDeliveryWorkflow(
  db: Db,
  c: string,
  actor: string,
  config: DeliveryWorkflowConfig,
  entry?: { existingId?: string; previousScope?: NonNullable<DeliveryWorkflowConfig["entryScope"]>["branches"]; previousIgnored?: string[]; ignoredParentKeys?: string[]; jiraOrigin: string; branches: Array<{
    key: string; config: DeliveryWorkflowConfig; scopeChanged: boolean; afterParentKey?: string; skipTestCases?: true; excluded: Array<{ jiraKey: string; reason: string }>;
  }> },
) {
  await authorized(db, c, actor);
  return db.transaction(async (tx) => {
    const store = tx as unknown as Db;
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${c + ":delivery-workflow-start"},0))`,
    );
    const [same] = await tx
      .select()
      .from(deliveryWorkflows)
      .where(
        and(
          eq(deliveryWorkflows.companyId, c),
          or(eq(deliveryWorkflows.requestId, config.requestId), sql`${deliveryWorkflows.config}->'entryScope'->'requests' ? ${config.requestId}`),
        ),
      );
    if (same) {
      if (entry && config.automaticPlan) {
        const grant = same.config.entryScope?.requests[config.requestId];
        if (grant?.actor !== actor || grant.digest !== config.automaticPlan.digest || grant.inputDigest !== config.automaticPlan.inputDigest)
          throw conflict("请求编号已用于其他启动配置");
        return same;
      }
      if (
        deliveryDigest({ ...same.config, template: undefined, seatAssignment: undefined, automaticRepairGrant:undefined }) !==
          deliveryDigest({ ...config, template: undefined, seatAssignment: undefined, automaticRepairGrant:undefined, historicalVerifications: undefined }) ||
        same.createdBy !== actor
      )
        throw conflict("请求编号已用于其他启动配置");
      return same;
    }
    const [snapshot] = await tx
      .select()
      .from(deliverySnapshots)
      .where(
        and(
          eq(deliverySnapshots.id, config.snapshotId),
          eq(deliverySnapshots.companyId, c),
        ),
      );
    if (!snapshot) throw notFound("条目版本不存在");
    const [project] = await tx
      .select()
      .from(projects)
      .where(
        and(eq(projects.id, snapshot.projectId), eq(projects.companyId, c)),
      );
    if (!project || project.archivedAt) throw conflict("项目已归档或不可用");
    const [existing] = await tx
      .select()
      .from(deliveryWorkflows)
      .where(
        and(
          eq(deliveryWorkflows.companyId, c),
          eq(deliveryWorkflows.projectId, snapshot.projectId),
          eq(deliveryWorkflows.demandNo, snapshot.demandNo),
        ),
      ).for("update");
    if (existing?.id !== entry?.existingId || (existing && !canExtendDeliveryEntry(existing.state, existing.message, !!existing.config.entryScope)))
      throw conflict("本条目已有交付流程或状态已变化，请重新生成计划");
    let registeredScope = existing?.config.entryScope;
    if (existing) {
      const [original] = await tx.select().from(deliverySnapshots).where(and(
        eq(deliverySnapshots.id, existing.snapshotId), eq(deliverySnapshots.companyId, c),
      ));
      if (!original || original.sourceOrigin !== snapshot.sourceOrigin || deliveryEntryInput(original.plan) !== deliveryEntryInput(snapshot.plan))
        throw conflict("条目需求输入已变化，请先核对原交付链的分析范围");
      if (registeredScope && existing.state === "completed") throw conflict("条目已完成正式验收");
      registeredScope ??= legacyDeliveryEntryScope(original.plan, original.id, existing.config, existing.stages, entry!.jiraOrigin);
      if (!registeredScope || registeredScope.jiraOrigin !== entry!.jiraOrigin ||
        deliveryDigest(registeredScope.branches) !== deliveryDigest(entry!.previousScope) ||
        deliveryDigest(registeredScope.ignoredParentKeys ?? []) !== deliveryDigest(entry!.previousIgnored ?? []))
        throw conflict("已授权的工单范围或 Jira 来源发生变化，请重新生成计划");
      for (const branch of entry!.branches) {
        const registered = registeredScope.branches[branch.key];
        if (registered && registered.skipTestCases !== branch.skipTestCases)
          throw conflict("已启动主工单的测试用例范围不能修改");
        if ((registered && registered.afterParentKey !== branch.afterParentKey) || (branch.afterParentKey &&
          !deliveryBranchVerified(snapshot.plan, { ...existing.config, entryScope: registeredScope }, existing.stages, branch.afterParentKey)))
          throw conflict("前置主工单尚未完成交付核验或授权已变化");
        if (!!registered !== branch.scopeChanged || (registered && deliveryBranchMatches(snapshot.plan, { ...existing.config, entryScope: registeredScope }, branch.key)))
          throw conflict("所选主工单已启动或范围已变化，请重新生成计划");
        if (!registered) continue;
        const [baseline] = await tx.select().from(deliverySnapshots).where(and(
          eq(deliverySnapshots.id, registered.snapshotId), eq(deliverySnapshots.companyId, c),
          eq(deliverySnapshots.projectId, snapshot.projectId),
        ));
        const current = deliveryBranchChildIdentities(snapshot.plan.items, branch.key, branch.skipTestCases);
        const dependents = deliveryDependentBranches(registeredScope, branch.key);
        if (!baseline || [...deliveryBranchChildIdentities(baseline.plan.items, branch.key, branch.skipTestCases)].some(([key, type]) => current.get(key) !== type) ||
          existing.stages.some(stage => (stage.parentKey === branch.key || dependents.has(stage.parentKey ?? "")) &&
            (stage.repairReused || stage.automaticRepairGenerated || stage.branchBlocked || stage.review?.decision === "reject" ||
              (stage.parentKey !== branch.key && isHistoricalDelivery(stage)))))
          throw conflict("主单工单范围或返工状态已变化，请核对原工单和正式流程");
      }
    }
    if (!existing && entry?.branches.some(branch => branch.afterParentKey))
      throw conflict("前置主工单须先完成交付核验");
    const newlyIgnored = entry?.ignoredParentKeys ?? [];
    const ignored = new Set([...(registeredScope?.ignoredParentKeys ?? []), ...newlyIgnored]);
    if (entry && (newlyIgnored.some(key =>
      !snapshot.plan.mains.some(main => main.key === key) || !!registeredScope?.branches[key]
    ) || entry.branches.some(branch => ignored.has(branch.key) || !!(branch.afterParentKey && ignored.has(branch.afterParentKey))) ||
      (!entry.branches.length && (!existing || !newlyIgnored.length))))
      throw conflict("忽略范围已变化，请重新生成计划");
    const [latest] = await tx
      .select()
      .from(deliverySnapshots)
      .where(
        and(
          eq(deliverySnapshots.companyId, c),
          eq(deliverySnapshots.projectId, snapshot.projectId),
          eq(deliverySnapshots.sourceOrigin, snapshot.sourceOrigin),
          eq(deliverySnapshots.demandNo, snapshot.demandNo),
        ),
      )
      .orderBy(
        desc(deliverySnapshots.collectedAt),
        desc(deliverySnapshots.createdAt),
        desc(deliverySnapshots.id),
      )
      .limit(1);
    if (latest.id !== snapshot.id)
      throw conflict("来源已更新，请在最新条目版本启动");
    const template = existing?.config.template ?? (await deliveryTemplateSettings(store, c, snapshot.projectId)).effective;
    if (entry?.branches.some(branch => branch.skipTestCases) && (!config.automaticPlan || !canSkipDeliveryTestCases(template)))
      throw conflict("当前模板或授权不支持忽略测试用例阶段");
    if (
      config.expectedTemplate &&
      (config.expectedTemplate.id !== template.id ||
        config.expectedTemplate.revision !== template.revision)
    )
      throw conflict("流程模板已更新，请刷新配置后启动");
    let automaticRepairGrant: DeliveryWorkflowConfig["automaticRepairGrant"];
    if (template.definition.automaticRepair && (!entry || entry.branches.length)) {
      if (!config.automaticRepairAuthorized) throw conflict("请确认授权本实例复用原编码、代码评审和功能测试任务执行返工");
      const jira={origin:await automaticRepairOrigin(store,c,template.definition.automaticRepair)};
      const seats=await assertAutomaticRepairSeats(store,{companyId:c,projectId:snapshot.projectId},template.definition.automaticRepair,jira.origin);
      const ids=new Set(template.definition.automaticRepair.routes.flatMap(r=>[r.developmentSeatId,r.reviewSeatId,r.qaSeatId]));
      automaticRepairGrant={jiraOrigin:jira.origin,seats:seats.filter(s=>ids.has(s.id)).map(s=>({seatId:s.id,account:(s.adapterConfig.dsp7JiraDispatch as {jiraAssignee:string}).jiraAssignee,ownerUserId:seatOwnerId(s.adapterConfig.dsp7Seat as Record<string,unknown>)!}))};
    } else if (!template.definition.automaticRepair && config.automaticRepairAuthorized) throw conflict("项目模板未启用自动修复策略");
    const admissions = entry ? await Promise.all(entry.branches.map(({ key, skipTestCases }) =>
      deliveryChainAdmission(store, { ...snapshot, plan: deliveryBranchPlan(snapshot.plan, key, skipTestCases) }, {
        template: deliveryBranchTemplate(template, skipTestCases), environmentReference: config.environmentReference, flow: null,
      }))) : [await deliveryChainAdmission(store, snapshot, { template, environmentReference: config.environmentReference })];
    const invalidAdmission = admissions.find(admission => !admission.ready);
    if (invalidAdmission) throw conflict("交付链准入未满足：" + invalidAdmission.reasons.join("；"));
    const [entryAdmission] = admissions;
    let authorizedJiraOrigin: string | undefined;
    if (config.automaticPlan) {
      const source = await readAutomaticDeliverySource(store, c, snapshot.projectId, snapshot.plan);
      if (deliveryDigest(source) !== config.automaticPlan.sourceDigest) throw conflict("Jira 来源在授权后发生变化，请重新生成计划");
      authorizedJiraOrigin = source.origin;
    }
    const { historicalVerifications, ...persistedConfig } = config;
    const pinnedConfig: DeliveryWorkflowConfig = {
      ...(existing?.config ?? persistedConfig), template, ...(automaticRepairGrant && !existing ? { automaticRepairGrant } : {}), seatAssignment: "jira_assignee",
    };
    const sharedAnalysis = existing?.stages.find(stage => stage.stage === "analysis");
    const branchPlans = entry?.branches.map((branch, index) => ({
      ...branch, planned: planDeliveryWork(branch.config, deliveryBranchTemplate(template, branch.skipTestCases).definition,
        snapshot.plan.items, true, false, !!sharedAnalysis || index > 0),
    }));
    const existingStages = new Map(existing?.stages.filter(stage => stage.jiraKey).map(stage => [stage.jiraKey, stage]));
    const planned = branchPlans ? branchPlans.flatMap(branch => branch.planned.filter(node => !existingStages.has(node.key))) :
      planDeliveryWork(config, template.definition, snapshot.plan.items, true);
    if (entry) {
      const scope: NonNullable<DeliveryWorkflowConfig["entryScope"]> =
        structuredClone(registeredScope) ?? { branches: {}, requests: {}, jiraOrigin: entry.jiraOrigin };
      for (const branch of entry.branches)
        scope.branches[branch.key] = { digest: deliveryBranchDigest(snapshot.plan.items, branch.key, branch.skipTestCases), snapshotId: snapshot.id,
          ...(branch.skipTestCases ? { skipTestCases: branch.skipTestCases } : {}),
          ...(branch.afterParentKey ? { afterParentKey: branch.afterParentKey } : {}) };
      if (newlyIgnored.length) scope.ignoredParentKeys = [...ignored].sort();
      delete scope.acceptanceDigest;
      scope.requests[config.requestId] = { actor, digest: config.automaticPlan!.digest, inputDigest: config.automaticPlan!.inputDigest };
      pinnedConfig.entryScope = scope;
      if (planned.length + (existing?.stages.length ?? 0) > 1001)
        throw conflict("条目交付节点超出可处理范围");
    }
    const priorFor = (node: {stage: string; key: string | null}) => config.priorCompletions?.find(p => p.stage === node.stage && p.jiraKey === node.key);
    const historicalFor = (node: { key: string | null }) =>
      !!(config.automaticPlan && node.key && historicalVerifications?.[node.key]);
    for (const node of planned) {
      if (historicalFor(node)) {
        node.executionMode = "human";
        node.executorUserId = actor;
        node.seatId = "";
      }
    }
    const priorKeys = new Set<string>();
    for (const prior of config.priorCompletions ?? []) {
      const identity = `${prior.stage}:${prior.jiraKey}`;
      if (priorKeys.has(identity) || !planned.some(n => n.stage === prior.stage && n.key === prior.jiraKey))
        throw conflict("已有交付必须唯一绑定本次流程中的真实节点");
      priorKeys.add(identity);
      if (prior.stage !== "analysis" && !snapshot.plan.items.some(item => item.key === prior.jiraKey && ["已完成", "完成", "已关闭", "关闭", "已发版", "已发布", "done", "closed", "resolved", "released"].includes(item.status.trim().toLowerCase())))
        throw conflict("已有交付的来源工单尚未完成，请同步并核对来源状态");
    }
    const assignments=await readDeliveryJiraAssignments(store,c,snapshot.projectId,planned.filter(n=>n.key&&n.executionMode!=="human"&&!priorFor(n)).map(n=>n.key!));
    const companySeats=await tx.select().from(agents).where(eq(agents.companyId,c));
    if (config.automaticPlan) {
      for (const [id,digest] of Object.entries(config.automaticPlan.seatDigests)) {
        const seat=companySeats.find(s=>s.id===id);
        if (!seat || deliverySeatAuthorizationDigest(seat)!==digest) throw conflict("席位授权或 Harness 登记在授权后变化，请重新生成计划");
      }
    }
    for(const node of planned) {
      if(!node.key || node.executionMode==="human" || priorFor(node))continue;
      const assignment=assignments.get(node.key)!;
      const candidates=deliverySeatCandidates(companySeats,snapshot.projectId,assignment,stageKind(node.stage),stageRole(node.stage,node.intent));
      const explicit=config.workSeats?.find(b=>b.jiraKey===node.key)?.seatId || config.workTasks?.find(b=>b.jiraKey===node.key)?.seatId || config.codingTasks?.find(b=>b.jiraKey===node.key)?.seatId || config.reviewTasks?.find(b=>b.jiraKey===node.key)?.seatId;
      const preference=explicit || (candidates.some(s=>s.id===node.seatId)?node.seatId:undefined);
      node.seatId=chooseDeliverySeat(candidates,preference,node.key);
    }
    for(const node of planned.filter(n=>n.reviewWorkKeys&&n.executionMode!=="human"&&!priorFor(n)))if(planned.some(w=>node.reviewWorkKeys!.includes(w.key!)&&w.executionMode!=="human"&&!priorFor(w)&&w.seatId===node.seatId))throw conflict("Agent 评审必须使用不同于被审工作单的独立席位");
    if (
      planned.some(
        (item) => !priorFor(item) && ((!item.seatId && !(item.executionMode === "human" && item.executorUserId)) || (item.stage !== "analysis" && !item.key)),
      )
    )
      throw conflict("请为模板启用的每个阶段配置席位及真实工单");
    if (
      planned.some((item) => item.stage === "functional-test" && !priorFor(item) && !historicalFor(item)) &&
      !config.environmentReference
    )
      throw conflict("功能测试需要测试环境与待测构建准入引用");
    const keys = planned.flatMap((item) => (item.key ? [item.key] : []));
    for (const key of [...keys].sort())
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtextextended(${c + ":dsp7:" + key},0))`,
      );
    if (new Set(keys).size !== keys.length)
      throw conflict("每个交付阶段必须使用独立的真实子工单");
    const children = keys.map((key) => {
      const plannedItem = planned.find((item) => item.key === key)!;
      const item = snapshot.plan.items.find(
        (x) => x.key === key && x.parentKey,
      );
      if (!item || !matchesDeliveryWorkType(plannedItem.stage, !!plannedItem.reviewWorkKeys, item.type))
        throw conflict(key + " 不是该条目中对应类型的真实子工单");
      if (historicalFor(plannedItem) && !completedDeliverySource(item.status))
        throw conflict(key + " 的历史交付状态已变化，请重新生成计划");
      if (
        [
          "已完成",
          "完成",
          "已关闭",
          "关闭",
          "已取消",
          "取消",
          "已作废",
          "作废",
          "已发版",
          "已发布",
          "done",
          "closed",
          "cancelled",
          "canceled",
          "resolved",
          "released",
        ].includes(item.status.trim().toLowerCase()) && !priorFor(plannedItem) && !historicalFor(plannedItem)
      )
        throw conflict(key + " 已结束，不能自动重新执行");
      return item;
    });
    if (!entry && new Set(children.map((x) => x.parentKey)).size > 1)
      throw conflict("交付子工单必须属于同一真实主工单");
    const duplicate = await tx
      .select({ id: issues.id })
      .from(issues)
      .where(
        and(
          eq(issues.companyId, c),
          inArray(issues.status, [
            "backlog",
            "todo",
            "in_progress",
            "in_review",
            "blocked",
          ]),
          sql`(${sql.join(
            (keys.length ? keys : ["__analysis_only__"]).map(
              (key) =>
                deliveryActiveIssueIdentity(key),
            ),
            sql` or `,
          )})`,
        ),
      )
      .limit(1);
    if (keys.length && duplicate.length)
      throw conflict(
        "子工单已存在活动执行任务，请先处理已有任务，避免重复执行",
      );
    const stages: DeliveryStageRecord[] = [];
    for (const node of planned) {
      const { stage, seatId, key: jiraKey, intent, executionMode, reviewWorkKeys, executorUserId } = node;
      const historicalVerification = historicalFor(node);
      const prior = priorFor({stage, key: jiraKey});
      if (prior) {
        const taskId = randomUUID();
        const imported = prior.source === "jira" ? await readJiraPriorCompletion(store, c, snapshot.projectId, prior, children.find(item=>item.key===jiraKey)!.parentKey!, !!reviewWorkKeys) : prior;
        if (config.automaticPlan && stage === "analysis") {
          const [analysis] = await tx.select().from(analysisExecutions).where(and(eq(analysisExecutions.companyId,c),eq(analysisExecutions.projectId,snapshot.projectId),eq(analysisExecutions.demandNo,snapshot.demandNo))).orderBy(desc(analysisExecutions.createdAt),desc(analysisExecutions.revision),desc(analysisExecutions.id)).limit(1);
          if (!analysis || analysis.state!=="published" || !analysis.delivery || !analysis.publication || analysis.delivery.inputDigest!==analysis.publication.inputDigest || analysis.delivery.handoffDigest!==analysis.publication.handoffDigest || deliveryDigest({id:analysis.id,revision:analysis.revision,delivery:analysis.delivery,publication:analysis.publication})!==imported.version)
            throw conflict("正式分析交付已变化，请重新生成计划");
        }
        if (config.automaticPlan && config.automaticPlan.priorVersions[`${stage}:${jiraKey}`] !== imported.version)
          throw conflict("已有交付在授权后发生变化，请重新生成计划");
        const priorCompletion = {...imported, by: actor, at: new Date().toISOString(), snapshotId: snapshot.id};
        await tx.insert(issues).values({id:taskId, companyId:c, projectId:snapshot.projectId,
          title: snapshot.demandNo + " · " + DELIVERY_STAGE_LABELS[stage] + "（已有交付）",
          description: "历史交付；正式依据保存在交付流程节点。" + (jiraKey
            ? "\n<!-- DELIVERY-WORKFLOW " + JSON.stringify({ jira_key: jiraKey, project_id: snapshot.projectId }) + " -->"
            : ""),
          status:"done", completedAt:new Date(), priority:"medium", createdByUserId:actor === "local-board" ? null : actor});
        stages.push({stage,intent,reviewWorkKeys,taskId,seatId:"",ownerUserId:actor,jiraKey,
          parentKey:jiraKey ? children.find(item=>item.key===jiraKey)!.parentKey! : undefined,
          ...(entry ? { environmentReference: config.environmentReference, authorizedBy: actor } : {}),
          priorCompletion,dependsOn:[],dispatchId:randomUUID(),state:"done",runId:null,
          capabilityId:null,registryRevision:null,inputDigest:deliveryDigest({fingerprint:snapshot.fingerprint,priorCompletion}),
          receipt:null,receiptDigest:null,review:null,message:prior.source === "jira" ? "启动前已完成；已读取 Jira 历史交付材料" : "启动前已完成；管理员已核验已有交付依据"});
        continue;
      }
      const policy = template.definition.stages[stage];
      const [seat] = seatId ? await tx.select().from(agents).where(and(eq(agents.companyId,c),eq(agents.id,seatId))) : [];
      const owner = seatOwnerId(
        seat?.adapterConfig.dsp7Seat as Record<string, unknown>,
      );
      if (executionMode !== "human" && (
        !seat || !owner || seat.adapterConfig.dsp7Transport !== "outbound" ||
        ["paused", "terminated", "pending_approval"].includes(seat.status)
      ))
        throw conflict("请选择已绑定负责人、可接单的出站席位");
      const taskId = randomUUID(),
        route = executionMode === "human" ? null : resolveHarnessRoute(seat!, {
          runId: randomUUID(),
          taskId,
          kind: stageKind(stage),
          required: true,
        })!;
      if (
        executionMode !== "human" && (!route!.capability.roles.includes(stageRole(stage, intent)) || (stage === "coding" && !intent && policy.taskSequence !== "work_then_review" && !route!.capability.roles.includes("code-review")))
      )
        throw conflict(
          seat!.name + " 缺少 " + stageRole(stage,intent) + " 能力，请更新并登记对应原生 Harness",
        );
      const reviewer = executionMode === "human"
        ? executorUserId || (reviewWorkKeys && policy.review === "specified_user" ? policy.reviewerUserId : owner)
        : policy.review === "specified_user" ? policy.reviewerUserId : owner;
      if (executionMode === "human" && !reviewer) throw conflict("请为人工工单指定组织成员或配置默认席位负责人");
      const requiresReview = executionMode === "human" || (policy.review !== "none" && (policy.taskSequence !== "work_then_review" || !!reviewWorkKeys));
      if (requiresReview)
        await assertTemplateReviewer(store, c, reviewer!);
      await tx.insert(issues).values({
        id: taskId,
        companyId: c,
        projectId: snapshot.projectId,
        title: snapshot.demandNo + " · " + (intent === "design-review" ? "设计评审单" : intent === "test-case-review" ? "用例评审单" : intent === "code-review" ? "独立代码评审" : DELIVERY_STAGE_LABELS[stage]),
        description:
          "条目交付阶段；执行以交付流程授权、原生 Harness 门禁及回执为准。" +
          (jiraKey
            ? "\n<!-- DELIVERY-WORKFLOW " +
              JSON.stringify({
                jira_key: jiraKey,
                project_id: snapshot.projectId,
              }) +
              " -->"
            : ""),
        status: "backlog",
        priority: "medium",
        assigneeAgentId: executionMode === "human" ? null : seatId,
        assigneeUserId: executionMode === "human" ? reviewer : null,
        createdByUserId: actor === "local-board" ? null : actor,
      });
      if (stage === "analysis")
        await tx.insert(analysisExecutions).values({
          id: taskId,
          companyId: c,
          projectId: snapshot.projectId,
          seatId,
          ownerUserId: owner!,
          requestId: randomUUID(),
          createdBy: actor,
          title: snapshot.demandNo + " · 需求分析",
          brief:
            "请分析以下条目，并按原生流程产出可交接的需求分析材料。来源快照：" +
            JSON.stringify(snapshot.plan),
          demandNo: snapshot.demandNo,
        });
      stages.push({
        stage,
        intent,
        executionMode,
        ...(historicalVerification ? { historicalVerification: { jiraOrigin: authorizedJiraOrigin! } } : {}),
        reviewWorkKeys,
        ...(entry ? { environmentReference: config.environmentReference, authorizedBy: actor } : {}),
        taskId,
        seatId,
        ownerUserId: owner || reviewer!,
        jiraKey,
        parentKey: jiraKey
          ? children.find((item) => item.key === jiraKey)!.parentKey!
          : undefined,
        dependsOn: [],
        requiresReview,
        reviewerUserId: requiresReview ? reviewer! : undefined,
        startMode: historicalVerification ? "automatic" : policy.start,
        dispatchId: randomUUID(),
        state: "pending",
        runId: null,
        capabilityId: route?.capabilityId ?? null,
        registryRevision: route?.registryRevision ?? null,
        inputDigest: deliveryDigest({
          fingerprint: snapshot.fingerprint,
          stage,
        }),
        receipt: null,
        receiptDigest: null,
        review: null,
        message: historicalVerification ? historicalVerifications![jiraKey!] : null,
      });
    }
    let allStages: DeliveryStageRecord[];
    if (branchPlans) {
      const analysis = sharedAnalysis ?? stages.find(stage => stage.stage === "analysis");
      const newStages = new Map(stages.map(stage => [stage.jiraKey, stage]));
      const updatedParents = new Set(branchPlans.map(branch => branch.key));
      allStages = [...(analysis ? [analysis] : []), ...structuredClone(existing?.stages ?? []).filter(stage =>
        stage.stage !== "analysis" && (!stage.parentKey || !updatedParents.has(stage.parentKey)),
      )];
      const shared = analysis ? [analysis.taskId] : [];
      const groups = new Map<string, DeliveryStageRecord[]>();
      for (const stage of allStages) {
        if (!stage.parentKey) continue;
        const group = groups.get(stage.parentKey) ?? [];
        group.push(stage);
        groups.set(stage.parentKey, group);
      }
      for (const branch of branchPlans) {
        const group = branch.planned.filter(node => node.key).map(node => {
          const original = existingStages.get(node.key);
          return original ? { ...structuredClone(original), reviewWorkKeys: node.reviewWorkKeys } : newStages.get(node.key)!;
        });
        groups.set(branch.key, group);
        allStages.push(...group);
      }
      function wireBranch(key: string) {
        const afterParentKey = pinnedConfig.entryScope!.branches[key]?.afterParentKey;
        const upstream = afterParentKey ? (groups.get(afterParentKey) ?? []).map(stage => stage.taskId) : [];
        const group = groups.get(key)!;
        wireDeliveryWork(group, template.definition, [...shared, ...upstream]);
        return group;
      }
      for (const branch of branchPlans) wireBranch(branch.key);
      for (const branch of branchPlans.filter(candidate => candidate.scopeChanged)) {
        const group = groups.get(branch.key)!;
        const changed = new Set(group.filter(stage => {
          const original = existingStages.get(stage.jiraKey);
          return original && (
            deliveryDigest(original.dependsOn ?? []) !== deliveryDigest(stage.dependsOn) ||
            deliveryDigest(original.reviewWorkKeys ?? []) !== deliveryDigest(stage.reviewWorkKeys ?? [])
          );
        }).map(stage => stage.taskId));
        const affected = group.filter(stage => existingStages.has(stage.jiraKey) &&
          (changed.has(stage.taskId) || [...deliveryAncestors(group, stage.taskId)].some(id => changed.has(id))));
        // A downstream main was approved on the original upstream range.
        for (const key of deliveryDependentBranches(pinnedConfig.entryScope!, branch.key))
          affected.push(...wireBranch(key));
        if (affected.some(isHistoricalDelivery))
          throw conflict("范围变化影响接入前已有交付，请先在正式来源核对历史交付的适用范围");
        if (affected.length && !await reopenDeliveryStages(store, { companyId: c, stages: allStages }, affected, affected[0].taskId, {
          decision: "reject", digest: deliveryBranchDigest(snapshot.plan.items, branch.key, branch.skipTestCases),
          reference: new URL("/browse/" + branch.key, entry!.jiraOrigin).toString(),
          note: "主工单 " + branch.key + " 补充了工单，原交付或评审依赖已变化，请核对新的前置成果。",
          by: actor, at: new Date().toISOString(),
        }, "scope_change"))
          throw conflict("请先核验受影响节点的旧运行及进程树已停止");
        for (const stage of affected) stage.authorizedBy = actor;
      }
      allStages = orderDeliveryGraph(allStages);
    } else {
      wireDeliveryWork(stages, template.definition);
      allStages = stages;
    }
    assertDeliveryGraph(allStages);
    const newTasks = new Set(stages.map(stage => stage.taskId));
    const byTask = new Map(allStages.map(stage => [stage.taskId, stage]));
    for (const stage of allStages) {
      if (!newTasks.has(stage.taskId) || !stage.priorCompletion) continue;
      const waiting = (stage.dependsOn ?? []).map(id => byTask.get(id)!).filter(upstream => upstream.state !== "done");
      if (!waiting.length) continue;
      const completed = stage.priorCompletion;
      if (completed.source !== "jira" || !config.automaticPlan ||
          waiting.some(upstream => !upstream.historicalVerification && !upstream.deferredPriorCompletion))
        throw conflict("已有交付的前置节点也必须登记完成依据，不能依赖本次尚待执行的工作");
      const { stage: kind, jiraKey, passedTests, by, snapshotId, version, reviewReference } = completed;
      stage.deferredPriorCompletion = {
        prior: { stage: kind, jiraKey, passedTests, source: "jira", version: "", artifactReferences: [], reviewReference: "" },
        version, reference: reviewReference, by, snapshotId,
      };
      delete stage.priorCompletion;
      stage.state = "pending";
      stage.message = "等待前置节点核验后复核已有交付";
      await tx.update(issues).set({ status: "backlog", completedAt: null, updatedAt: new Date() })
        .where(and(eq(issues.id, stage.taskId), eq(issues.companyId, c)));
    }
    const [row] = existing
      ? await tx.update(deliveryWorkflows).set({
        config: pinnedConfig, stages: allStages, state: "active", acceptance: null, message: null, updatedAt: new Date(),
      }).where(eq(deliveryWorkflows.id, existing.id)).returning()
      : await tx.insert(deliveryWorkflows).values({
        companyId: c, projectId: snapshot.projectId, snapshotId: snapshot.id,
        demandNo: snapshot.demandNo, fingerprint: snapshot.fingerprint, requestId: config.requestId,
        createdBy: actor, config: pinnedConfig, stages: allStages,
      }).returning();
    const action = existing ? entry?.branches.length ? "delivery.workflow.branches_started" : "delivery.workflow.main_issues_ignored" : "delivery.workflow.started";
    await workflowAudit(store, c, actor, action, row.id, {
      ...(entry ? { branches: entry.branches.map(({ key, excluded, scopeChanged, afterParentKey, skipTestCases }) =>
        ({ key, excluded, scopeChanged, afterParentKey, ...(skipTestCases ? { skipTestCases } : {}) })) } : {}),
      ...(newlyIgnored.length ? { ignoredParentKeys: newlyIgnored } : {}),
      ...(existing?.acceptance ? { previousAcceptance: existing.acceptance } : {}),
      snapshotId: snapshot.id,
      stages: stages.map((s) => ({
        stage: s.stage,
        taskId: s.taskId,
        seatId: s.seatId,
        jiraKey: s.jiraKey,
      })),
      priorCompletions: stages.filter(s=>s.priorCompletion).map(s=>({taskId:s.taskId, ...s.priorCompletion})),
      ...(entryAdmission ? { entryAdmission: { templateId: template.id, templateRevision: template.revision, startStage: entryAdmission.startStage, checks: entryAdmission.checks } } : {}),
      automaticExecutionGranted: stages.length > 0,
    });
    return row;
  });
}
export async function startDeliveryRepair(
  db: Db, companyId: string, actor: string, id: string,
  config: DeliveryRepairConfig, automatic = false,
) {
  await authorized(db, companyId, actor);
  return db.transaction(async tx => {
    const store = tx as unknown as Db;
    const [flow] = await tx.select().from(deliveryWorkflows)
      .where(and(eq(deliveryWorkflows.id, id), eq(deliveryWorkflows.companyId, companyId))).for("update");
    if (!flow) throw notFound("交付流程不存在");
    const branched = !!flow.config.entryScope;
    const failed = deliveryRepairCandidates(flow.stages, branched).find(stage => stage.receiptDigest === config.expectedReceiptDigest);
    if (flow.state !== (branched ? "active" : "blocked") || failed?.stage !== "functional-test" || !failed.receipt?.testResults?.failed || failed.receiptDigest !== config.expectedReceiptDigest)
      throw conflict("只能为当前版本已确认失败的功能测试发起原任务返工");
    await assertWorkflowSource(store, flow, failed);
    const policy = flow.config.template?.definition.automaticRepair;
    if (!policy) throw conflict("请先配置测试失败返工策略及修复构建回读地址");
    if (automatic && !flow.config.automaticRepairAuthorized) throw conflict("本实例未授权自动返工");
    const route = automaticRepairRoute(failed, policy);
    const nodes = existingRepairNodes(flow, failed, route);
    const targets = [nodes.work, nodes.review, ...nodes.tests];
    if (config.defectKey !== nodes.work.jiraKey || config.reviewKey !== nodes.review.jiraKey || config.retestKey !== nodes.test.jiraKey ||
        config.developmentSeatId !== nodes.work.seatId || config.reviewSeatId !== nodes.review.seatId || config.qaSeatId !== nodes.test.seatId)
      throw conflict("返工仅可复用本交付链的原编码、原代码评审和原功能测试任务，不能绑定新增工单或转派席位");
    if ((failed.repairHistory?.length ?? 0) >= Math.min(policy.maxCycles, DELIVERY_MAX_REPAIR_CYCLES))
      throw conflict("已达到修复轮数上限，请人工核对");
    if (automatic) {
      const grant = flow.config.automaticRepairGrant;
      if (!grant) throw conflict("本实例缺少原席位自动返工授权");
      const seats = await assertAutomaticRepairSeats(store, flow, policy, grant.jiraOrigin);
      for (const node of [nodes.work, nodes.review, nodes.test]) {
        const seat = seats.find(s => s.id === node.seatId), pinned = grant.seats.find(s => s.seatId === node.seatId);
        if (!seat || !pinned || pinned.account !== (seat.adapterConfig.dsp7JiraDispatch as { jiraAssignee: string }).jiraAssignee || pinned.ownerUserId !== seatOwnerId(seat.adapterConfig.dsp7Seat as Record<string, unknown>))
          throw conflict("已授权的原席位账号或负责人已变化，请核对");
      }
    }
    const assignments = await readDeliveryJiraAssignments(store, companyId, flow.projectId, targets.map(n=>n.jiraKey!));
    const seats = await tx.select().from(agents).where(eq(agents.companyId, companyId));
    for (const node of targets) {
      if (node.executionMode === "human") continue;
      const seat=seats.find(s=>s.id===node.seatId);
      if(!(seat?.adapterConfig.dsp7SeatPresence as {capabilities?:string[]}|undefined)?.capabilities?.includes("delivery-reuse-repair-v1"))throw conflict("请更新所有原回归测试席位客户端以支持原任务返工");
      chooseDeliverySeat(deliverySeatCandidates(seats, flow.projectId, assignments.get(node.jiraKey!)!, stageKind(node.stage), stageRole(node.stage, node.intent)), node.seatId, node.jiraKey!);
      await assertSeatBudgetAdmission(store, { companyId, agentId: node.seatId, projectId: flow.projectId, taskId: node.taskId });
    }
    const failure = { receipt: failed.receipt, receiptDigest: failed.receiptDigest! };
    const history = failed.repairHistory ?? [];
    const cycle = { attempt: history.length + 1, taskId: failed.taskId, runId: failed.runId!, receipt: failed.receipt, receiptDigest: failed.receiptDigest!,
      defectKey: nodes.work.jiraKey!, reviewKey: nodes.review.jiraKey!, retestKey: failed.jiraKey!, by: actor, at: new Date().toISOString() };
    const note = "功能测试发现问题，请在原编码单修改，原评审单复审，原功能测试单回归：" +
      failed.receipt.failureReport!.defects.map(d => `${d.caseId} ${d.summary}；复现：${d.steps}；预期：${d.expected}；实际：${d.actual}`).join("\n");
    const rejection = { decision: "reject" as const, digest: failed.receiptDigest!, reference: failed.receipt.jiraReference, note, by: actor, at: new Date().toISOString() };
    if (!await reopenDeliveryStages(store, flow, targets, failed.taskId, rejection))
      throw conflict("请先核验原编码、代码评审及测试旧运行的进程树全部停止");
    for (const node of targets) {
      node.repairReused = true;
      node.repairFailure = failure;
      delete node.automaticRepair;
      delete node.expectedBuild;
    }
    // Existing test-case tasks remain completed; regression must additionally wait
    // for the current round of the same code-review task.
    for(const test of nodes.tests) {
      test.dependsOn = [...new Set([...(test.dependsOn ?? []), nodes.review.taskId])];
      test.repairHistory = [...(test.taskId===failed.taskId?history:test.repairHistory??[]), cycle];
    }
    const [updated] = await tx.update(deliveryWorkflows).set({ stages: flow.stages, state: "active", message: "已将测试问题派回原编码任务，等待原代码评审及原功能测试节点重新办理", updatedAt: new Date() })
      .where(eq(deliveryWorkflows.id, id)).returning();
    await workflowAudit(store, companyId, actor, automatic ? "delivery.repair.automatically_started" : "delivery.repair.started", id,
      { attempt: cycle.attempt, failedTaskId: failed.taskId, failedReceiptDigest: failure.receiptDigest, mode: "reuse_existing", tasks: targets.map(s => ({ taskId: s.taskId, jiraKey: s.jiraKey, seatId: s.seatId })) });
    return updated;
  });
}

export async function assertWorkflowSource(
  db: Db,
  flow: typeof deliveryWorkflows.$inferSelect,
  stage?: DeliveryStageRecord,
  accepting = false,
) {
  const [project] = await db
    .select()
    .from(projects)
    .where(
      and(
        eq(projects.id, flow.projectId),
        eq(projects.companyId, flow.companyId),
      ),
    );
  const [pinned] = await db
    .select()
    .from(deliverySnapshots)
    .where(
      and(
        eq(deliverySnapshots.id, flow.snapshotId),
        eq(deliverySnapshots.companyId, flow.companyId),
      ),
    );
  if (!project || project.archivedAt || !pinned)
    throw conflict("项目或来源已不可用");
  const [latest] = await db
    .select()
    .from(deliverySnapshots)
    .where(
      and(
        eq(deliverySnapshots.companyId, flow.companyId),
        eq(deliverySnapshots.projectId, flow.projectId),
        eq(deliverySnapshots.demandNo, flow.demandNo),
        eq(deliverySnapshots.sourceOrigin, pinned.sourceOrigin),
      ),
    )
    .orderBy(
      desc(deliverySnapshots.collectedAt),
      desc(deliverySnapshots.createdAt),
      desc(deliverySnapshots.id),
    )
    .limit(1);
  if (!flow.config.entryScope) {
    if (!latest || latest.fingerprint !== flow.fingerprint)
      throw conflict("来源输入已变化，请重新核验交付版本");
    if (accepting && latest.plan.mains.length > 1)
      throw conflict("请先在条目交付计划中启动其余主工单");
    return latest;
  }
  if (!latest || deliveryEntryInput(pinned.plan) !== deliveryEntryInput(latest.plan))
    throw conflict("条目需求输入已变化，请核对正式交付范围");
  if (stage?.parentKey) {
    if (!deliveryBranchMatches(latest.plan, flow.config, stage.parentKey))
      throw conflict(stage.parentKey + " 的工单范围已变化，请核对交付计划");
    const afterParentKey = flow.config.entryScope.branches[stage.parentKey]?.afterParentKey;
    if (afterParentKey && !deliveryBranchVerified(latest.plan, flow.config, flow.stages, afterParentKey))
      throw conflict("前置主工单 " + afterParentKey + " 未完成交付核验或范围已变化");
  }
  if (accepting) {
    const source = await readAutomaticDeliverySource(db, flow.companyId, flow.projectId, latest.plan);
    if (source.origin !== flow.config.entryScope.jiraOrigin || !deliveryEntryScopeComplete({ ...latest.plan, items: source.items }, flow.config))
      throw conflict("仍有主工单未启动或来源范围已变化，请同步并核对交付计划");
  }
  return latest;
}
export async function assertDeliveryRun(
  db: Db,
  companyId: string,
  agentId: string,
  runId: string,
) {
  const [run] = await db
    .select()
    .from(heartbeatRuns)
    .where(
      and(
        eq(heartbeatRuns.id, runId),
        eq(heartbeatRuns.companyId, companyId),
        eq(heartbeatRuns.agentId, agentId),
      ),
    );
  const [flow] = run
    ? await db
        .select()
        .from(deliveryWorkflows)
        .where(
          and(
            eq(
              deliveryWorkflows.id,
              String(run.contextSnapshot?.deliveryWorkflowId ?? ""),
            ),
            eq(deliveryWorkflows.companyId, companyId),
          ),
        )
    : [];
  const stage = flow?.stages.find(
    (s) =>
      s.taskId === run?.contextSnapshot?.issueId &&
      s.dispatchId === run?.contextSnapshot?.deliveryDispatchId,
  );
  const [agent] = await db
    .select()
    .from(agents)
    .where(and(eq(agents.id, agentId), eq(agents.companyId, companyId)));
  const [issue] = stage
    ? await db
        .select()
        .from(issues)
        .where(
          and(eq(issues.id, stage.taskId), eq(issues.companyId, companyId)),
        )
    : [];
  if (
    !flow ||
    flow.state !== "active" ||
    !stage ||
    stage.seatId !== agentId ||
    stage.runId !== runId ||
    !agent ||
    !issue ||
    issue.assigneeAgentId !== agentId ||
    issue.status === "cancelled" ||
    stage.ownerUserId !==
      seatOwnerId(agent.adapterConfig.dsp7Seat as Record<string, unknown>)
  )
    throw conflict("交付阶段授权、负责人或任务已变化");
  if (
    !deliveryStageCanStart(stage) ||
    !readyDeliveryStages(flow.stages).some((s) => s.taskId === stage.taskId)
  )
    throw conflict("阶段前置依赖尚未通过或未确认启动");
  await authorized(db, companyId, stage.authorizedBy ?? flow.createdBy);
  await assertWorkflowSource(db, flow, stage);
  if(flow.config.seatAssignment === "jira_assignee" && stage.jiraKey) {
    const current=await readDeliveryJiraAssignments(db,companyId,flow.projectId,[stage.jiraKey]);
    if(!deliverySeatMatchesAssignee(agent,flow.projectId,current.get(stage.jiraKey)!))throw conflict("Jira 经办人或席位账号已变化，请核对交付授权");
  }
  const route = resolveHarnessRoute(agent, {
    runId,
    taskId: stage.taskId,
    kind: stageKind(stage.stage),
    required: true,
  })!;
  if (
    route.capabilityId !== stage.capabilityId ||
    route.registryRevision !== stage.registryRevision
  )
    throw conflict("交付授权的 Harness 路由已变化");
  return { flow, stage, run: run!, agent, issue };
}
/** Human delivery evidence participates in the same dependency/version chain as native receipts. */
export function completedDeliveryDigest(stage: DeliveryStageRecord) {
  if (stage.state !== "done") return null;
  if (stage.priorCompletion) return deliveryDigest({inputDigest:stage.inputDigest, priorCompletion:stage.priorCompletion});
  return stage.executionMode === "human"
    ? stage.review?.decision === "approve" ? deliveryDigest({inputDigest:stage.inputDigest,review:stage.review,manualDelivery:stage.manualDelivery}) : null
    : stage.receiptDigest;
}
export function humanReviewInputDigest(flow: Pick<DeliveryWorkflow, "fingerprint" | "stages">, stage: DeliveryStageRecord) {
  const upstream=(stage.dependsOn??[]).map(id=>flow.stages.find(s=>s.taskId===id));
  if((stage.reviewWorkKeys && !upstream.length)||upstream.some(s=>!s||!completedDeliveryDigest(s)))throw conflict("人工任务的前置交付尚未完成或缺少版本证据");
  return deliveryDigest({fingerprint:flow.fingerprint,taskId:stage.taskId,jiraKey:stage.jiraKey,reviewerUserId:stage.reviewerUserId,rework:stage.reworkHistory?.map(r=>({round:r.round,rejection:r.rejection})),upstream:upstream.map(s=>({taskId:s!.taskId,jiraKey:s!.jiraKey,receiptDigest:completedDeliveryDigest(s!)}))});
}
export async function assertHumanReviewScope(db: Db, flow: typeof deliveryWorkflows.$inferSelect, stage: DeliveryStageRecord) {
  await authorized(db, flow.companyId, stage.authorizedBy ?? flow.createdBy);
  const latest = await assertWorkflowSource(db, flow, stage);
  if(stage.executionMode!=="human"||!readyDeliveryStages(flow.stages).some(s=>s.taskId===stage.taskId)||stage.inputDigest!==humanReviewInputDigest(flow,stage))throw conflict("任务前置或交付版本已变化");
  if(stage.seatId) {
    const [seat]=await db.select().from(agents).where(and(eq(agents.id,stage.seatId),eq(agents.companyId,flow.companyId)));
    if(!seat||seatOwnerId(seat.adapterConfig.dsp7Seat as Record<string, unknown>)!==stage.ownerUserId)throw conflict("任务席位负责人已变化，请核对流程");
  }
  await assertTemplateReviewer(db,flow.companyId,stage.reviewerUserId!);
  const [task]=await db.select().from(issues).where(and(eq(issues.id,stage.taskId),eq(issues.companyId,flow.companyId)));
  if(!task||task.assigneeUserId!==stage.reviewerUserId||task.status==="cancelled")throw conflict("人工任务负责人或状态已变化");
  return latest;
}
export async function assertHistoricalVerificationSource(
  db: Db,
  flow: typeof deliveryWorkflows.$inferSelect,
  stage: DeliveryStageRecord,
  latest: typeof deliverySnapshots.$inferSelect,
  reference: URL,
) {
  const source = await readAutomaticDeliverySource(db, flow.companyId, flow.projectId, latest.plan);
  const item = source.items.find(row => row.key === stage.jiraKey);
  if (reference.origin !== source.origin || source.origin !== stage.historicalVerification?.jiraOrigin ||
      !item || item.parentKey !== stage.parentKey ||
      !matchesDeliveryWorkType(stage.stage, !!stage.reviewWorkKeys, item.type) || !completedDeliverySource(item.status))
    throw conflict("正式 Jira 工单的来源、类型或完成状态已变化，请核对后再登记");
}
/** Terminal adapter status alone never advances the business stage. */
export function nextDeliveryAction(
  stages: DeliveryStageRecord[],
): "dispatch" | "wait" | "acceptance" {
  const available = readyDeliveryStages(stages);
  const s =
    available.find(
      (s) =>
        (s.state === "pending" || (s.state === "queued" && !s.runId)) &&
        deliveryStageCanStart(s),
    ) ?? available[0];
  if (!s) return stages.some((s) => s.state !== "done") ? "wait" : "acceptance";
  return deliveryStageCanStart(s) &&
    (s.state === "pending" || (s.state === "queued" && !s.runId))
    ? "dispatch"
    : "wait";
}
/** Pin confirmations and dispatches to the same current upstream/rework version. */
function executionInputDigest(
  flow: Pick<DeliveryWorkflow, "fingerprint" | "stages" | "config">,
  stage: DeliveryStageRecord,
) {
  return deliveryDigest({
    fingerprint: flow.fingerprint,
    stage: stage.stage,
    intent: stage.intent ?? null,
    repairFailure: stage.repairFailure?.receiptDigest ?? null,
    rework: stage.reworkHistory?.map(r => ({ round: r.round, rejection: r.rejection })),
    upstream: flow.stages
      .filter(s => stage.dependsOn ? stage.dependsOn.includes(s.taskId) : s.state === "done")
      .map(completedDeliveryDigest),
    environmentReference: stage.environmentReference ?? flow.config.environmentReference,
  });
}
async function refreshDeliveryAcceptance(db: Db, id: string) {
  await db.transaction(async tx => {
    const [flow] = await tx.select().from(deliveryWorkflows).where(eq(deliveryWorkflows.id, id)).for("update");
    if (flow?.state !== "acceptance" || !flow.config.entryScope) return;
    const latest = await assertWorkflowSource(tx as unknown as Db, flow).catch(() => undefined);
    const ready = !!latest && deliveryEntryScopeComplete(latest.plan, flow.config);
    if (ready && flow.config.entryScope.checkedSnapshotId === latest.id) return;
    if (latest) flow.config.entryScope.checkedSnapshotId = latest.id;
    if (!ready) delete flow.config.entryScope.acceptanceDigest;
    await tx.update(deliveryWorkflows).set({
      config: flow.config,
      ...(ready ? {} : { state: "active" as const, message: "部分交付，来源范围已变化，请核对交付计划" }),
      updatedAt: new Date(),
    }).where(eq(deliveryWorkflows.id, id));
  });
}

export async function reconcileDeliveryWorkflow(db: Db, id: string) {
  const [flow] = await db
    .select()
    .from(deliveryWorkflows)
    .where(eq(deliveryWorkflows.id, id));
  if (!flow) return;
  if (flow.state === "acceptance" && flow.config.entryScope) return refreshDeliveryAcceptance(db, id);
  if (flow.state === "blocked" || (flow.state === "active" && flow.config.entryScope)) {
    for (const failed of deliveryRepairCandidates(flow.stages, !!flow.config.entryScope)) {
      await reconcileAutomaticRepair(db, flow, config => startDeliveryRepair(db, flow.companyId, flow.createdBy, flow.id, config, true),
        () => assertWorkflowSource(db, flow, failed).then(() => undefined), failed);
    }
  }
  if (flow.state !== "active") return;
  const ready = readyDeliveryStages(flow.stages);
  if (!ready.length) {
    await reconcileDeliveryWorkflowStage(db, id);
    return;
  }
  for (const stage of ready)
    await reconcileDeliveryWorkflowStage(db, id, stage.taskId);
}
async function reconcileDeliveryWorkflowStage(
  db: Db,
  id: string,
  taskId?: string,
) {
  let dispatchReady = false;
  // Lock spans wakeup and assignment: duplicate schedulers cannot create two stage launches.
  // Heartbeat uses its own durable idempotency key; a crash after wakeup is recovered by that key.
  await db.transaction(async (tx) => {
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${id + ":delivery-tick"},0))`,
    );
    const store = tx as unknown as Db;
    const [flow] = await tx
      .select()
      .from(deliveryWorkflows)
      .where(eq(deliveryWorkflows.id, id))
      .for("update");
    if (!flow || flow.state !== "active") return;
    const save = async (message: string | null, state = flow.state) => {
      await tx
        .update(deliveryWorkflows)
        .set({ stages: flow.stages, message, state, ...(state === "acceptance" ? { config: flow.config } : {}), updatedAt: new Date() })
        .where(eq(deliveryWorkflows.id, id));
    };
    try {
      const stage = taskId
        ? readyDeliveryStages(flow.stages).find(candidate => candidate.taskId === taskId)
        : undefined;
      if (taskId && !stage) return;
      await authorized(store, flow.companyId, stage?.authorizedBy ?? flow.createdBy);
      let latest;
      try {
        latest = await assertWorkflowSource(store, flow, stage);
      } catch (error) {
        const message = error instanceof Error ? error.message : "来源读取失败";
        if (flow.config.entryScope) {
          if (stage && stage.message !== message) {
            stage.message = message;
            await save(null);
          }
        } else {
          await save("来源输入已变化或不可用，已停止自动推进。 " + message, "blocked");
        }
        return;
      }
      const block = async (target: DeliveryStageRecord, message: string) => {
        if (flow.config.entryScope && target.parentKey) {
          target.branchBlocked = true;
          target.message = message;
          await save(null);
        } else {
          await save(message, "blocked");
        }
      };
      const rejected = flow.stages.find(candidate => candidate.review?.decision === "reject" &&
        !candidate.branchBlocked && (!flow.config.entryScope || candidate.parentKey === stage?.parentKey));
      if (rejected) {
        if (deliveryReworkScope(flow.stages, rejected).some(isHistoricalDelivery)) {
          await block(rejected, "退回涉及启动前的已有交付，请先在来源流程处理并重新核对");
          return;
        }
        const prepared = await prepareDeliveryRework(store, flow, rejected);
        if (prepared) await workflowAudit(store, flow.companyId, rejected.reworkHistory!.at(-1)!.rejection.by, "delivery.review.rework.started", flow.id, {reviewTaskId:rejected.taskId, round:rejected.reworkHistory!.length});
        await save(prepared ? "已退回原执行人返工，完成后重新送审" : "评审已退回，等待旧运行及进程树停止核验后自动返工");
        return;
      }
      if (!stage) {
        if (flow.stages.some(candidate => candidate.state !== "done")) return;
        if (flow.config.entryScope && !deliveryEntryScopeComplete(latest.plan, flow.config)) {
          const message = "部分交付，等待其余主工单启动或核对范围变更";
          await save(message);
          return;
        }
        if (flow.config.entryScope) {
          flow.config.entryScope.checkedSnapshotId = latest.id;
          flow.config.entryScope.acceptanceDigest = deliveryDigest({
            fingerprint: flow.fingerprint,
            branches: flow.config.entryScope.branches,
            ...(flow.config.entryScope.ignoredParentKeys?.length ? { ignoredParentKeys: flow.config.entryScope.ignoredParentKeys } : {}),
            stages: flow.stages.map(stage => ({ taskId: stage.taskId, version: completedDeliveryDigest(stage) })),
          });
        }
        await save("各环节交付已核验，等待主需求负责人正式验收", "acceptance");
        return;
      }
      if (stage.deferredPriorCompletion) {
        const pending = stage.deferredPriorCompletion;
        let imported;
        try {
          imported = await readJiraPriorCompletion(
            store, flow.companyId, flow.projectId, pending.prior, stage.parentKey!, !!stage.reviewWorkKeys,
          );
        } catch (error) {
          if (!(error instanceof MissingJiraPriorEvidence)) {
            const message = error instanceof Error ? error.message : "历史成果复核失败";
            if (stage.message !== message) {
              stage.message = message;
              await save(null);
            }
            return;
          }
        }
        if (!imported || pending.version !== imported.version || pending.reference !== imported.reviewReference) {
          await assertTemplateReviewer(store, flow.companyId, pending.by);
          delete stage.deferredPriorCompletion;
          stage.historicalVerification = { jiraOrigin: new URL(pending.reference).origin };
          stage.executionMode = "human";
          stage.requiresReview = true;
          stage.reviewerUserId = pending.by;
          stage.startMode = "automatic";
          stage.message = "历史成果材料已变化，请核对正式结论和当前版本";
          await tx.update(issues).set({ assigneeUserId: pending.by, updatedAt: new Date() })
            .where(and(eq(issues.id, stage.taskId), eq(issues.companyId, flow.companyId)));
          await save(null);
          return;
        }
        stage.priorCompletion = { ...imported, by: pending.by, at: new Date().toISOString(), snapshotId: pending.snapshotId };
        delete stage.deferredPriorCompletion;
        stage.inputDigest = executionInputDigest(flow, stage);
        stage.state = "done";
        stage.message = "前置节点已核验，Jira 历史交付已复核";
        await tx.update(issues).set({ status: "done", completedAt: new Date(), updatedAt: new Date() })
          .where(and(eq(issues.id, stage.taskId), eq(issues.companyId, flow.companyId)));
        await workflowAudit(store, flow.companyId, pending.by, "delivery.stage.historical_delivery.reused", flow.id, {
          taskId: stage.taskId, jiraKey: stage.jiraKey, version: pending.version,
        });
        await save(null);
        return;
      }
      if (!deliveryStageCanStart(stage)) {
        stage.inputDigest = executionInputDigest(flow, stage);
        stage.waitingSince ??= new Date().toISOString();
        await save("等待负责人确认启动本阶段");
        return;
      }
      if (stage.automaticRepairGenerated && stage.intent==="retest" || stage.repairReused && stage.stage==="functional-test") {
        const fix=flow.stages.find(s=>(s.intent==="bugfix" || s.repairReused && s.stage==="coding" && !s.reviewWorkKeys)&&s.repairFailure?.receiptDigest===stage.repairFailure?.receiptDigest);
        const build=fix?.receipt?.build;
        const policy=flow.config.template?.definition.automaticRepair;
        if (!build || build.observationUrl!==policy?.buildObservationUrl || build.environmentReference!==(stage.environmentReference ?? flow.config.environmentReference) || build.version===stage.repairFailure?.receipt.testResults?.testedVersion)
          throw conflict("修复构建缺失、仍为失败版本或环境／回读地址与授权不一致");
        stage.expectedBuild=build;
      }
      if (stage.executionMode === "human") {
        const [reviewSeat]=stage.seatId ? await tx.select().from(agents).where(and(eq(agents.id,stage.seatId),eq(agents.companyId,flow.companyId))) : [];
        if(stage.seatId && (!reviewSeat||seatOwnerId(reviewSeat.adapterConfig.dsp7Seat as Record<string,unknown>)!==stage.ownerUserId))throw conflict("评审席位负责人已变化");
        await assertTemplateReviewer(store, flow.companyId, stage.reviewerUserId!);
        const inputDigest=humanReviewInputDigest(flow,stage);
        if(stage.state==="pending") {
          stage.inputDigest=inputDigest;stage.state="review";stage.waitingSince=new Date().toISOString();
          if (!stage.historicalVerification)
            stage.message=stage.reviewWorkKeys ? "前置工作单已交付，请负责人完成真实评审单并登记当前版本正式结论" : "请指定负责人完成人工工作单，登记交付版本、材料和正式完成结论";
          await tx.update(issues).set({status:stage.reviewWorkKeys ? "in_review" : "in_progress",updatedAt:new Date()}).where(and(eq(issues.id,stage.taskId),eq(issues.companyId,flow.companyId)));
        } else if(stage.inputDigest!==inputDigest)throw conflict("人工评审的被审交付版本已变化");
        await save(stage.message);return;
      }
      if (stage.stage === "analysis") {
        const [analysis] = await tx
          .select()
          .from(analysisExecutions)
          .where(eq(analysisExecutions.id, stage.taskId));
        stage.runId = analysis.activeRunId;
        if (
          analysis.state === "published" &&
          analysis.publication &&
          analysis.delivery &&
          analysis.publication.inputDigest === analysis.delivery.inputDigest &&
          analysis.publication.handoffDigest === analysis.delivery.handoffDigest
        ) {
          const [run] = stage.runId
            ? await tx
                .select()
                .from(heartbeatRuns)
                .where(
                  and(
                    eq(heartbeatRuns.id, stage.runId),
                    eq(heartbeatRuns.companyId, flow.companyId),
                    eq(heartbeatRuns.agentId, stage.seatId),
                  ),
                )
            : [];
          const [permit] = stage.runId
            ? await tx
                .select()
                .from(seatExecutionPermits)
                .where(
                  and(
                    eq(seatExecutionPermits.runId, stage.runId),
                    eq(seatExecutionPermits.companyId, flow.companyId),
                    eq(seatExecutionPermits.agentId, stage.seatId),
                    eq(seatExecutionPermits.taskId, stage.taskId),
                  ),
                )
            : [];
          if (
            !run ||
            ["queued", "running", "scheduled_retry"].includes(run.status) ||
            !permit?.treeStopVerifiedAt
          ) {
            stage.state = "review";
            await save("分析发布已登记，等待本机进程树退出核验");
            return;
          }
          stage.state = "done";
          stage.receiptDigest = deliveryDigest(analysis.delivery);
          await save(null);
          return;
        }
        if (stage.runId) {
          const [run] = await tx
            .select()
            .from(heartbeatRuns)
            .where(eq(heartbeatRuns.id, stage.runId));
          stage.state = analysis.delivery
            ? "review"
            : analysis.state === "waiting"
              ? "waiting"
              : "running";
          if (
            run &&
            !["queued", "running", "scheduled_retry"].includes(run.status) &&
            !analysis.delivery
          ) {
            stage.state = "interrupted";
            await save("需求分析运行中断，请打开分析任务处理");
            return;
          }
          await save(
            analysis.delivery
              ? "需求分析已交付，请在分析任务登记正式发布结论"
              : null,
          );
          return;
        }
        // Analysis command needs its own transactions; handled after this lock transaction below.
        await save("等待分析席位上线并开始需求分析");
        dispatchReady = true;
        return;
      }
      if (stage.runId) {
        const [run] = await tx
          .select()
          .from(heartbeatRuns)
          .where(eq(heartbeatRuns.id, stage.runId));
        if (stage.receipt) {
          if (
            reviewRequired(stage.stage, stage) &&
            (stage.review?.decision !== "approve" ||
              stage.review.digest !== stage.receiptDigest)
          ) {
            stage.state = "review";
            await save("等待负责人核验当前版本正式评审结论");
            return;
          }
          const [permit] = await tx
            .select()
            .from(seatExecutionPermits)
            .where(eq(seatExecutionPermits.runId, stage.runId));
          if (
            !run ||
            ["queued", "running", "scheduled_retry"].includes(run.status) ||
            !permit?.treeStopVerifiedAt
          ) {
            await save("交付已收到，等待本机进程树退出核验");
            return;
          }
          if (stage.automaticRepairGenerated && stage.intent==="code-review" && stage.receipt.codeReview?.decision==="rejected") {
            if ((stage.reworkHistory?.length??0)>=(flow.config.template?.definition.automaticRepair?.maxCycles??3)) {
              await block(stage, "自动代码评审退回已达上限，请人工处理");return;
            }
            stage.review={decision:"reject",digest:stage.receiptDigest!,reference:stage.receipt.jiraReference,note:stage.receipt.codeReview.note!,by:"agent:"+stage.seatId,at:new Date().toISOString()};
            await workflowAudit(store,flow.companyId,"agent:"+stage.seatId,"delivery.code_review.automatically_rejected",flow.id,{taskId:stage.taskId,receiptDigest:stage.receiptDigest});
            await save("独立代码评审退回，将按原生返工协议派回修复席位");return;
          }
          if (stage.receipt.codeReview?.decision === "rejected") {
            // Ordered reviews identify the original work and its dependent closure.
            if (stage.reviewWorkKeys?.length) {
              stage.review = {
                decision: "reject",
                digest: stage.receiptDigest!,
                reference: stage.receipt.jiraReference,
                note: stage.receipt.codeReview.note!,
                by: "agent:" + stage.seatId,
                at: new Date().toISOString(),
              };
              await workflowAudit(
                store, flow.companyId, "agent:" + stage.seatId,
                "delivery.code_review.automatically_rejected", flow.id,
                { taskId: stage.taskId, receiptDigest: stage.receiptDigest },
              );
              if (flow.config.template?.definition.stages.coding.rejectionHandling === "automatic_rework") {
                if ((stage.reworkHistory?.length ?? 0) >= DELIVERY_STAGE_MAX_RESUMES) {
                  await block(stage, "自动代码评审返工已达上限，请人工核对后处理");
                  return;
                }
                await save("独立代码评审退回，等待按模板派回原研发席位修改");
                return;
              }
            }
            await block(stage, "代码评审未通过，已暂停等待人工处理");
            return;
          }
          if (stage.stage === "functional-test") {
            const result = stage.receipt.testResults;
            if (
              !result ||
              result.failed ||
              result.blocked ||
              result.skipped ||
              result.passed !== result.total
            ) {
              stage.state = "review";
              await block(stage, "测试存在失败、阻塞、跳过或缺少结果，需修复并独立复审后重测；报告交付不等于测试通过");
              return;
            }
          }
          stage.state = "done";
          await tx
            .update(issues)
            .set({ status: "done", updatedAt: new Date() })
            .where(eq(issues.id, stage.taskId));
          await save(null);
          return;
        }
        if (
          run &&
          !["queued", "running", "scheduled_retry"].includes(run.status)
        ) {
          stage.state = "interrupted";
          await save("运行已结束但无有效交付回执，请处理后重试");
          return;
        }
        await save(stage.message);
        return;
      }
      if (!deliveryStageCanStart(stage)) {
        await save("等待负责人确认启动本阶段");
        return;
      }
      const [seat] = await tx
        .select()
        .from(agents)
        .where(
          and(
            eq(agents.id, stage.seatId),
            eq(agents.companyId, flow.companyId),
          ),
        )
        .for("update");
      if (
        !seat ||
        seatOwnerId(seat.adapterConfig.dsp7Seat as Record<string, unknown>) !==
          stage.ownerUserId
      )
        throw conflict("席位负责人已变化");
      if(flow.config.seatAssignment === "jira_assignee" && stage.jiraKey) {
        const current=await readDeliveryJiraAssignments(store,flow.companyId,flow.projectId,[stage.jiraKey]);
        if(!deliverySeatMatchesAssignee(seat,flow.projectId,current.get(stage.jiraKey)!))throw conflict(stage.jiraKey+" 的 Jira 经办人或席位账号配置已变化，请核对后处理；不会自动转派");
      }
      const presence = seat.adapterConfig.dsp7SeatPresence as
        | {
            lastSeenAt?: string;
            state?: string;
            acceptingWork?: boolean;
            capabilities?: string[];
          }
        | undefined;
      if ((stage.reviewWorkKeys || flow.stages.some(node=>node.reviewWorkKeys?.includes(stage.jiraKey??""))) && !presence?.capabilities?.includes("delivery-work-review-v1"))
        throw conflict("请更新席位客户端，当前客户端不支持工作单与独立评审单顺序调度");
      if (Object.values(flow.config.template?.definition.stages ?? {}).some(policy=>policy.workExecution || policy.reviewExecution) && !presence?.capabilities?.includes("delivery-executor-v1"))
        throw conflict("请更新席位客户端并刷新登记，以支持人工与 Agent 混合交付");
      if (stage.repairReused && !presence?.capabilities?.includes("delivery-reuse-repair-v1"))
        throw conflict("请更新席位客户端以支持原任务测试返工");
      if (stage.reworkHistory?.length && !presence?.capabilities?.includes("delivery-rework-v1"))
        throw conflict("请更新席位客户端并刷新登记，以接收评审修改意见和执行版本核验");
      if (flow.config.automaticRepairAuthorized && !presence?.capabilities?.includes("delivery-auto-repair-v1"))
        throw conflict("请更新席位客户端以支持结构化缺陷与修复构建核验");
      if (!presence?.capabilities?.includes("delivery-flow-v1"))
        throw conflict("请更新席位客户端，当前客户端不支持条目自动交付");
      if (
        !presence.lastSeenAt ||
        Date.now() - Date.parse(presence.lastSeenAt) > 90000 ||
        !seatCanAcceptWork(presence) ||
        presence.acceptingWork === false
      ) {
        await save("等待 " + seat.name + " 上线、空闲并允许接单");
        return;
      }
      if (["paused", "terminated", "pending_approval"].includes(seat.status))
        throw conflict("席位已暂停或不可用");
      const reserved = await tx
        .select({ id: deliveryWorkflows.id })
        .from(deliveryWorkflows)
        .where(
          and(
            eq(deliveryWorkflows.companyId, flow.companyId),
            eq(deliveryWorkflows.id, flow.id),
            sql`exists(select 1 from jsonb_array_elements(${deliveryWorkflows.stages}) s where s->>'seatId'=${stage.seatId} and s->>'taskId'<>${stage.taskId} and s->>'state' in ('queued','running','waiting','review','interrupted'))`,
          ),
        )
        .limit(1);
      if (reserved.length && seatConcurrencyLimit(seat) === 1) {
        await save("席位已有未核验结束的交付阶段，等待其完成或人工处理");
        return;
      }
      const busy = await tx
        .select({ id: heartbeatRuns.id })
        .from(heartbeatRuns)
        .where(
          and(
            eq(heartbeatRuns.agentId, stage.seatId),
            inArray(heartbeatRuns.status, [
              "queued",
              "running",
              "scheduled_retry",
            ]),
          ),
        );
      if (busy.length >= seatConcurrencyLimit(seat)) {
        await save("席位并发已满，等待可用执行名额");
        return;
      }
      const route = resolveHarnessRoute(seat, {
        runId: randomUUID(),
        taskId: stage.taskId,
        kind: stageKind(stage.stage),
        required: true,
      })!;
      if (
        !route.capability.roles.includes(
          stageRole(stage.stage, stage.intent),
        ) ||
        route.capabilityId !== stage.capabilityId ||
        route.registryRevision !== stage.registryRevision
      )
        throw conflict("能力登记已变化，请核对后恢复流程");
      await assertNewDomainMetering(
        store,
        flow.companyId,
        seat.id,
        flow.projectId,
      );
      await assertSeatBudgetAdmission(store, {
        companyId: flow.companyId,
        agentId: seat.id,
        projectId: flow.projectId,
        taskId: stage.taskId,
      });
      stage.inputDigest = executionInputDigest(flow, stage);
      stage.state = "queued";
      await tx
        .update(issues)
        .set({ status: "todo", updatedAt: new Date() })
        .where(
          and(
            eq(issues.id, stage.taskId),
            eq(issues.assigneeAgentId, stage.seatId),
          ),
        );
      // Commit the grant before wakeup. Dispatcher below uses its stable key.
      await save(null);
      dispatchReady = true;
    } catch (error) {
      await save(error instanceof Error ? error.message : "交付调度失败");
    }
  });
  const [flow] = await db
    .select()
    .from(deliveryWorkflows)
    .where(eq(deliveryWorkflows.id, id));
  const stage = flow?.stages.find((s) => s.taskId === taskId);
  if (
    !dispatchReady ||
    !flow ||
    flow.state !== "active" ||
    !stage ||
    stage.runId ||
    stage.branchBlocked ||
    !deliveryStageCanStart(stage)
  )
    return;
  try {
    if (stage.stage === "analysis") {
      const [analysis] = await db
        .select()
        .from(analysisExecutions)
        .where(eq(analysisExecutions.id, stage.taskId));
      await dispatchAnalysisExecution(
        db,
        analysis,
        stage.dispatchId,
        stage.authorizedBy ?? flow.createdBy,
      );
      return;
    }
    if (stage.state !== "queued") return;
    const run = await heartbeatService(db).wakeup(stage.seatId, {
      source: "automation",
      triggerDetail: "callback",
      reason: "智研条目交付授权启动；" + stage.dispatchId,
      idempotencyKey: "delivery-" + stage.dispatchId,
      requestedByActorType: "user",
      requestedByActorId: stage.authorizedBy ?? flow.createdBy,
      allowRunCoalescing: false,
      payload: { issueId: stage.taskId, taskId: stage.taskId },
      contextSnapshot: {
        issueId: stage.taskId,
        taskId: stage.taskId,
        deliveryWorkflowId: id,
        deliveryDispatchId: stage.dispatchId,
        deliveryKind: stageKind(stage.stage),
        forceFreshSession: true,
      },
      issueStateGuard: {
        statuses: ["todo", "in_progress"],
        assigneeAgentId: stage.seatId,
      },
    });
    if (run)
      await db.transaction(async (tx) => {
        const [fresh] = await tx
          .select()
          .from(deliveryWorkflows)
          .where(eq(deliveryWorkflows.id, id))
          .for("update");
        const current = fresh.stages.find(
          (s) => s.dispatchId === stage.dispatchId,
        );
        if (current) {
          current.runId = run.id;
          current.state = "running";
          await tx
            .update(deliveryWorkflows)
            .set({ stages: fresh.stages, updatedAt: new Date() })
            .where(eq(deliveryWorkflows.id, id));
        }
      });
  } catch (e) {
    await db
      .update(deliveryWorkflows)
      .set({
        message: e instanceof Error ? e.message : "派发失败",
        updatedAt: new Date(),
      })
      .where(eq(deliveryWorkflows.id, id));
  }
}
export async function sweepDeliveryWorkflows(db: Db) {
  const rows = await db
    .select({ id: deliveryWorkflows.id })
    .from(deliveryWorkflows)
    .where(sql`(${deliveryWorkflows.state} = 'active' or (
      ${deliveryWorkflows.state} = 'acceptance' and ${deliveryWorkflows.config} ? 'entryScope' and
      coalesce(${deliveryWorkflows.config}->'entryScope'->>'checkedSnapshotId', ${deliveryWorkflows.snapshotId}::text) is distinct from (
        select recent.id::text from delivery_snapshots recent join delivery_snapshots pinned on pinned.id = ${deliveryWorkflows.snapshotId}
        where recent.company_id = ${deliveryWorkflows.companyId} and recent.project_id = ${deliveryWorkflows.projectId}
          and recent.demand_no = ${deliveryWorkflows.demandNo} and recent.source_origin = pinned.source_origin
        order by recent.collected_at desc, recent.created_at desc, recent.id desc limit 1
      )
    ) or (${deliveryWorkflows.state} = 'blocked' and ${deliveryWorkflows.config}->>'automaticRepairAuthorized' = 'true' and exists(select 1 from jsonb_array_elements(${deliveryWorkflows.stages}) s where s->>'stage'='functional-test' and s->>'state'<>'done' and coalesce(s->'automaticRepair'->>'status','')<>'blocked' and (s->'receipt'->'testResults'->>'failed')::int > 0)))`)
    .orderBy(deliveryWorkflows.updatedAt)
    .limit(200);
  for (const row of rows) {
    await reconcileDeliveryWorkflow(db, row.id);
    const [flow] = await db
      .select()
      .from(deliveryWorkflows)
      .where(eq(deliveryWorkflows.id, row.id));
    if (
      !flow ||
      flow.state !== "active" ||
      flow.config.template?.definition.waitingNotifications === false
    )
      continue;
    for (const stage of readyDeliveryStages(flow.stages)) {
      if (!stage.waitingSince) continue;
      const digest =
        stage.state === "waiting" && !stage.question?.answer
          ? stage.question?.digest
          : stage.state === "review" &&
              !stage.review &&
              reviewRequired(stage.stage, stage)
            ? deliveryReviewDigest(stage)
            : !deliveryStageCanStart(stage)
              ? stage.inputDigest
              : null;
      if (!digest) continue;
      const [agent] = await db
        .select()
        .from(agents)
        .where(
          and(
            eq(agents.id, stage.seatId),
            eq(agents.companyId, flow.companyId),
          ),
        );
      if (!agent) continue;
      const policy = agent.adapterConfig.dsp7SeatPolicy as
        | {
            jiraKeys: string[];
            reminderMinutes: number;
            escalationMinutes: number;
            dingtalk?: { botId?: string; userId: string; groupId?: string };
          }
        | undefined;
      if (
        !policy?.dingtalk?.botId ||
        !Number.isFinite(policy.reminderMinutes) ||
        !Number.isFinite(policy.escalationMinutes)
      )
        continue;
      const { notifySeatBot } = await import("../routes/dsp7-seat-bots.js");
      await notifySeatBot(db, agent, policy, [
        {
          id: `delivery:${stage.taskId}:${digest}`,
          taskId: stage.taskId,
          message:
            flow.demandNo +
            " · " +
            deliveryRecordLabel(stage) +
            "（" + (stage.jiraKey ?? "条目级") + "）等待负责人决定或核验，请打开条目自动交付流程。",
          elapsedMinutes: Math.max(
            0,
            (Date.now() - Date.parse(stage.waitingSince)) / 60000,
          ),
          level: "warning",
        },
      ]);
    }
  }
}

export async function deliveryWaitScope(
  db: Db,
  companyId: string,
  agentId: string,
  taskId: string,
  alertId: string,
) {
  if (!alertId.startsWith(`delivery:${taskId}:`)) return null;
  const [flow] = await db
    .select()
    .from(deliveryWorkflows)
    .where(
      and(
        eq(deliveryWorkflows.companyId, companyId),
        eq(deliveryWorkflows.state, "active"),
        sql`exists(select 1 from jsonb_array_elements(${deliveryWorkflows.stages}) s where s->>'taskId'=${taskId} and s->>'seatId'=${agentId})`,
      ),
    );
  const stage = flow?.stages.find(
    (s) => s.taskId === taskId && s.seatId === agentId,
  );
  const digest =
    stage?.state === "waiting" && !stage.question?.answer
      ? stage.question?.digest
      : stage?.state === "review" &&
          !stage.review &&
          reviewRequired(stage.stage, stage)
        ? deliveryReviewDigest(stage)
        : stage && !deliveryStageCanStart(stage)
          ? stage.inputDigest
          : null;
  if (!flow || !stage || !digest || alertId !== `delivery:${taskId}:${digest}`)
    return null;
  try {
    if (stage.runId)
      await assertDeliveryRun(db, companyId, agentId, stage.runId);
    else if(stage.executionMode === "human" && stage.state === "review") {
      await assertHumanReviewScope(db,flow,stage);
    } else {
      if (
        deliveryStageCanStart(stage) ||
        !readyDeliveryStages(flow.stages).some((s) => s.taskId === stage.taskId)
      )
        return null;
      await assertWorkflowSource(db, flow, stage);
    }
    return { flow, stage };
  } catch {
    return null;
  }
}
