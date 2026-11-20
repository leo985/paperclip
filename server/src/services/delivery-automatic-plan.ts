import { and, desc, eq, inArray, or, sql } from "drizzle-orm";
import {
  agents,
  analysisExecutions,
  deliverySnapshots,
  deliveryWorkflows,
  issues,
  projects,
  type Db,
} from "@paperclipai/db";
import {
  DELIVERY_STAGE_LABELS,
  deliveryPriorCompletionSchema,
  type DeliveryAutomaticPlan,
  type DeliveryAutomaticPlanInput,
  type DeliveryAutomaticStartInput,
  type DeliveryStageRecord,
  type DeliveryWorkflowConfig,
} from "@paperclipai/shared";
import { conflict, notFound } from "../errors.js";
import {
  assertTemplateReviewer,
  deliveryTemplateSettings,
} from "./delivery-templates.js";
import { deliveryChainAdmission } from "./delivery-chain-admission.js";
import {
  deliveryDigest,
  deliverySeatAuthorizationDigest,
  stageKind,
  stageRole,
  startDeliveryWorkflow,
} from "./delivery-workflows.js";
import {
  deliverySeatCandidates,
  deliverySeatMatchesAssignee,
} from "./delivery-seat-assignment.js";
import { MissingJiraPriorEvidence, UnconfirmedJiraReviewResult, readJiraPriorCompletion } from "./delivery-prior-jira.js";
import { isHistoricalDelivery } from "./delivery-graph.js";
import {
  planDeliveryWork,
  wireDeliveryWork,
  type PlannedDeliveryWork,
} from "./delivery-work-plan.js";
import {
  completedDeliverySource,
  selectAutomaticDeliveryWork,
} from "./delivery-automatic-selection.js";
import { canExtendDeliveryEntry, canSkipDeliveryTestCases, deliveryActiveIssueIdentity, deliveryBranchChildIdentities, deliveryBranchMatches, deliveryBranchPlan, deliveryBranchTemplate, deliveryBranchVerified, deliveryDependentBranches, deliveryEntryInput, isDeliveryTestCase, legacyDeliveryEntryScope } from "./delivery-entry-scope.js";
import { readAutomaticDeliverySource } from "./delivery-automatic-source.js";
import { resolveHarnessRoute } from "./harness-execution-routing.js";
import { seatOwnerId } from "../routes/dsp7-seat-owners.js";

