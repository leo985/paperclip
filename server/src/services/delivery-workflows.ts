import { readDeliveryJiraAssignments, deliverySeatCandidates, chooseDeliverySeat, deliverySeatMatchesAssignee } from "./delivery-seat-assignment.js";
import { deliveryChainAdmission } from "./delivery-chain-admission.js";
import { seatCanAcceptWork, seatConcurrencyLimit } from "@paperclipai/shared";
import { prepareDeliveryRework } from "./delivery-rework.js";
import { planDeliveryWork, wireDeliveryWork } from "./delivery-work-plan.js";
import {
  deliveryTemplateSettings,
  assertTemplateReviewer,
} from "./delivery-templates.js";
import {
  assertDeliveryGraph,
  readyDeliveryStages,
  deliveryStageCanStart,
} from "./delivery-graph.js";
import { createHash, randomUUID } from "node:crypto";
import { and, desc, eq, inArray, notInArray, sql } from "drizzle-orm";
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
    actorType: "user",
    actorId,
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
          eq(deliveryWorkflows.requestId, config.requestId),
        ),
      );
    if (same) {
      if (
        deliveryDigest({ ...same.config, template: undefined, seatAssignment: undefined }) !==
          deliveryDigest({ ...config, template: undefined, seatAssignment: undefined }) ||
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
      );
    if (existing) throw conflict("本条目已有交付流程，请查看已有流程");
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
    const template = (
      await deliveryTemplateSettings(store, c, snapshot.projectId)
    ).effective;
    if (
      config.expectedTemplate &&
      (config.expectedTemplate.id !== template.id ||
        config.expectedTemplate.revision !== template.revision)
    )
      throw conflict("流程模板已更新，请刷新配置后启动");
    const entryAdmission = await deliveryChainAdmission(store, snapshot, {template, environmentReference:config.environmentReference});
    if (!entryAdmission.ready) throw conflict("交付链准入未满足：" + entryAdmission.reasons.join("；"));
    const pinnedConfig = { ...config, template, seatAssignment: "jira_assignee" as const };
    const planned = planDeliveryWork(config, template.definition, snapshot.plan.items, true);
    const assignments=await readDeliveryJiraAssignments(store,c,snapshot.projectId,planned.filter(n=>n.key&&n.executionMode!=="human").map(n=>n.key!));
    const companySeats=await tx.select().from(agents).where(eq(agents.companyId,c));
    for(const node of planned) {
      if(!node.key || node.executionMode==="human")continue;
      const assignment=assignments.get(node.key)!;
      const candidates=deliverySeatCandidates(companySeats,snapshot.projectId,assignment,stageKind(node.stage),stageRole(node.stage,node.intent));
      const explicit=config.workSeats?.find(b=>b.jiraKey===node.key)?.seatId || config.codingTasks?.find(b=>b.jiraKey===node.key)?.seatId || config.reviewTasks?.find(b=>b.jiraKey===node.key)?.seatId;
      const preference=explicit || (candidates.some(s=>s.id===node.seatId)?node.seatId:undefined);
      node.seatId=chooseDeliverySeat(candidates,preference,node.key);
    }
    for(const node of planned.filter(n=>n.reviewWorkKeys&&n.executionMode!=="human"))if(planned.some(w=>node.reviewWorkKeys!.includes(w.key!)&&w.executionMode!=="human"&&w.seatId===node.seatId))throw conflict("Agent 评审必须使用不同于被审工作单的独立席位");
    if (
      planned.some(
        (item) => (!item.seatId && !(item.executionMode === "human" && item.executorUserId)) || (item.stage !== "analysis" && !item.key),
      )
    )
      throw conflict("请为模板启用的每个阶段配置席位及真实工单");
    if (
      planned.some((item) => item.stage === "functional-test") &&
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
        ].includes(item.status.trim().toLowerCase())
      )
        throw conflict(key + " 已结束，不能自动重新执行");
      return item;
    });
    if (new Set(children.map((x) => x.parentKey)).size > 1)
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
                sql`(position(${'"jira_key":"' + key + '"'} in coalesce(${issues.description},'')) > 0 or ${issues.originId} like ${"%:" + key})`,
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
    for (const { stage, seatId, key: jiraKey, intent, executionMode, reviewWorkKeys, executorUserId } of planned) {
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
        reviewWorkKeys,
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
        startMode: policy.start,
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
        message: null,
      });
    }
    wireDeliveryWork(stages, template.definition);
    assertDeliveryGraph(stages);
    const [row] = await tx
      .insert(deliveryWorkflows)
      .values({
        companyId: c,
        projectId: snapshot.projectId,
        snapshotId: snapshot.id,
        demandNo: snapshot.demandNo,
        fingerprint: snapshot.fingerprint,
        requestId: config.requestId,
        createdBy: actor,
        config: pinnedConfig,
        stages,
      })
      .returning();
    await workflowAudit(store, c, actor, "delivery.workflow.started", row.id, {
      snapshotId: snapshot.id,
      stages: stages.map((s) => ({
        stage: s.stage,
        taskId: s.taskId,
        seatId: s.seatId,
        jiraKey: s.jiraKey,
      })),
      entryAdmission: { templateId: template.id, templateRevision: template.revision, startStage: entryAdmission.startStage, checks: entryAdmission.checks },
      automaticExecutionGranted: true,
    });
    return row;
  });
}
export async function startDeliveryRepair(
  db: Db,
  companyId: string,
  actor: string,
  id: string,
  config: DeliveryRepairConfig,
) {
  await authorized(db, companyId, actor);
  if (
    config.developmentSeatId === config.reviewSeatId ||
    new Set([config.defectKey, config.reviewKey, config.retestKey]).size !== 3
  )
    throw conflict("修复与评审需独立席位，三个环节需各自工单");
  return db.transaction(async (tx) => {
    const store = tx as unknown as Db;
    const [flow] = await tx
      .select()
      .from(deliveryWorkflows)
      .where(
        and(
          eq(deliveryWorkflows.id, id),
          eq(deliveryWorkflows.companyId, companyId),
        ),
      )
      .for("update");
    if (!flow) throw notFound("交付流程不存在");
    await assertWorkflowSource(store, flow);
    const failed = flow.stages.find((stage) => stage.state !== "done");
    if (
      flow.state !== "blocked" ||
      !failed ||
      failed.stage !== "functional-test" ||
      !failed.receipt ||
      failed.receiptDigest !== config.expectedReceiptDigest ||
      !failed.receipt.testResults?.failed
    )
      throw conflict("只能为当前版本已确认失败的功能测试启动修复链");
    const history = failed.repairHistory ?? [];
    if (history.length >= DELIVERY_MAX_REPAIR_CYCLES)
      throw conflict("已达到三轮修复上限，请人工排查并重新规划");
    const [permit] = await tx
      .select()
      .from(seatExecutionPermits)
      .where(
        and(
          eq(seatExecutionPermits.runId, failed.runId!),
          eq(seatExecutionPermits.companyId, companyId),
          eq(seatExecutionPermits.taskId, failed.taskId),
        ),
      );
    const [run] = await tx
      .select()
      .from(heartbeatRuns)
      .where(
        and(
          eq(heartbeatRuns.id, failed.runId!),
          eq(heartbeatRuns.companyId, companyId),
        ),
      );
    if (
      !permit?.treeStopVerifiedAt ||
      !run ||
      ["queued", "running", "scheduled_retry"].includes(run.status)
    )
      throw conflict("请先核验旧测试进程树已停止");
    const mapping = [
      {
        stage: "coding" as const,
        intent: "bugfix" as const,
        seatId: config.developmentSeatId,
        key: config.defectKey,
        parentKey: undefined,
        label: "缺陷修复",
      },
      {
        stage: "coding" as const,
        intent: "code-review" as const,
        seatId: config.reviewSeatId,
        key: config.reviewKey,
        parentKey: failed.parentKey,
        label: "独立代码评审",
      },
      {
        stage: "functional-test" as const,
        intent: "retest" as const,
        seatId: config.qaSeatId,
        key: config.retestKey,
        parentKey: failed.parentKey,
        label: "修复后重测",
      },
    ];
    // Serialize Jira reservations across workflow starts and repairs in this company.
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${companyId + ":delivery-workflow-start"},0))`,
    );
    const duplicates = await tx
      .select({ id: issues.id })
      .from(issues)
      .where(
        and(
          eq(issues.companyId, companyId),
          inArray(issues.status, [
            "backlog",
            "todo",
            "in_progress",
            "in_review",
            "blocked",
          ]),
          notInArray(issues.id, [
            failed.taskId,
            ...history.map((cycle) => cycle.taskId),
          ]),
          sql`(${sql.join(
            mapping.map(
              (item) =>
                sql`position(${'"jira_key":"' + item.key + '"'} in coalesce(${issues.description},'')) > 0 or ${issues.originId} like ${"%:" + item.key}`,
            ),
            sql` or `,
          )})`,
        ),
      )
      .limit(1);
    if (duplicates.length)
      throw conflict("修复、评审或重测工单已有活动执行，请先处理已有任务");
    const cycle = {
      attempt: history.length + 1,
      taskId: failed.taskId,
      runId: failed.runId!,
      receipt: failed.receipt,
      receiptDigest: failed.receiptDigest!,
      defectKey: config.defectKey,
      reviewKey: config.reviewKey,
      retestKey: config.retestKey,
      by: actor,
      at: new Date().toISOString(),
    };
    const repairAssignments=await readDeliveryJiraAssignments(tx as unknown as Db,companyId,flow.projectId,mapping.map(item=>item.key));
    const repairSeats=await tx.select().from(agents).where(eq(agents.companyId,companyId));
    for(const item of mapping)chooseDeliverySeat(deliverySeatCandidates(repairSeats,flow.projectId,repairAssignments.get(item.key)!,stageKind(item.stage),stageRole(item.stage,item.intent)),item.seatId,item.key);
    const created: DeliveryStageRecord[] = [];
    for (const item of mapping) {
      const [seat] = await tx
        .select()
        .from(agents)
        .where(
          and(eq(agents.id, item.seatId), eq(agents.companyId, companyId)),
        );
      const owner = seatOwnerId(
        seat?.adapterConfig.dsp7Seat as Record<string, unknown>,
      );
      if (
        !seat ||
        !owner ||
        seat.adapterConfig.dsp7Transport !== "outbound" ||
        ["paused", "terminated", "pending_approval"].includes(seat.status)
      )
        throw conflict("请选择有效且可接单的登记席位");
      const taskId = randomUUID();
      const route = resolveHarnessRoute(seat, {
        runId: randomUUID(),
        taskId,
        kind: stageKind(item.stage),
        required: true,
      })!;
      if (!route.capability.roles.includes(stageRole(item.stage, item.intent)))
        throw conflict(
          seat.name + " 缺少 " + item.label + " 能力，请本机重新登记",
        );
      await assertNewDomainMetering(store, companyId, seat.id, flow.projectId);
      await assertSeatBudgetAdmission(store, {
        companyId,
        agentId: seat.id,
        projectId: flow.projectId,
        taskId,
      });
      await tx
        .insert(issues)
        .values({
          id: taskId,
          companyId,
          projectId: flow.projectId,
          title: flow.demandNo + " · 第" + cycle.attempt + "轮" + item.label,
          description:
            "条目修复链；遵守真实 Jira 身份、原生门禁及独立进程核验。\n<!-- DELIVERY-WORKFLOW " +
            JSON.stringify({ jira_key: item.key, project_id: flow.projectId }) +
            " -->",
          status: "backlog",
          priority: "medium",
          assigneeAgentId: seat.id,
          createdByUserId: actor === "local-board" ? null : actor,
        });
      created.push({
        stage: item.stage,
        intent: item.intent,
        taskId,
        seatId: seat.id,
        ownerUserId: owner,
        jiraKey: item.key,
        parentKey: item.parentKey,
        dispatchId: randomUUID(),
        state: "pending",
        runId: null,
        capabilityId: route.capabilityId,
        registryRevision: route.registryRevision,
        inputDigest: deliveryDigest({
          failure: failed.receiptDigest,
          attempt: cycle.attempt,
          intent: item.intent,
        }),
        receipt: null,
        receiptDigest: null,
        review: null,
        message: null,
        repairFailure: {
          receipt: failed.receipt,
          receiptDigest: failed.receiptDigest!,
        },
        ...(item.intent === "retest"
          ? { repairHistory: [...history, cycle] }
          : {}),
      });
    }
    await tx
      .update(issues)
      .set({ status: "blocked", updatedAt: new Date() })
      .where(eq(issues.id, failed.taskId));
    const stages = [
      ...flow.stages.slice(0, flow.stages.indexOf(failed)),
      ...created,
    ];
    const [updated] = await tx
      .update(deliveryWorkflows)
      .set({
        stages,
        state: "active",
        message: "修复链已授权，等待修复、独立评审及重测依序执行",
        updatedAt: new Date(),
      })
      .where(eq(deliveryWorkflows.id, id))
      .returning();
    await workflowAudit(
      store,
      companyId,
      actor,
      "delivery.repair.started",
      id,
      {
        attempt: cycle.attempt,
        failedTaskId: failed.taskId,
        failedReceiptDigest: failed.receiptDigest,
        tasks: created.map((stage) => ({
          taskId: stage.taskId,
          seatId: stage.seatId,
          intent: stage.intent,
          jiraKey: stage.jiraKey,
        })),
      },
    );
    return updated;
  });
}

export async function assertWorkflowSource(
  db: Db,
  flow: typeof deliveryWorkflows.$inferSelect,
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
  if (!latest || latest.fingerprint !== flow.fingerprint)
    throw conflict("来源输入已变化，请重新核验交付版本");
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
  await authorized(db, companyId, flow.createdBy);
  await assertWorkflowSource(db, flow);
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
  await authorized(db, flow.companyId, flow.createdBy);
  await assertWorkflowSource(db, flow);
  if(stage.executionMode!=="human"||!readyDeliveryStages(flow.stages).some(s=>s.taskId===stage.taskId)||stage.inputDigest!==humanReviewInputDigest(flow,stage))throw conflict("任务前置或交付版本已变化");
  if(stage.seatId) {
    const [seat]=await db.select().from(agents).where(and(eq(agents.id,stage.seatId),eq(agents.companyId,flow.companyId)));
    if(!seat||seatOwnerId(seat.adapterConfig.dsp7Seat as Record<string, unknown>)!==stage.ownerUserId)throw conflict("任务席位负责人已变化，请核对流程");
  }
  await assertTemplateReviewer(db,flow.companyId,stage.reviewerUserId!);
  const [task]=await db.select().from(issues).where(and(eq(issues.id,stage.taskId),eq(issues.companyId,flow.companyId)));
  if(!task||task.assigneeUserId!==stage.reviewerUserId||task.status==="cancelled")throw conflict("人工任务负责人或状态已变化");
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
export async function reconcileDeliveryWorkflow(db: Db, id: string) {
  const [flow] = await db
    .select()
    .from(deliveryWorkflows)
    .where(eq(deliveryWorkflows.id, id));
  if (!flow || flow.state !== "active") return;
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
        .set({ stages: flow.stages, message, state, updatedAt: new Date() })
        .where(eq(deliveryWorkflows.id, id));
    };
    try {
      await authorized(store, flow.companyId, flow.createdBy);
      const [snapshot] = await tx
        .select()
        .from(deliverySnapshots)
        .where(eq(deliverySnapshots.id, flow.snapshotId));
      const [latest] = await tx
        .select()
        .from(deliverySnapshots)
        .where(
          and(
            eq(deliverySnapshots.companyId, flow.companyId),
            eq(deliverySnapshots.projectId, flow.projectId),
            eq(deliverySnapshots.sourceOrigin, snapshot.sourceOrigin),
            eq(deliverySnapshots.demandNo, flow.demandNo),
          ),
        )
        .orderBy(
          desc(deliverySnapshots.collectedAt),
          desc(deliverySnapshots.createdAt),
          desc(deliverySnapshots.id),
        )
        .limit(1);
      if (latest.fingerprint !== flow.fingerprint) {
        await save("来源输入已变化，已停止自动推进；请核对来源差异", "blocked");
        return;
      }
      const rejected = flow.stages.find(s => s.review?.decision === "reject");
      if (rejected) {
        const prepared = await prepareDeliveryRework(store, flow, rejected);
        if (prepared) await workflowAudit(store, flow.companyId, rejected.reworkHistory!.at(-1)!.rejection.by, "delivery.review.rework.started", flow.id, {reviewTaskId:rejected.taskId, round:rejected.reworkHistory!.length});
        await save(prepared ? "已退回原执行人返工，完成后重新送审" : "评审已退回，等待旧运行及进程树停止核验后自动返工");
        return;
      }
      const stage = taskId
        ? readyDeliveryStages(flow.stages).find((s) => s.taskId === taskId)
        : undefined;
      if (!stage && flow.stages.some((s) => s.state !== "done")) return;
      if (!stage) {
        await save("各环节交付已核验，等待主需求负责人正式验收", "acceptance");
        return;
      }
      if (!deliveryStageCanStart(stage)) {
        stage.waitingSince ??= new Date().toISOString();
        await save("等待负责人确认启动本阶段");
        return;
      }
      if (stage.executionMode === "human") {
        const [reviewSeat]=stage.seatId ? await tx.select().from(agents).where(and(eq(agents.id,stage.seatId),eq(agents.companyId,flow.companyId))) : [];
        if(stage.seatId && (!reviewSeat||seatOwnerId(reviewSeat.adapterConfig.dsp7Seat as Record<string,unknown>)!==stage.ownerUserId))throw conflict("评审席位负责人已变化");
        await assertTemplateReviewer(store, flow.companyId, stage.reviewerUserId!);
        const inputDigest=humanReviewInputDigest(flow,stage);
        if(stage.state==="pending") {
          stage.inputDigest=inputDigest;stage.state="review";stage.waitingSince=new Date().toISOString();
          stage.message=stage.reviewWorkKeys ? "前置工作单已交付，请负责人完成真实评审单并登记当前版本正式结论" : "请指定负责人完成人工工作单，登记交付版本、材料和正式完成结论";
          await tx.update(issues).set({status:"in_review",updatedAt:new Date()}).where(and(eq(issues.id,stage.taskId),eq(issues.companyId,flow.companyId)));
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
              await save(
                "测试存在失败、阻塞、跳过或缺少结果，需修复并独立复审后重测；报告交付不等于测试通过",
                "blocked",
              );
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
      if (stage.reworkHistory?.length && !presence?.capabilities?.includes("delivery-rework-v1"))
        throw conflict("请更新席位客户端并刷新登记，以接收评审修改意见和执行版本核验");
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
      stage.inputDigest = deliveryDigest({
        fingerprint: flow.fingerprint,
        stage: stage.stage,
        intent: stage.intent ?? null,
        repairFailure: stage.repairFailure?.receiptDigest ?? null,
        rework: stage.reworkHistory?.map(r=>({round:r.round,rejection:r.rejection})),
        upstream: flow.stages
          .filter((s) =>
            stage.dependsOn
              ? stage.dependsOn.includes(s.taskId)
              : s.state === "done",
          )
          .map(completedDeliveryDigest),
        environmentReference: flow.config.environmentReference,
      });
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
    !flow ||
    flow.state !== "active" ||
    !stage ||
    stage.runId ||
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
        flow.createdBy,
      );
      return;
    }
    if (!dispatchReady || stage.state !== "queued") return;
    const run = await heartbeatService(db).wakeup(stage.seatId, {
      source: "automation",
      triggerDetail: "callback",
      reason: "智研条目交付授权启动；" + stage.dispatchId,
      idempotencyKey: "delivery-" + stage.dispatchId,
      requestedByActorType: "user",
      requestedByActorId: flow.createdBy,
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
    .where(eq(deliveryWorkflows.state, "active"))
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
      await assertWorkflowSource(db, flow);
    }
    return { flow, stage };
  } catch {
    return null;
  }
}
