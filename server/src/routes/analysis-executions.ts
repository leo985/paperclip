import { validateReviewMaterials, requireReviewMaterials } from "../services/analysis-review-materials.js";
import { acknowledgeStoppedAnalysisExecution } from "../services/analysis-execution-resume.js";
import { analysisDispatchProblem, settleAnalysisDispatch } from "../services/analysis-dispatch-state.js";
import { personalTaskScope, taskScopeCondition } from "../services/task-access-scope.js";
import { isSeatOnline, seatDisplayName } from "../services/seat-presentation.js";
import { seatCanAcceptWork } from "@paperclipai/shared";
import { recordSeatStopIntent } from "../services/seat-execution-stop.js";
import { randomUUID, createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { Router, type Request } from "express";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import {
  analysisExecutions,
  analysisDecisions,
  agents,
  issues,
  projects,
  heartbeatRuns,
  seatExecutionPermits,
  activityLog,
  managedTaskFacts,
  type Db,
} from "@paperclipai/db";
import {
  analysisCreateSchema,
  analysisSnapshotSchema,
  analysisDeliverySchema,
  analysisQuestionSchema,
  analysisQingzhouOptionsSchema,
  type AnalysisDelivery,
} from "@paperclipai/shared";
import { z } from "zod";
import { assertBoard, assertCompanyAccess } from "./authz.js";
import { isSeatManager, seatOwnerId } from "./dsp7-seat-owners.js";
import { badRequest, conflict, forbidden, notFound } from "../errors.js";
import {
  resolveHarnessRoute,
  assertNewDomainMetering,
} from "../services/harness-execution-routing.js";
import { assertSeatBudgetAdmission } from "../services/seat-budget-admission.js";
import { heartbeatService } from "../services/heartbeat.js";
import {
  assertAnalysisRun,
  validateAnalysisSnapshot,
  validateAnalysisDelivery,
} from "../services/analysis-executions.js";
import { containsCredential } from "../services/managed-sessions.js";
import { writeAnalysisToQingzhou } from "../services/analysis-qingzhou-writeback.js";
import { analysisQingzhouCredentials } from "../services/analysis-qingzhou-credentials.js";
import { seatQingzhouLock } from "../services/seat-qingzhou.js";
const uuid = z.string().uuid(),
  hash = (s: string) => createHash("sha256").update(s).digest("hex");
export function analysisExecutionRoutes(db: Db) {
  function view<
    T extends { state: string; delivery: unknown; activeRunId: string | null },
  >(task: T, status?: string) {
    return {
      ...task,
      state:
        task.activeRunId &&
        !task.delivery &&
        status &&
        !["queued", "running", "scheduled_retry"].includes(status)
          ? "interrupted"
          : task.state,
    };
  }
  const router = Router(),
    base = "/companies/:companyId/analysis-executions";
  function board(req: Request, manage = false) {
    const c = String(req.params.companyId);
    assertBoard(req);
    assertCompanyAccess(req, c);
    if (manage && !isSeatManager(req, c))
      throw forbidden("发起和授权分析任务需要组织管理员权限");
    return c;
  }
  async function findRecord(req: Request, manage = false) {
    const c = board(req, manage);
    const [t] = await db
      .select()
      .from(analysisExecutions)
      .where(
        and(
          eq(analysisExecutions.companyId, c),
          eq(analysisExecutions.id, String(req.params.executionId)),
        ),
      );
    if (t) {
      const scope = await personalTaskScope(db, req.actor, c);
      if (scope) {
        const [visible] = await db.select({ id: issues.id }).from(issues).where(and(eq(issues.companyId, c), eq(issues.id, t.id), taskScopeCondition(scope))).limit(1);
        if (!visible) throw notFound("分析任务不存在或无权查看");
      }
    }
    return t;
  }
  async function record(req: Request, manage = false) {
    const t = await findRecord(req, manage);
    if (!t) throw notFound("分析任务不存在或无权查看");
    return t;
  }
  async function audit(
    store: Db,
    c: string,
    actor: string,
    action: string,
    id: string,
    details: Record<string, unknown> = {},
  ) {
    await store.insert(activityLog).values({
      companyId: c,
      actorType: "user",
      actorId: actor,
      action,
      entityType: "analysis_execution",
      entityId: id,
      details,
    });
  }
  router.get(base + "/seats", async (req, res) => {
    const c = board(req);
    const all = await db.select().from(agents).where(eq(agents.companyId, c));
    res.json(
      all
        .filter(
          (a) =>
            a.adapterConfig.dsp7WebJiraIntake === true &&
            (isSeatManager(req, c) ||
              seatOwnerId(
                a.adapterConfig.dsp7Seat as Record<string, unknown>,
              ) === req.actor.userId),
        )
        .map((a) => {
          let route;
          try {
            route = resolveHarnessRoute(a, {
              runId: randomUUID(),
              taskId: randomUUID(),
              kind: "analysis",
              required: true,
            });
          } catch {}
          const p = a.adapterConfig.dsp7SeatPresence as
            | { lastSeenAt?: string; capabilities?: string[] }
            | undefined;
          const seat = a.adapterConfig.dsp7Seat as
            | Record<string, unknown>
            | undefined;
          return {
            id: a.id,
            // Match the seats list: prefer the registered seat name over the agent name.
            name: seatDisplayName(a.name, seat),
            ownerUserId: seatOwnerId(seat),
            capabilityId: route?.capabilityId ?? null,
            profile: route?.capability.profile ?? null,
            clientReady:
              p?.capabilities?.includes("analysis-execution-v1") ?? false,
            online: isSeatOnline(p),
          };
        }),
    );
  });
  router.get(base + "/pending-actions", async (req, res) => {
    const c = board(req);
    const scope = await personalTaskScope(db, req.actor, c);
    const rows = await db.select({
      id: analysisDecisions.id,
      taskId: analysisExecutions.id,
      projectId: analysisExecutions.projectId,
      ownerUserId: analysisExecutions.ownerUserId,
      seatId: analysisExecutions.seatId,
      runId: analysisDecisions.runId,
      key: analysisDecisions.key,
      kind: analysisDecisions.kind,
      title: analysisExecutions.title,
      prompt: analysisDecisions.text,
      createdAt: analysisDecisions.createdAt,
    }).from(analysisDecisions)
      .innerJoin(analysisExecutions, and(eq(analysisExecutions.id, analysisDecisions.executionId), eq(analysisExecutions.companyId, c)))
      .innerJoin(issues, and(eq(issues.id, analysisExecutions.id), eq(issues.companyId, c)))
      .innerJoin(heartbeatRuns, and(eq(heartbeatRuns.id, analysisExecutions.activeRunId), eq(heartbeatRuns.companyId, c)))
      .where(and(
        eq(analysisDecisions.companyId, c),
        eq(analysisDecisions.status, "open"),
        inArray(analysisDecisions.kind, ["question", "review"]),
        eq(analysisDecisions.runId, analysisExecutions.activeRunId),
        eq(heartbeatRuns.status, "running"),
        sql`${analysisExecutions.delivery} is null`,
        sql`${issues.status} not in ('done', 'cancelled')`,
        taskScopeCondition(scope),
      )).orderBy(desc(analysisDecisions.createdAt), desc(analysisDecisions.id));
    // A replaced question with the same key must never become a second todo.
    const seen = new Set<string>();
    res.setHeader("Cache-Control", "no-store");
    res.json(rows.filter(row => {
      const key = `${row.taskId}:${row.runId}:${row.key}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    }));
  });
  router.get(base, async (req, res) => {
    const c = board(req);
    const q = z
      .object({
        projectId: uuid.optional(),
        page: z.coerce.number().int().min(1).max(10000).default(1),
      })
      .safeParse(req.query);
    if (!q.success) throw badRequest("分析筛选无效");
    const list = await db
      .select()
      .from(analysisExecutions)
      .where(
        and(
          eq(analysisExecutions.companyId, c),
          q.data.projectId
            ? eq(analysisExecutions.projectId, q.data.projectId)
            : undefined,
          sql`${analysisExecutions.id} in (select ${issues.id} from ${issues} where ${issues.companyId} = ${c} and ${taskScopeCondition(await personalTaskScope(db, req.actor, c))})`,
        ),
      )
      .orderBy(desc(analysisExecutions.createdAt))
      .limit(26)
      .offset((q.data.page - 1) * 25);
    res.setHeader("Cache-Control", "no-store");
    const runIds = list
      .map((t) => t.activeRunId)
      .filter((id): id is string => !!id);
    const runs = runIds.length
      ? await db
          .select({ id: heartbeatRuns.id, status: heartbeatRuns.status })
          .from(heartbeatRuns)
          .where(
            and(
              eq(heartbeatRuns.companyId, c),
              inArray(heartbeatRuns.id, runIds),
            ),
          )
      : [];
    res.json({
      items: await Promise.all(list.slice(0, 25).map(async t => {
        const projected = view(t, runs.find(r => r.id === t.activeRunId)?.status);
        return await analysisDispatchProblem(db, t) ? { ...projected, state: "interrupted" } : projected;
      })),
      hasMore: list.length > 25,
    });
  });
  async function detail(t: typeof analysisExecutions.$inferSelect) {
    const decisions = await db
      .select()
      .from(analysisDecisions)
      .where(
        and(
          eq(analysisDecisions.executionId, t.id),
          eq(analysisDecisions.companyId, t.companyId),
        ),
      )
      .orderBy(desc(analysisDecisions.createdAt))
      .limit(100);
    const [run] = t.activeRunId
      ? await db
          .select({
            id: heartbeatRuns.id,
            status: heartbeatRuns.status,
            error: heartbeatRuns.error,
          })
          .from(heartbeatRuns)
          .where(eq(heartbeatRuns.id, t.activeRunId))
      : [];
    const dispatchProblem = await analysisDispatchProblem(db, t);
    return { execution: { ...view(t, run?.status), ...(dispatchProblem ? { state: "interrupted" } : {}) }, decisions, run: run ?? null, dispatchProblem };
  }
  // Absence is explicit. Access failures and read failures must never select
  // generic task controls as a fallback for an analysis task.
  router.get(base + "/by-task/:executionId", async (req, res) => {
    const t = await findRecord(req);
    res.setHeader("Cache-Control", "no-store");
    res.json({ analysis: t ? await detail(t) : null });
  });
  router.get(base + "/:executionId", async (req, res) => {
    const t = await record(req);
    res.setHeader("Cache-Control", "no-store");
    res.json(await detail(t));
  });
  router.post(base, async (req, res) => {
    const c = board(req, true),
      p = analysisCreateSchema.safeParse(req.body);
    if (!p.success) throw badRequest("请填写项目、席位、标题和分析诉求");
    const v = p.data;
    if (containsCredential(v.brief))
      throw badRequest("请不要在分析诉求中填写凭据");
    const result = await db.transaction(async (tx) => {
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtextextended(${c + ":analysis-create:" + v.requestId},0))`,
      );
      const [existing] = await tx
        .select()
        .from(analysisExecutions)
        .where(
          and(
            eq(analysisExecutions.companyId, c),
            eq(analysisExecutions.requestId, v.requestId),
          ),
        );
      if (existing) {
        if (
          existing.title !== v.title ||
          existing.brief !== v.brief ||
          existing.projectId !== v.projectId ||
          existing.seatId !== v.seatId ||
          existing.createdBy !== (req.actor.userId ?? "local-board") ||
          existing.demandNo !== (v.demandNo || null) ||
          !isDeepStrictEqual(existing.qingzhouWriteback?.options ?? {}, v.qingzhouOptions ?? {}) ||
          existing.supersedesId !== (v.supersedesId ?? null)
        )
          throw conflict("请求编号已用于其他分析任务");
        return existing;
      }
      const [project] = await tx
        .select()
        .from(projects)
        .where(and(eq(projects.companyId, c), eq(projects.id, v.projectId)));
      const [seat] = await tx
        .select()
        .from(agents)
        .where(and(eq(agents.companyId, c), eq(agents.id, v.seatId)));
      const owner = seatOwnerId(
        seat?.adapterConfig.dsp7Seat as Record<string, unknown>,
      );
      if (
        !project ||
        project.archivedAt ||
        !seat ||
        !owner ||
        seat.adapterConfig.dsp7Transport !== "outbound"
      )
        throw badRequest("请选择有效项目和已指定负责人的出站席位");
      resolveHarnessRoute(seat, {
        runId: randomUUID(),
        taskId: randomUUID(),
        kind: "analysis",
        required: true,
      });
      let revision = 1;
      if (v.supersedesId) {
        const [old] = await tx
          .select()
          .from(analysisExecutions)
          .where(
            and(
              eq(analysisExecutions.id, v.supersedesId),
              eq(analysisExecutions.companyId, c),
              eq(analysisExecutions.projectId, v.projectId),
            ),
          )
          .for("update");
        if (!old) throw conflict("原分析版本不属于该项目");
        revision = old.revision + 1;
      }
      const id = randomUUID();
      await tx.insert(issues).values({
        id,
        companyId: c,
        projectId: v.projectId,
        title: v.title,
        description: "独立需求分析任务；执行、修订及授权以分析记录为准。",
        status: "backlog",
        priority: "medium",
        assigneeAgentId: seat.id,
        createdByUserId: req.actor.userId ?? null,
      });
      const [row] = await tx
        .insert(analysisExecutions)
        .values({
          id,
          companyId: c,
          projectId: v.projectId,
          seatId: seat.id,
          ownerUserId: owner,
          revision,
          supersedesId: v.supersedesId ?? null,
          requestId: v.requestId,
          createdBy: req.actor.userId ?? "local-board",
          title: v.title,
          brief: v.brief,
          demandNo: v.demandNo || null,
          qingzhouWriteback: v.demandNo ? { status: "pending", options: v.qingzhouOptions } : null,
        })
        .returning();
      await audit(
        tx as unknown as Db,
        c,
        row.createdBy,
        "analysis.created",
        id,
        { revision, seatId: seat.id, executionGranted: false },
      );
      return row;
    });
    res.status(201).json(result);
  });
  router.post(base + "/:executionId/dispatch", async (req, res) => {
    const t = await record(req, true),
      parsed = z.object({ requestId: uuid }).strict().safeParse(req.body);
    if (!parsed.success) throw badRequest("派发请求无效");
    const run = await dispatchAnalysisExecution(db,t,parsed.data.requestId,req.actor.userId ?? "local-board");
    const d=t;
    res.json({ executionId: d.id, runId: run?.id ?? null, state: run ? (["queued", "running", "scheduled_retry"].includes(run.status) ? run.status : "interrupted") : "queued" });
  });
  router.post(base + "/:executionId/qingzhou-writeback", async (req, res) => {
    const task = await record(req, true);
    const parsed = z.object({ options: analysisQingzhouOptionsSchema.optional() }).strict().safeParse(req.body);
    if (!parsed.success) throw badRequest("请填写有效的轻舟回写参数");
    if (!task.demandNo) throw badRequest("该分析任务未绑定轻舟条目");
    const result = await writeAnalysisToQingzhou(db, task.companyId, task.id, { type: "user", id: req.actor.userId ?? "local-board" }, parsed.data.options);
    res.json(result);
  });
  router.post(
    base + "/:executionId/decisions/:decisionId/answer",
    async (req, res) => {
      const t = await record(req),
        p = z
          .object({
            answer: z.string().trim().min(1).max(8000),
            contentDigest: z.string().regex(/^[a-f0-9]{64}$/),
          })
          .strict()
          .safeParse(req.body);
      if (!p.success || containsCredential(p.data.answer))
        throw badRequest("请填写当前问题的明确答复，不要包含凭据");
      await db.transaction(async (tx) => {
        const [fresh] = await tx
          .select()
          .from(analysisExecutions)
          .where(eq(analysisExecutions.id, t.id))
          .for("update");
        const [d] = await tx
          .select()
          .from(analysisDecisions)
          .where(
            and(
              eq(analysisDecisions.id, String(req.params.decisionId)),
              eq(analysisDecisions.executionId, t.id),
            ),
          )
          .for("update");
        const [currentRun] = fresh.activeRunId
          ? await tx
              .select()
              .from(heartbeatRuns)
              .where(eq(heartbeatRuns.id, fresh.activeRunId))
          : [];
        if (fresh.delivery || currentRun?.status !== "running")
          throw conflict("本次会话已结束，请核验并恢复后处理新的问题");
        if (
          !d ||
          d.status !== "open" ||
          d.contentDigest !== p.data.contentDigest ||
          d.runId !== fresh.activeRunId
        )
          throw conflict("问题版本或运行已变化，请刷新");
        if (d.kind === "review" && p.data.answer === "approve") {
          requireReviewMaterials(fresh.snapshot, d);
        }
        await tx
          .update(analysisDecisions)
          .set({
            status: "answered",
            answer: p.data.answer,
            answeredBy: req.actor.userId ?? "local-board",
            answeredAt: new Date(),
          })
          .where(eq(analysisDecisions.id, d.id));
        await audit(
          tx as unknown as Db,
          t.companyId,
          req.actor.userId ?? "local-board",
          "analysis.decision.answered",
          t.id,
          {
            decisionId: d.id,
            inputDigest: d.inputDigest,
            contentDigest: d.contentDigest,
            kind: d.kind,
          },
        );
      });
      res.json({
        received: true,
        meaning: "已保存，等待同一会话领取；不代表门禁通过",
      });
    },
  );
  router.post(base + "/:executionId/stop", async (req, res) => {
    const t = await record(req);
    if (!t.activeRunId) throw conflict("没有活动分析运行");
    const [agent] = await db
      .select()
      .from(agents)
      .where(and(eq(agents.id, t.seatId), eq(agents.companyId, t.companyId)));
    await db.transaction(async (tx) => {
      await recordSeatStopIntent(
        tx as unknown as Db,
        agent,
        t.activeRunId!,
        t.id,
      );
      await audit(
        tx as unknown as Db,
        t.companyId,
        req.actor.userId ?? "local-board",
        "analysis.stop.requested",
        t.id,
        { runId: t.activeRunId },
      );
    });
    await heartbeatService(db).cancelRun(
      t.activeRunId,
      "Analysis stopped by owner",
      { resultJson: { cancelledByActorType: "user" } },
    );
    res.json({ received: true, executionStopVerified: false });
  });
  router.post(base + "/:executionId/publication", async (req, res) => {
    const t = await record(req, true),
      p = z
        .object({
          inputDigest: z.string().regex(/^[a-f0-9]{64}$/),
          handoffDigest: z.string().regex(/^[a-f0-9]{64}$/),
          url: z.string().url().max(2000),
          note: z.string().trim().min(10).max(2000),
          attest: z.literal(true),
        })
        .strict()
        .safeParse(req.body);
    if (!p.success || containsCredential(p.data.note))
      throw badRequest("请提供正式引用、版本摘要和核验说明，不要包含凭据");
    const url = new URL(p.data.url);
    if (
      !["jira.fingard.com", "proj.fingard.com"].includes(url.hostname) ||
      !["http:", "https:"].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.search ||
      url.hash
    )
      throw badRequest("请提供不带凭据/查询参数的 Jira 或轻舟正式记录链接");
    await db.transaction(async (tx) => {
      const [f] = await tx
        .select()
        .from(analysisExecutions)
        .where(eq(analysisExecutions.id, t.id))
        .for("update");
      if (
        !f.delivery ||
        f.delivery.inputDigest !== p.data.inputDigest ||
        f.delivery.handoffDigest !== p.data.handoffDigest
      )
        throw conflict("本地交付版本已变化或尚未完成");
      const publication = {
        url: url.toString(),
        note: p.data.note,
        verifiedBy: req.actor.userId ?? "local-board",
        verifiedAt: new Date().toISOString(),
        method: "manual-attestation" as const,
        inputDigest: f.delivery.inputDigest,
        handoffDigest: f.delivery.handoffDigest,
      };
      if (f.publication) throw conflict("该版本已登记正式发布，不覆盖历史");
      await tx
        .update(analysisExecutions)
        .set({ publication, state: "published", updatedAt: new Date() })
        .where(eq(analysisExecutions.id, t.id));
      await audit(
        tx as unknown as Db,
        t.companyId,
        publication.verifiedBy,
        "analysis.publication.recorded",
        t.id,
        { ...publication, automaticReadback: false },
      );
    });
    res.json({
      received: true,
      method: "manual-attestation",
      automaticReadback: false,
    });
  });
  // Device callbacks require a standard seat credential, matching machine and a live, exact run lease.
  async function device(req: Request, store: Db = db) {
    if (
      req.actor.type !== "agent" ||
      req.actor.source !== "agent_key" ||
      req.actor.agentId !== String(req.params.id) ||
      (req.actor.keyScope && req.actor.keyScope.kind !== "standard")
    )
      throw forbidden("需要本席位设备凭证");
    const companyId = req.actor.companyId!;
    assertCompanyAccess(req, companyId);
    const runId = String(req.params.runId);
    if (!uuid.safeParse(runId).success) throw badRequest("运行编号无效");
    const data = z
      .object({
        seat_id: uuid,
        machine_id: uuid,
        machine_fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
        lease: uuid,
      })
      .safeParse(req.body);
    if (!data.success) throw forbidden("设备身份无效");
    const scope = await assertAnalysisRun(
        store,
        companyId,
        req.actor.agentId!,
        runId,
      ),
      s = scope.agent.adapterConfig.dsp7Seat as Record<string, unknown>;
    if (
      data.data.seat_id !== scope.agent.id ||
      data.data.machine_id !== s.machineId ||
      data.data.machine_fingerprint !== s.machineFingerprint
    )
      throw forbidden("设备绑定不匹配");
    const [permit] = await store
      .select()
      .from(seatExecutionPermits)
      .where(
        and(
          eq(seatExecutionPermits.runId, runId),
          eq(seatExecutionPermits.companyId, companyId),
          eq(seatExecutionPermits.leaseHash, hash(data.data.lease)),
        ),
      );
    if (
      !permit ||
      permit.revokedAt ||
      permit.expiresAt.getTime() <= Date.now() ||
      scope.run.status !== "running"
    )
      throw conflict("分析执行许可已失效");
    return { ...scope, permit };
  }
  async function live(tx: Db, req: Request, id: string, allowFrozen = false) {
    const [task] = await tx
      .select()
      .from(analysisExecutions)
      .where(eq(analysisExecutions.id, id))
      .for("update");
    if (!task) throw notFound("分析任务不存在");
    const scope = await device(req, tx);
    if (!allowFrozen && (scope.task.delivery || scope.task.publication))
      throw conflict("本地交付已冻结，不接受运行状态覆盖");
    return scope;
  }
  const callback = "/agents/:id/analysis-runs/:runId";
  router.post(callback + "/qingzhou-credentials", async (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Pragma", "no-cache");
    const result = await db.transaction(async tx => {
      const initial = await device(req, tx as unknown as Db);
      await tx.execute(seatQingzhouLock(initial.task.companyId, initial.task.seatId));
      const scope = await live(tx as unknown as Db, req, initial.task.id);
      if (req.body.demandNo !== scope.task.demandNo) throw forbidden("只能采集当前分析任务绑定的轻舟条目");
      return analysisQingzhouCredentials(tx as unknown as Db, scope);
    });
    res.json(result);
  });
  router.post(callback + "/context", async (req, res) => {
    const s = await device(req);
    res.setHeader("Cache-Control", "no-store");
    res.json({ execution: s.task });
  });
  router.post(callback + "/observe", async (req, res) => {
    const s = await device(req),
      p = analysisSnapshotSchema.safeParse(req.body.snapshot);
    if (!p.success || containsCredential(JSON.stringify(p.data)))
      throw badRequest("分析状态回执无效或包含凭据");
    validateAnalysisSnapshot(p.data, s.task);
    validateReviewMaterials(p.data, s.run.id);
    if (s.task.delivery) throw conflict("本地交付已冻结，不接受运行状态覆盖");
    const route = s.permit.executionRoute;
    if (
      p.data.binding.profile !== route?.capability.profile ||
      p.data.binding.repository !== route.capability.repository
    )
      throw conflict("分析状态不属于固定能力");
    await db.transaction(async (tx) => {
      const current = await live(tx as unknown as Db, req, s.task.id);
      await tx
        .update(analysisExecutions)
        .set({
          snapshot: {
            ...p.data,
            ...(p.data.phase === "P3" && !p.data.reviewMaterials && current.task.snapshot?.reviewMaterials
              ? { reviewMaterials: current.task.snapshot.reviewMaterials } : {}),
          },
          state: req.body.waiting === true ? "waiting" : "running",
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(analysisExecutions.id, s.task.id),
            eq(analysisExecutions.activeRunId, s.run.id),
          ),
        );
      await tx
        .update(issues)
        .set({
          status: req.body.waiting === true ? "blocked" : "in_progress",
          unblockDescriptor:
            req.body.waiting === true
              ? {
                  owner: "board",
                  action: "请在独立需求分析页面回答当前版本问题或评审",
                }
              : null,
          updatedAt: new Date(),
        })
        .where(eq(issues.id, s.task.id));
    });
    res.json({ received: true });
  });
  router.post(callback + "/questions", async (req, res) => {
    const s = await device(req),
      p = z.array(analysisQuestionSchema).max(50).safeParse(req.body.questions);
    if (!p.success || containsCredential(JSON.stringify(p.data)))
      throw badRequest("问题内容无效或包含凭据");
    await db.transaction(async (tx) => {
      const current = await live(tx as unknown as Db, req, s.task.id);
      if (
        new Set(p.data.map((q) => q.key)).size !== p.data.length ||
        p.data.some(
          (q) =>
            q.kind === "review" &&
            (q.key !== "P3-review" || current.task.snapshot?.phase !== "P3"),
        )
      )
        throw conflict("评审必须来自原生 P3 当前阶段，问题编号不能重复");
      const prior = await tx
        .select()
        .from(analysisDecisions)
        .where(
          and(
            eq(analysisDecisions.executionId, s.task.id),
            eq(analysisDecisions.runId, s.run.id),
          ),
        );
      for (const old of prior.filter(
        (d) =>
          ["open", "answered"].includes(d.status) &&
          !p.data.some(
            (v) =>
              v.key === d.key &&
              v.contentDigest === d.contentDigest &&
              v.inputDigest === d.inputDigest,
          ),
      ))
        await tx
          .update(analysisDecisions)
          .set({ status: "stale" })
          .where(eq(analysisDecisions.id, old.id));
      for (const q of p.data)
        await tx
          .insert(analysisDecisions)
          .values({
            companyId: s.task.companyId,
            executionId: s.task.id,
            runId: s.run.id,
            ...q,
          })
          .onConflictDoNothing();
    });
    const decisions = await db
      .select()
      .from(analysisDecisions)
      .where(
        and(
          eq(analysisDecisions.executionId, s.task.id),
          eq(analysisDecisions.runId, s.run.id),
          inArray(analysisDecisions.status, ["open", "answered"]),
        ),
      );
    res.setHeader("Cache-Control", "no-store");
    res.json({ decisions });
  });
  router.post(callback + "/ack", async (req, res) => {
    const s = await device(req),
      p = z
        .object({
          decisionId: uuid,
          contentDigest: z.string(),
          inputDigest: z.string(),
        })
        .safeParse(req.body);
    if (!p.success) throw badRequest("回执无效");
    await db.transaction(async (tx) => {
      await live(tx as unknown as Db, req, s.task.id);
      const [d] = await tx
        .select()
        .from(analysisDecisions)
        .where(
          and(
            eq(analysisDecisions.id, p.data.decisionId),
            eq(analysisDecisions.executionId, s.task.id),
            eq(analysisDecisions.runId, s.run.id),
            eq(analysisDecisions.contentDigest, p.data.contentDigest),
            eq(analysisDecisions.inputDigest, p.data.inputDigest),
          ),
        )
        .for("update");
      if (!d || !["answered", "delivered"].includes(d.status))
        throw conflict("决定已过期或尚未回答");
      if (d.status === "answered")
        await tx
          .update(analysisDecisions)
          .set({ status: "delivered", ackedAt: new Date() })
          .where(eq(analysisDecisions.id, d.id));
    });
    res.json({ received: true, meaning: "送达，不代表领域问题已解决" });
  });
  router.post(callback + "/delivery", async (req, res) => {
    const s = await device(req),
      p = analysisDeliverySchema.safeParse(req.body.delivery);
    if (!p.success) throw badRequest("交付清单无效");
    if (p.data.analysisMarkdown !== undefined && (!s.task.demandNo || containsCredential(p.data.analysisMarkdown))) throw badRequest("分析正文未绑定轻舟条目或疑似包含凭据，请先核对并脱敏");
    validateAnalysisDelivery(p.data, s.task);
    await db.transaction(async (tx) => {
      const scope = await live(tx as unknown as Db, req, s.task.id, true),
        f = scope.task;
      const [approval] = await tx
        .select()
        .from(analysisDecisions)
        .where(
          and(
            eq(analysisDecisions.executionId, s.task.id),
            eq(analysisDecisions.companyId, s.task.companyId),
            eq(analysisDecisions.kind, "review"),
            eq(analysisDecisions.inputDigest, p.data.inputDigest),
            eq(analysisDecisions.answer, "approve"),
            eq(analysisDecisions.status, "delivered"),
          ),
        );
      if (!approval?.answeredBy || !approval.answeredAt)
        throw conflict("缺少当前输入版本的真实网页质量评审批准");
      const [pending] = await tx
        .select()
        .from(analysisDecisions)
        .where(
          and(
            eq(analysisDecisions.executionId, s.task.id),
            eq(analysisDecisions.runId, s.run.id),
            inArray(analysisDecisions.status, ["open", "answered"]),
          ),
        );
      if (pending) throw conflict("仍有未送达的分析决定");
      if (f.delivery) {
        const { analysisMarkdown: previousContent, ...previous } = f.delivery;
        const { analysisMarkdown: nextContent, ...next } = p.data;
        if (!isDeepStrictEqual(previous, next) || (previousContent !== undefined && nextContent !== undefined && previousContent !== nextContent))
          throw conflict("交付已冻结，请建立新修订");
        // An upgraded client may supply the exact already-hashed analysis.md.
        if (previousContent === undefined && nextContent !== undefined) await tx.update(analysisExecutions).set({ delivery: p.data }).where(eq(analysisExecutions.id, f.id));
        return;
      }
      await tx
        .update(analysisExecutions)
        .set({
          snapshot: analysisSnapshotSchema.parse(
            Object.fromEntries(
              Object.entries(p.data).filter(
                ([k]) =>
                  !["inputDigest", "handoffDigest", "artifacts", "analysisMarkdown"].includes(k),
              ),
            ),
          ),
          delivery: p.data as AnalysisDelivery,
          state: "local_completed",
          updatedAt: new Date(),
        })
        .where(eq(analysisExecutions.id, s.task.id));
      await tx
        .update(issues)
        .set({ status: "done", completedAt: new Date(), updatedAt: new Date() })
        .where(eq(issues.id, s.task.id));
      await tx
        .insert(managedTaskFacts)
        .values({
          companyId: s.task.companyId,
          taskId: s.task.id,
          seatId: s.task.seatId,
          ownerUserId: s.task.ownerUserId,
          kind: "delivered",
          simulated: false,
        })
        .onConflictDoNothing();
      await audit(
        tx as unknown as Db,
        s.task.companyId,
        s.agent.id,
        "analysis.delivery.collected",
        s.task.id,
        {
          runId: s.run.id,
          inputDigest: p.data.inputDigest,
          handoffDigest: p.data.handoffDigest,
          formalPublication: false,
        },
      );
    });
    const qingzhouWriteback = s.task.demandNo ? await writeAnalysisToQingzhou(db, s.task.companyId, s.task.id, { type: "agent", id: s.agent.id }) : null;
    res.json({ received: true, formalPublication: false, qingzhouWriteback });
  });
  return router;
}

export async function dispatchAnalysisExecution(db:Db,t:typeof analysisExecutions.$inferSelect,requestId:string,actor:string) {
    const d = await db.transaction(async (tx) => {
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtextextended(${t.seatId + ":seat-commands"},0))`,
      );
      const [fresh] = await tx
        .select()
        .from(analysisExecutions)
        .where(eq(analysisExecutions.id, t.id))
        .for("update");
      if (fresh.delivery || fresh.publication)
        throw conflict("已有交付，请建立新修订，不覆盖旧版本");
      const [seat] = await tx
        .select()
        .from(agents)
        .where(and(eq(agents.id, t.seatId), eq(agents.companyId, t.companyId)))
        .for("update");
      const [issue] = await tx.select().from(issues).where(eq(issues.id, t.id));
      const presence = seat?.adapterConfig.dsp7SeatPresence as
        | {
            lastSeenAt?: string;
            capabilities?: string[];
            state?: string;
            acceptingWork?: boolean;
          }
        | undefined;
      if (
        !seat ||
        ["paused", "terminated", "pending_approval"].includes(seat.status) ||
        seatOwnerId(seat.adapterConfig.dsp7Seat as Record<string, unknown>) !==
          t.ownerUserId ||
        issue.assigneeAgentId !== seat.id ||
        ["done", "cancelled"].includes(issue.status)
      )
        throw conflict("席位负责人或任务状态已变化");
      if (!presence?.capabilities?.includes("analysis-execution-v1"))
        throw conflict("请先更新席位客户端，需支持分析执行协议");
      const [oldRun] = fresh.activeRunId
        ? await tx
            .select()
            .from(heartbeatRuns)
            .where(eq(heartbeatRuns.id, fresh.activeRunId))
        : [];
      if (
        fresh.state === "queued" &&
        fresh.dispatchId &&
        !fresh.activeRunId &&
        fresh.dispatchId !== requestId
      )
        throw conflict(
          "派发结果尚未确认，请刷新并重试原派发请求，不能建立第二个执行器",
        );
      if (fresh.dispatchId === requestId) {
        if (oldRun && ["queued", "running", "scheduled_retry"].includes(oldRun.status)) return fresh;
        if (oldRun) throw conflict("该派发请求已结束，恢复需新的请求编号");
      }
      if (
        oldRun &&
        ["queued", "running", "scheduled_retry"].includes(oldRun.status)
      )
        throw conflict("已有分析运行，请查看或处理当前决策");
      if (
        !presence.lastSeenAt ||
        Date.now() - Date.parse(presence.lastSeenAt) > 90000 ||
        presence.acceptingWork === false ||
        !seatCanAcceptWork(presence)
      )
        throw conflict("席位离线、配置异常或已暂停接单，请上线后重试");
      await acknowledgeStoppedAnalysisExecution(tx as unknown as Db, { agent: seat, issue, actorId: actor });
      const route = resolveHarnessRoute(seat, {
        runId: randomUUID(),
        taskId: t.id,
        kind: "analysis",
        required: true,
      })!;
      await assertNewDomainMetering(
        tx as unknown as Db,
        t.companyId,
        t.seatId,
        t.projectId,
      );
      await assertSeatBudgetAdmission(tx as unknown as Db, {
        companyId: t.companyId,
        agentId: t.seatId,
        projectId: t.projectId,
        taskId: t.id,
      });
      await tx
        .update(analysisDecisions)
        .set({ status: "stale" })
        .where(
          and(
            eq(analysisDecisions.executionId, t.id),
            inArray(analysisDecisions.status, ["open", "answered"]),
          ),
        );
      const [updated] = await tx
        .update(analysisExecutions)
        .set({
          state: "queued",
          dispatchId: requestId,
          activeRunId: null,
          capabilityId: route.capabilityId,
          registryRevision: route.registryRevision,
          updatedAt: new Date(),
        })
        .where(eq(analysisExecutions.id, t.id))
        .returning();
      await tx
        .update(issues)
        .set({ status: "todo", updatedAt: new Date() })
        .where(eq(issues.id, t.id));
      await tx.insert(activityLog).values({companyId:t.companyId,actorType:"user",actorId:actor,action:"analysis.dispatched",entityType:"analysis_execution",entityId:t.id,details:{dispatchId:requestId,revision:t.revision}});
      return updated;
    });
    if (d.activeRunId) {
      const [existing] = await db.select().from(heartbeatRuns).where(and(eq(heartbeatRuns.id, d.activeRunId), eq(heartbeatRuns.companyId, d.companyId), eq(heartbeatRuns.agentId, d.seatId)));
      if (existing) return existing;
    }
    let run: typeof heartbeatRuns.$inferSelect | null = null;
    let wakeFailure: unknown;
    try { run = await heartbeatService(db).wakeup(d.seatId, {
      source: "automation",
      triggerDetail: "callback",
      reason: "智研需求分析授权启动；" + d.dispatchId,
      idempotencyKey: "analysis-" + d.dispatchId,
      requestedByActorType: "user",
      requestedByActorId: actor,
      allowRunCoalescing: false,
      payload: { issueId: d.id, taskId: d.id },
      contextSnapshot: {
        issueId: d.id,
        taskId: d.id,
        analysisExecutionId: d.id,
        analysisDispatchId: d.dispatchId,
        analysisGrantedBy: actor,
        forceFreshSession: true,
      },
      issueStateGuard: {
        statuses: ["todo", "in_progress"],
        assigneeAgentId: d.seatId,
      },
    });
    } catch (error) { wakeFailure = error; }
    return settleAnalysisDispatch(db, { companyId: d.companyId, seatId: d.seatId, taskId: d.id, dispatchId: d.dispatchId!, actorId: actor }, run, wakeFailure);
}