export async function buildAutomaticDeliveryPlan(
  db: Db,
  c: string,
  input: DeliveryAutomaticPlanInput,
) {
  const [snapshot] = await db
    .select()
    .from(deliverySnapshots)
    .where(
      and(
        eq(deliverySnapshots.companyId, c),
        eq(deliverySnapshots.id, input.snapshotId),
      ),
    );
  if (!snapshot) throw notFound("条目版本不存在");
  const [project] = await db
    .select()
    .from(projects)
    .where(and(eq(projects.companyId, c), eq(projects.id, snapshot.projectId)));
  if (!project || project.archivedAt) throw conflict("项目已归档或不可用");
  const [existing] = await db.select().from(deliveryWorkflows).where(and(
    eq(deliveryWorkflows.companyId, c),
    eq(deliveryWorkflows.projectId, project.id),
    eq(deliveryWorkflows.demandNo, snapshot.demandNo),
  ));
  const scoped = !!(input.entryScope || input.branchDependencies?.length || input.ignoredParentKeys?.length ||
    input.skipTestCasesParentKeys?.length || existing?.config.entryScope || snapshot.plan.mains.length > 1);
  const source = await readAutomaticDeliverySource(db, c, project.id, snapshot.plan);
  const saved = snapshot.plan.items.filter(item => item.parentKey);
  const blockers: DeliveryAutomaticPlan["blockers"] = [];
  const matches = (a: typeof saved[number], b: typeof saved[number]) =>
    a.key === b.key && a.parentKey === b.parentKey && a.type === b.type && a.status === b.status;
  const changedItems = [
    ...saved.filter(item => !source.items.some(row => matches(item, row))),
    ...source.items.filter(item => !saved.some(row => matches(item, row))),
  ];
  const sourceChanged = { code: "source_changed", message: "Jira 子单范围、类型或状态已变化，请先刷新条目来源，再生成计划" };
  if (changedItems.length && !scoped) blockers.push(sourceChanged);
  const [original] = existing && scoped ? await db.select().from(deliverySnapshots).where(and(
    eq(deliverySnapshots.id, existing.snapshotId), eq(deliverySnapshots.companyId, c),
  )) : [];
  const scope = existing?.config.entryScope ?? (original && source.parents.length > 1 &&
    legacyDeliveryEntryScope(original.plan, original.id, existing!.config, existing!.stages, source.origin) || undefined);
  const extendable = scoped && !!scope && !!existing &&
    canExtendDeliveryEntry(existing.state, existing.message, !!existing.config.entryScope);
  const template = (extendable && existing.config.template) ||
    (await deliveryTemplateSettings(db, c, project.id)).effective;
  if (existing && !extendable)
    blockers.push({ code: "existing", message: "已有交付流程的状态或工单绑定需要先核对，才能继续启动主单" });
  if (extendable) {
    if (scope.jiraOrigin !== source.origin)
      blockers.push({ code: "entry_changed", message: "项目 Jira 来源已变化，请核对交付范围" });
    if (!original || original.sourceOrigin !== snapshot.sourceOrigin || deliveryEntryInput(original.plan) !== deliveryEntryInput(snapshot.plan))
      blockers.push({ code: "entry_changed", message: "条目需求输入已变化，请先核对原交付链的分析范围" });
  }
  if (scoped) {
    const [latest] = await db.select({ id: deliverySnapshots.id }).from(deliverySnapshots).where(and(
      eq(deliverySnapshots.companyId, c), eq(deliverySnapshots.projectId, project.id),
      eq(deliverySnapshots.demandNo, snapshot.demandNo), eq(deliverySnapshots.sourceOrigin, snapshot.sourceOrigin),
    )).orderBy(desc(deliverySnapshots.collectedAt), desc(deliverySnapshots.createdAt), desc(deliverySnapshots.id)).limit(1);
    if (latest.id !== snapshot.id)
      blockers.push({ code: "historical_snapshot", message: "当前为历史来源版本，请打开最新条目版本生成计划" });
  }
  if (scope && Object.keys(scope.branches).some(key => !source.parents.includes(key)))
    blockers.push({ code: "main_removed", message: "已有主工单离开当前条目范围，请先核对正式来源归属" });
  const seats = await db.select().from(agents).where(eq(agents.companyId, c));
  const activeIssues = scoped && source.items.length ? await db.select({
    description: issues.description, originId: issues.originId,
  }).from(issues).where(and(
    eq(issues.companyId, c),
    or(...source.items.map(item => deliveryActiveIssueIdentity(item.key))),
    inArray(issues.status, ["backlog", "todo", "in_progress", "in_review", "blocked"]),
  )) : [];
  const activeKeys = new Set(source.items.filter(item => activeIssues.some(issue =>
    issue.description?.includes('"jira_key":"' + item.key + '"') || issue.originId?.endsWith(":" + item.key),
  )).map(item => item.key));
  const context = { snapshot, project, template, source, seats, activeKeys, existing: extendable ? existing : undefined };
  if (!scoped) return { ...await buildBranchPlan(db, c, input, context, blockers), existing };

  const dependencies = new Map(input.branchDependencies?.map(binding => [binding.parentKey, binding.afterParentKey]));
  const validSources = new Set(source.parents);
  const alreadyIgnored = new Set(scope?.ignoredParentKeys);
  const newlyIgnored = (input.ignoredParentKeys ?? []).filter(key => !alreadyIgnored.has(key));
  const ignored = new Set([...alreadyIgnored, ...newlyIgnored]);
  if (newlyIgnored.some(key => !validSources.has(key) || scope?.branches[key]) ||
      (newlyIgnored.length > 0 && source.parents.every(key => ignored.has(key))))
    blockers.push({ code: "ignored_parent", message: "只能忽略尚未启动的本条目主工单，且至少保留一张主工单用于交付" });
  const requestedSkips = new Set(input.skipTestCasesParentKeys);
  const templateAllowsSkip = canSkipDeliveryTestCases(template);
  if ([...requestedSkips].some(key => !validSources.has(key) || ignored.has(key) ||
      (scope?.branches[key] ? !scope.branches[key].skipTestCases : !templateAllowsSkip)))
    blockers.push({ code: "skip_test_cases", message: "只能为本条目未启动的主工单选择忽略测试用例阶段" });
  for (const [key, previous] of [...dependencies]) {
    if (key === previous || !validSources.has(key) || !validSources.has(previous) || ignored.has(key) || ignored.has(previous) ||
      (scope?.branches[key] && scope.branches[key].afterParentKey !== previous))
      blockers.push({ code: "branch_dependency", message: "无效的主单前置关系或试图修改已授权前置：" + key + " → " + previous });
    const seen = new Set([key]);
    let upstream: string | undefined = previous;
    while (upstream) {
      if (seen.has(upstream)) {
        blockers.push({ code: "branch_dependency_cycle", message: "主工单前置关系形成循环，请核对 " + key });
        break;
      }
      seen.add(upstream);
      upstream = scope?.branches[upstream]?.afterParentKey ?? dependencies.get(upstream);
    }
  }
  const branchPlans = new Map<string, Awaited<ReturnType<typeof buildBranchPlan>>>();
  const branches: NonNullable<DeliveryAutomaticPlan["branches"]> = [];
  for (const parentKey of source.parents) {
    const registered = extendable ? scope.branches[parentKey] : undefined;
    const canIgnore = !registered && !alreadyIgnored.has(parentKey) && source.parents.length > 1 && (!existing || extendable);
    if (!registered && ignored.has(parentKey)) {
      branches.push({ parentKey, state: "ignored", canIgnore, nodes: [], blockers: [], excluded: [] });
      continue;
    }
    const canSkipTestCases = !registered && templateAllowsSkip && (!existing || extendable);
    const skipTestCases = registered?.skipTestCases || (canSkipTestCases && requestedSkips.has(parentKey)) || undefined;
    const testCaseScope = { ...(canSkipTestCases ? { canSkipTestCases } : {}), ...(skipTestCases ? { skipTestCases } : {}) };
    const branchSourceChanged = changedItems.some(item => item.parentKey === parentKey && (!skipTestCases || !isDeliveryTestCase(item)));
    const afterParentKey = registered?.afterParentKey ?? dependencies.get(parentKey);
    const dependency = afterParentKey ? { afterParentKey } : {};
    const entryConfig = existing && scope ? { ...existing.config, entryScope: scope } : undefined;
    const previous = registered ? existing!.stages.filter(stage => stage.parentKey === parentKey) : [];
    const changed = registered && !deliveryBranchMatches(snapshot.plan, { ...existing!.config, entryScope: scope }, parentKey);
    if (registered && !changed) {
      branches.push({
        parentKey, ...dependency, ...testCaseScope, state: previous.some(stage => stage.branchBlocked || stage.state === "interrupted") ? "blocked" :
          deliveryBranchVerified(snapshot.plan, entryConfig!, existing!.stages, parentKey) ? "verified" : "started",
        nodes: [], excluded: [], blockers: branchSourceChanged ? [sourceChanged] : [],
      });
      continue;
    }
    const impactedParents = changed && scope ? [...deliveryDependentBranches(scope, parentKey)] : [];
    if (changed) {
      const [baseline] = await db.select().from(deliverySnapshots).where(and(
        eq(deliverySnapshots.id, registered.snapshotId), eq(deliverySnapshots.companyId, c),
        eq(deliverySnapshots.projectId, project.id),
      ));
      const current = deliveryBranchChildIdentities(snapshot.plan.items, parentKey, skipTestCases);
      if (!baseline || [...deliveryBranchChildIdentities(baseline.plan.items, parentKey, skipTestCases)].some(([key, type]) => current.get(key) !== type) ||
        existing!.stages.some(stage => (stage.parentKey === parentKey || impactedParents.includes(stage.parentKey ?? "")) &&
          (stage.repairReused || stage.automaticRepairGenerated || stage.branchBlocked || stage.review?.decision === "reject" ||
            (stage.parentKey !== parentKey && isHistoricalDelivery(stage))))) {
        branches.push({
          parentKey, ...testCaseScope, state: "blocked", nodes: [], excluded: [],
          blockers: [{ code: "branch_changed", message: "主单存在已授权工单移除、改型或待处理返工，请先核对原工单和正式流程" }],
        });
        continue;
      }
    }
    const waiting: DeliveryAutomaticPlan["blockers"] = afterParentKey &&
      (!entryConfig || !deliveryBranchVerified(snapshot.plan, entryConfig, existing!.stages, afterParentKey))
      ? [{ code: "branch_dependency_wait", message: "等待前置主工单 " + afterParentKey + " 交付核验" }] : [];
    const belongs = (key: string) => source.items.some(item => item.key === key && item.parentKey === parentKey);
    const included = (key: string) => source.items.some(item =>
      item.key === key && item.parentKey === parentKey && (!skipTestCases || !isDeliveryTestCase(item)));
    const branch = await buildBranchPlan(db, c, {
      ...input, parentKey, entryScope: true,
      workSeats: input.workSeats?.filter(binding => included(binding.jiraKey)),
      reviewTasks: input.reviewTasks?.filter(binding => included(binding.jiraKey)),
      passedTests: input.passedTests?.filter(binding => belongs(binding.jiraKey)),
    }, context, [...blockers, ...waiting, ...(branchSourceChanged ? [sourceChanged] : [])], previous, skipTestCases);
    branchPlans.set(parentKey, branch);
    branches.push({
      parentKey, ...dependency, ...testCaseScope, canIgnore, state: branch.plan.ready ? "ready" : "blocked",
      nodes: branch.plan.nodes,
      excluded: branch.plan.excluded.filter(item => belongs(item.jiraKey)),
      blockers: branch.plan.blockers,
      ...(changed ? { scopeChanged: true, impactedParents } : {}),
    });
  }
  const sharedNode = branches.flatMap(branch => branch.nodes).find(node => node.stage === "analysis");
  const nodes = [...(sharedNode ? [sharedNode] : []), ...branches.flatMap(branch => branch.nodes.filter(node => node.stage !== "analysis"))];
  const canSaveIgnored = !!extendable && newlyIgnored.length > 0 && !blockers.length;
  const digest = deliveryDigest({ input, branchDigests: [...branchPlans].map(([key, branch]) => [key, branch.plan.digest]), existing: existing?.id, scope: scope?.branches, ignored: scope?.ignoredParentKeys, branches, canSaveIgnored });
  return {
    plan: { digest, ready: branches.some(branch => branch.state === "ready"), template, parents: source.parents,
      parentKey: input.parentKey ?? null, canSaveIgnored, branches, nodes, excluded: branches.flatMap(branch => branch.excluded), blockers } satisfies DeliveryAutomaticPlan,
    branchPlans, sourceDigest: deliveryDigest(source), sourceOrigin: source.origin, existing, scope, newlyIgnored,
  };
}

async function buildBranchPlan(
  db: Db,
  c: string,
  input: DeliveryAutomaticPlanInput,
  context: {
    snapshot: typeof deliverySnapshots.$inferSelect;
    project: typeof projects.$inferSelect;
    template: DeliveryAutomaticPlan["template"];
    source: Awaited<ReturnType<typeof readAutomaticDeliverySource>>;
    seats: typeof agents.$inferSelect[];
    activeKeys: Set<string>;
    existing?: typeof deliveryWorkflows.$inferSelect;
  },
  globalBlockers: DeliveryAutomaticPlan["blockers"],
  previous: DeliveryStageRecord[] = [],
  skipTestCases?: true,
) {
  const { snapshot, project, source, seats, activeKeys, existing } = context;
  const template = deliveryBranchTemplate(context.template, skipTestCases);
  const { config, blockers, excluded, parentKey } = selectAutomaticDeliveryWork(source.items, source.parents, template.definition, input);
  if (skipTestCases) {
    const skipped = new Set(source.items.filter(item => item.parentKey === parentKey && isDeliveryTestCase(item)).map(item => item.key));
    for (const item of excluded) {
      if (skipped.has(item.jiraKey) && item.reason === "项目模板未启用对应类型节点")
        item.reason = "本次交付已忽略测试用例编写及评审";
    }
  }
  blockers.unshift(...globalBlockers);
  config.expectedTemplate = { id: template.id, revision: template.revision };
  const admission = await deliveryChainAdmission(db, input.entryScope && parentKey
    ? { ...snapshot, plan: deliveryBranchPlan(snapshot.plan, parentKey, skipTestCases) } : snapshot,
    { template, environmentReference: input.environmentReference, ...(input.entryScope ? { flow: null } : {}) });
  const missingEnvironmentCheck = admission.checks.find(check => check.key === "environment_reference" && !check.passed);
  if (!admission.ready) for (const message of admission.reasons) {
    if (missingEnvironmentCheck && message === missingEnvironmentCheck.label + "：未满足") {
      blockers.push({ code: "environment", message: "项目模板要求在启动前提供测试环境发布记录链接" });
    } else {
      blockers.push({ code: "admission", message });
    }
  }
  const sharedAnalysis = existing?.stages.find(stage => stage.stage === "analysis");
  if (template.definition.automaticRepair) {
    const required=new Set(template.definition.automaticRepair.routes.flatMap(r=>[r.developmentSeatId,r.reviewSeatId,r.qaSeatId]));
    for(const id of required) {
      const seat=seats.find(s=>s.id===id),presence=seat?.adapterConfig.dsp7SeatPresence as {capabilities?:string[]}|undefined;
      if(!presence?.capabilities?.includes("delivery-reuse-repair-v1"))blockers.push({code:"repair_client",message:(seat?.name??"原执行席位")+" 须更新客户端以支持复用原任务测试返工"});
    }
  }
  let planned: PlannedDeliveryWork[] = [];
  if (!config.workTasks?.length && !input.entryScope) config.workTasks = undefined;
  try {
    planned = planDeliveryWork(
      config,
      template.definition,
      snapshot.plan.items,
      true,
      true,
      !!sharedAnalysis,
    );
  } catch (e) {
    blockers.push({
      code: "structure",
      message: e instanceof Error ? e.message : "计划结构不完整",
    });
  }
  if (planned.length > 200)
    blockers.push({
      code: "plan_limit",
      message: "交付节点超过 200 个，请缩小本次主工单范围",
    });
  const priorVersions: Record<string, string> = {};
  config.priorCompletions = [];
  if (template.definition.stages.analysis.enabled && !sharedAnalysis) {
    const [analysis] = await db
      .select()
      .from(analysisExecutions)
      .where(
        and(
          eq(analysisExecutions.companyId, c),
          eq(analysisExecutions.projectId, project.id),
          eq(analysisExecutions.demandNo, snapshot.demandNo),
        ),
      )
      .orderBy(
        desc(analysisExecutions.createdAt),
        desc(analysisExecutions.revision),
        desc(analysisExecutions.id),
      )
      .limit(1);
    if (
      analysis?.state === "published" &&
      analysis.publication &&
      analysis.delivery &&
      analysis.publication.inputDigest === analysis.delivery.inputDigest &&
      analysis.publication.handoffDigest === analysis.delivery.handoffDigest
    ) {
      const prior = deliveryPriorCompletionSchema.safeParse({
        stage: "analysis",
        jiraKey: null,
        version: deliveryDigest({
          id: analysis.id,
          revision: analysis.revision,
          delivery: analysis.delivery,
          publication: analysis.publication,
        }),
        artifactReferences: [analysis.publication.url],
        reviewReference: analysis.publication.url,
      });
      if (prior.success) {
        config.priorCompletions.push(prior.data);
        priorVersions["analysis:null"] = prior.data.version;
      } else
        blockers.push({
          code: "analysis_evidence",
          message: "已发布分析的正式交付链接无效，请补齐已有交付依据",
        });
    } else if (analysis)
      blockers.push({
        code: "analysis_evidence",
        message:
          "本条目已有分析执行，但正式发布及交付版本尚未核验，请先完成分析发布",
      });
  }
  const nodes: DeliveryAutomaticPlan["nodes"] = [];
  for (const node of planned) {
    const row = source.items.find((i) => i.key === node.key);
    const original = previous.find(stage => stage.jiraKey === node.key);
    if (original) {
      nodes.push({
        stage: node.stage, jiraKey: node.key, title: row?.title ?? DELIVERY_STAGE_LABELS[node.stage],
        reviewWorkKeys: node.reviewWorkKeys, dependsOn: [], mode: original.state === "done" || isHistoricalDelivery(original) ? "reuse" : original.executionMode === "human" ? "human" : "seat",
        testResult: original.priorCompletion?.jiraEvidence?.testResult,
        verificationNote: isHistoricalDelivery(original) && original.state !== "done" ? original.message ?? "历史交付待核验" : undefined,
        seatId: "", executor: "沿用已授权节点", startMode: original.startMode ?? "automatic",
        completionReview: !!original.requiresReview, seatChoices: [],
      });
      continue;
    }
    if (row && activeKeys.has(row.key))
      blockers.push({ code: "active_task", jiraKey: row.key, message: row.key + " 已有关联的活动任务，请先处理原任务" });
    let prior = config.priorCompletions.find(
      (p) => p.stage === node.stage && p.jiraKey === node.key,
    );
    let verificationNote: string | undefined;
    let testResult: string | undefined;
    if (row && completedDeliverySource(row.status)) {
      const count = input.passedTests?.find(
        (t) => t.jiraKey === row.key,
      )?.total;
      const parsed = deliveryPriorCompletionSchema.safeParse({
        stage: node.stage,
        jiraKey: row.key,
        source: "jira",
        ...(count ? { passedTests: count } : {}),
      });
      prior = parsed.success ? parsed.data : {stage:node.stage,jiraKey:row.key,source:"jira",version:"",artifactReferences:[],reviewReference:""};
      const identity = `${node.stage}:${node.key}`;
      try {
        const evidence = await readJiraPriorCompletion(db,c,project.id,prior,row.parentKey!,!!node.reviewWorkKeys);
        testResult = evidence.jiraEvidence?.testResult;
        if (parsed.success && (node.stage !== "functional-test" || count || testResult)) {
          priorVersions[identity] = evidence.version;
          config.priorCompletions.push(parsed.data);
        } else {
          verificationNote = "到达功能测试节点后，核对正式报告、被测版本和全通过用例数";
        }
      } catch(e) {
        if (e instanceof MissingJiraPriorEvidence && node.reviewWorkKeys) {
          verificationNote = e instanceof UnconfirmedJiraReviewResult ? e.message : "到达评审节点后，按正式 Jira 流程结论人工核验";
        } else if (e instanceof MissingJiraPriorEvidence && node.stage === "functional-test") {
          verificationNote = "到达功能测试节点后，登记正式测试报告、被测版本和全通过用例数";
        } else {
          blockers.push({code:"prior_evidence",jiraKey:row.key,message:e instanceof Error?e.message:"已有成果读取失败"});
        }
      }
      if (verificationNote) {
        config.historicalVerifications ??= {};
        config.historicalVerifications[row.key] = verificationNote;
      }
    }
    let candidates: typeof seats = [];
    if (!prior) {
      if (row) {
        const assignment = {
          account: row.account,
          displayName: row.assignee,
          origin: source.origin,
        };
        candidates =
          node.executionMode === "human"
            ? seats.filter((s) =>
                deliverySeatMatchesAssignee(s, project.id, assignment),
              )
            : deliverySeatCandidates(
                seats,
                project.id,
                assignment,
                stageKind(node.stage),
                stageRole(node.stage, node.intent),
              );
      } else
        candidates = seats.filter((s) => {
          const rule = s.adapterConfig.dsp7JiraDispatch as
            | { projectId?: string }
            | undefined;
          if (
            rule?.projectId !== project.id ||
            !seatOwnerId(s.adapterConfig.dsp7Seat as Record<string, unknown>) ||
            s.adapterConfig.dsp7Transport !== "outbound" ||
            ["paused", "terminated", "pending_approval"].includes(s.status)
          )
            return false;
          try {
            return resolveHarnessRoute(s, {
              runId: s.id,
              taskId: s.id,
              kind: "analysis",
              required: true,
            })?.capability.roles.includes("requirements-analysis");
          } catch {
            return false;
          }
        });
      const requested =
        input.workSeats?.find((s) => s.jiraKey === node.key)?.seatId ||
        config.reviewTasks?.find((s) => s.jiraKey === node.key)?.seatId ||
        (!node.key ? input.analysisSeatId : undefined);
      const preference =
        requested ||
        (candidates.some((s) => s.id === node.seatId)
          ? node.seatId
          : undefined);
      const choice = preference
        ? candidates.find((s) => s.id === preference)
        : candidates.length === 1
          ? candidates[0]
          : undefined;
      node.seatId = choice?.id ?? "";
      if (
        (node.executionMode !== "human" || !node.executorUserId) &&
        !node.seatId
      )
        blockers.push({
          code: candidates.length ? "seat_choice" : "seat_missing",
          ...(node.key ? { jiraKey: node.key } : {}),
          message:
            (node.key ?? "需求分析") +
            (requested && !candidates.some((s) => s.id === requested)
              ? " 所选席位已不匹配，请重新选择"
              : candidates.length
                ? " 存在多个匹配席位，请选择"
                : " 缺少经办人匹配且具备所需能力的席位，请配置"),
        });
      if (node.stage === "analysis") config.analysisSeatId = node.seatId;
      else if (node.seatId) {
        config.workSeats ??= [];
        config.workSeats = config.workSeats.filter(
          (s) => s.jiraKey !== node.key,
        );
        config.workSeats.push({ jiraKey: node.key!, seatId: node.seatId });
        const work = config.workTasks?.find((t) => t.jiraKey === node.key);
        if (work) work.seatId = node.seatId;
        const review = config.reviewTasks?.find((t) => t.jiraKey === node.key);
        if (review) review.seatId = node.seatId;
      }
      if (node.stage === "functional-test" && !input.environmentReference && !missingEnvironmentCheck)
        blockers.push({
          code: "environment",
          jiraKey: node.key ?? undefined,
          message: "请提供功能测试的环境发布记录链接",
        });
    } else node.seatId = "";
    if (!prior) {
      const policy = template.definition.stages[node.stage];
      const owner = seatOwnerId(
        seats.find((s) => s.id === node.seatId)?.adapterConfig
          .dsp7Seat as Record<string, unknown>,
      );
      const reviewer =
        node.executionMode === "human"
          ? node.executorUserId ||
            (node.reviewWorkKeys && policy.review === "specified_user"
              ? policy.reviewerUserId
              : owner)
          : policy.review === "specified_user"
            ? policy.reviewerUserId
            : owner;
      if (
        node.executionMode === "human" ||
        (policy.review !== "none" &&
          (policy.taskSequence !== "work_then_review" || node.reviewWorkKeys))
      ) {
        try {
          if (!reviewer) throw conflict("人工执行或评审缺少组织成员");
          await assertTemplateReviewer(db, c, reviewer);
        } catch (e) {
          blockers.push({
            code: "reviewer",
            jiraKey: node.key ?? undefined,
            message: e instanceof Error ? e.message : "审核人不可用",
          });
        }
      }
      if (
        node.stage === "coding" &&
        !node.intent &&
        node.executionMode !== "human" &&
        policy.taskSequence !== "work_then_review" &&
        node.seatId
      ) {
        const seat = seats.find((s) => s.id === node.seatId)!;
        if (
          !resolveHarnessRoute(seat, {
            runId: seat.id,
            taskId: seat.id,
            kind: "development",
            required: true,
          })?.capability.roles.includes("code-review")
        )
          blockers.push({
            code: "capability",
            jiraKey: node.key ?? undefined,
            message: seat.name + " 缺少工作单内代码评审能力",
          });
      }
    }
    nodes.push({
      stage: node.stage,
      jiraKey: node.key,
      title: row?.title ?? DELIVERY_STAGE_LABELS[node.stage],
      ...(row ? { jiraAssignee: row.assignee.trim() || row.account.trim() } : {}),
      reviewWorkKeys: node.reviewWorkKeys,
      dependsOn: [],
      mode: prior ? "reuse" : node.executionMode === "human" ? "human" : "seat",
      seatId: node.seatId,
      startMode: template.definition.stages[node.stage].start,
      completionReview:
        node.executionMode === "human" ||
        (template.definition.stages[node.stage].review !== "none" &&
          (template.definition.stages[node.stage].taskSequence !==
            "work_then_review" ||
            !!node.reviewWorkKeys)),
      evidenceVersion: priorVersions[`${node.stage}:${node.key}`],
      verificationNote,
      passedTests: prior?.passedTests,
      ...(testResult ? { testResult } : {}),
      executor: verificationNote ? "启动授权人" : prior
        ? priorVersions[`${node.stage}:${node.key}`]
          ? "成果已核验"
          : "成果待核验"
        : node.executorUserId ||
          seats.find((s) => s.id === node.seatId)?.name ||
          "待匹配",
      seatChoices: candidates.map((s) => ({ id: s.id, name: s.name })),
    });
  }
  const records = planned.map(
    (n, index) =>
      ({
        ...n,
        taskId: String(index),
        jiraKey: n.key,
        dependsOn: [],
      }) as unknown as DeliveryStageRecord,
  );
  wireDeliveryWork(records, template.definition, sharedAnalysis ? ["analysis"] : []);
  for (const [index, node] of nodes.entries()) {
    node.dependsOn = (records[index].dependsOn ?? []).map(
      (id) => nodes[Number(id)]?.jiraKey ?? "analysis",
    );
    if (!previous.some(stage => stage.jiraKey === node.jiraKey) && node.mode === "reuse") {
      const dependencies = records[index].dependsOn ?? [];
      const historicalVerification = node.jiraKey && config.historicalVerifications?.[node.jiraKey];
      if (!historicalVerification && dependencies.some(id =>
        id === "analysis" ? sharedAnalysis?.state !== "done" : nodes[Number(id)].mode !== "reuse"
      )) {
        blockers.push({
          code: "prior_dependency",
          jiraKey: node.jiraKey ?? undefined,
          message: (node.jiraKey ?? "需求分析") + " 已完成但前置节点尚未完成，须先核对来源与成果一致性",
        });
      } else if (!node.verificationNote && dependencies.some(id => nodes[Number(id)]?.verificationNote)) {
        node.verificationNote = "前置节点核验后复核已有交付";
        node.executor = "等待前置核验";
      }
    }
    const spec = planned[index];
    if (
      spec.reviewWorkKeys &&
      node.mode === "seat" &&
      nodes.some(
        (w) =>
          spec.reviewWorkKeys!.includes(w.jiraKey!) &&
          w.mode === "seat" &&
          w.seatId &&
          w.seatId === node.seatId,
      )
    )
      blockers.push({
        code: "independent_review",
        jiraKey: node.jiraKey ?? undefined,
        message: "Agent 评审须匹配不同于被审工作单的独立席位",
      });
  }
  if (previous.length) {
    const before = new Map(previous.map(stage => [stage.jiraKey, stage]));
    const keyForId = new Map(existing?.stages.map(stage => [stage.taskId, stage.jiraKey ?? "analysis"]));
    const affected = new Set<string>();
    for (const node of nodes) {
      const old = before.get(node.jiraKey);
      if (!old) continue;
      const oldInputs = (old.dependsOn ?? []).map(id => keyForId.get(id))
        // Explicit cross-main dependencies are kept separately in the plan.
        .filter(key => key === "analysis" || before.has(key ?? null));
      if (deliveryDigest(oldInputs) === deliveryDigest(node.dependsOn) && !node.dependsOn.some(key => affected.has(key))) continue;
      node.revalidate = true;
      affected.add(node.jiraKey!);
      if (isHistoricalDelivery(old))
        blockers.push({ code: "prior_scope", jiraKey: node.jiraKey!, message: node.jiraKey + " 的历史交付受影响，请先在正式来源核对适用范围" });
    }
  }
  const seatDigests = Object.fromEntries(
    [
      ...new Set(
        nodes
          .filter((n) => n.mode !== "reuse" && n.seatId)
          .map((n) => n.seatId),
      ),
    ].map((id) => [
      id,
      deliverySeatAuthorizationDigest(seats.find((s) => s.id === id)!),
    ]),
  );
  const digest = deliveryDigest({
    companyId: c,
    projectId: project.id,
    snapshotId: snapshot.id,
    fingerprint: snapshot.fingerprint,
    input,
    template,
    source,
    nodes,
    excluded,
    blockers,
    priorVersions,
    seatDigests,
    config,
  });
  const plan: DeliveryAutomaticPlan = {
    digest,
    ready: !blockers.length && (!!nodes.length || !!sharedAnalysis),
    template,
    parents: source.parents,
    parentKey,
    nodes,
    excluded,
    blockers,
  };
  return {
    plan,
    config,
    priorVersions,
    seatDigests,
    sourceDigest: deliveryDigest(source),
  };
}
export async function startAutomaticDeliveryWorkflow(
  db: Db,
  c: string,
  actor: string,
  input: DeliveryAutomaticStartInput,
) {
  const inputDigest = deliveryDigest({
    plan: input.plan,
    automaticRepairAuthorized: input.automaticRepairAuthorized,
    ...(input.parentKeys ? { parentKeys: input.parentKeys } : {}),
  });
  const [same] = await db
    .select()
    .from(deliveryWorkflows)
    .where(
      and(
        eq(deliveryWorkflows.companyId, c),
        or(eq(deliveryWorkflows.requestId, input.requestId), sql`${deliveryWorkflows.config}->'entryScope'->'requests' ? ${input.requestId}`),
      ),
    );
  if (same) {
    const authorization = same.config.entryScope?.requests[input.requestId] ??
      (same.requestId === input.requestId && same.config.automaticPlan
        ? { ...same.config.automaticPlan, actor: same.createdBy }
        : undefined);
    if (authorization?.actor !== actor || authorization.digest !== input.expectedDigest || authorization.inputDigest !== inputDigest)
      throw conflict("请求编号已用于其他启动配置");
    return same;
  }
  const built = await buildAutomaticDeliveryPlan(db, c, input.plan);
  const { plan, sourceDigest } = built;
  if (plan.digest !== input.expectedDigest)
    throw conflict("来源、席位或交付计划已变化，请重新生成并确认计划");
  if ("branchPlans" in built && built.branchPlans) {
    const ready = plan.branches!.filter(branch => branch.state === "ready").map(branch => branch.parentKey);
    const keys = input.parentKeys ?? (input.plan.parentKey ? [input.plan.parentKey] : ready);
    if ((!keys.length && !plan.canSaveIgnored) || keys.some(key => !ready.includes(key)))
      throw conflict("所选主工单尚未就绪或已经启动，请重新生成计划");
    const plans = keys.map(key => built.branchPlans.get(key)!);
    const startConfig: DeliveryWorkflowConfig = plans[0]?.config ?? built.existing!.config;
    return startDeliveryWorkflow(db, c, actor, {
      ...startConfig,
      snapshotId: input.plan.snapshotId,
      requestId: input.requestId,
      automaticRepairAuthorized: input.automaticRepairAuthorized,
      priorCompletions: plans.flatMap(({ config }, index) => (config.priorCompletions ?? []).filter(prior => index === 0 || prior.jiraKey)),
      historicalVerifications: Object.assign({}, ...plans.map(({ config }) => config.historicalVerifications)),
      workSeats: plans.flatMap(({ config }) => config.workSeats ?? []),
      automaticPlan: {
        digest: plan.digest, inputDigest, sourceDigest,
        seatDigests: Object.assign({}, ...plans.map(branch => branch.seatDigests)),
        priorVersions: Object.assign({}, ...plans.map(branch => branch.priorVersions)),
      },
    }, {
      existingId: built.existing?.id,
      previousScope: built.scope?.branches,
      previousIgnored: built.scope?.ignoredParentKeys,
      ignoredParentKeys: built.newlyIgnored,
      jiraOrigin: built.sourceOrigin,
      branches: keys.map((key, index) => {
        const branch = plan.branches!.find(candidate => candidate.parentKey === key)!;
        return { key, config: plans[index].config, excluded: branch.excluded,
          scopeChanged: !!branch.scopeChanged, afterParentKey: branch.afterParentKey, skipTestCases: branch.skipTestCases };
      }),
    });
  }
  if (!("config" in built) || input.parentKeys) throw conflict("启动范围无效");
  const { config, priorVersions, seatDigests } = built;
  if (!plan.ready)
    throw conflict(
      "自动计划尚有阻塞：" + plan.blockers.map((b) => b.message).join("；"),
    );
  return startDeliveryWorkflow(db, c, actor, {
    ...config,
    requestId: input.requestId,
    automaticRepairAuthorized: input.automaticRepairAuthorized,
    automaticPlan: {
      digest: plan.digest,
      inputDigest,
      sourceDigest,
      seatDigests,
      priorVersions,
    },
  });
}
