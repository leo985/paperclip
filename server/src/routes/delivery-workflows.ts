import { readDeliveryJiraAssignments, deliverySeatMatchesAssignee } from "../services/delivery-seat-assignment.js";
import {
  readyDeliveryStages,
  deliveryAncestors,
} from "../services/delivery-graph.js";
import { assertTemplateReviewer } from "../services/delivery-templates.js";
import { recordSeatStopIntent } from "../services/seat-execution-stop.js";
import { heartbeatService } from "../services/heartbeat.js";
import { createHash } from "node:crypto";
import { Router, type Request } from "express";
import { and, eq, inArray } from "drizzle-orm";
import {
  activityLog,
  agents,
  analysisExecutions,
  deliverySnapshots,
  deliveryWorkflows,
  issues,
  seatExecutionPermits,
  type Db,
} from "@paperclipai/db";
import { z } from "zod";
import {
  DELIVERY_STAGE_MAX_RESUMES,
  deliveryWorkflowStartSchema,
  deliveryReviewDigest,
  deliveryRepairStartSchema,
  deliveryStageReceiptSchema,
} from "@paperclipai/shared";
import { assertBoard, assertCompanyAccess } from "./authz.js";
import { isSeatManager, seatOwnerId } from "./dsp7-seat-owners.js";
import { badRequest, conflict, forbidden, notFound } from "../errors.js";
import { containsCredential } from "../services/managed-sessions.js";
import {
  assertDeliveryRun,
  assertWorkflowSource,
  startDeliveryWorkflow,
  startDeliveryRepair,
  workflowAudit,
  deliveryDigest,
  validateStageReceipt,
  assertHumanReviewScope,
  stageKind,
} from "../services/delivery-workflows.js";
import { resolveHarnessRoute } from "../services/harness-execution-routing.js";
const uuid = z.string().uuid();
const reference = z
  .string()
  .url()
  .max(2000)
  .refine((v) => {
    const u = new URL(v);
    return (
      ["http:", "https:"].includes(u.protocol) && !u.username && !u.password
    );
  });
export function deliveryWorkflowRoutes(db: Db) {
  const router = Router(),
    base = "/companies/:companyId/delivery-workflows";
  function board(req: Request, manage = false) {
    const c = String(req.params.companyId);
    assertBoard(req);
    assertCompanyAccess(req, c);
    if (manage && !isSeatManager(req, c)) throw forbidden("需要组织管理员权限");
    return c;
  }
  async function record(req: Request) {
    const c = board(req);
    if (!uuid.safeParse(req.params.workflowId).success)
      throw badRequest("流程编号无效");
    const [f] = await db
      .select()
      .from(deliveryWorkflows)
      .where(
        and(
          eq(deliveryWorkflows.companyId, c),
          eq(deliveryWorkflows.id, String(req.params.workflowId)),
        ),
      );
    if (
      !f ||
      (!isSeatManager(req, c) &&
        !f.stages.some(
          (s) =>
            s.ownerUserId === req.actor.userId ||
            s.reviewerUserId === req.actor.userId,
        ))
    )
      throw notFound("交付流程不存在或未获授权");
    return f;
  }
  router.get(base + "/seats", async (req, res) => {
    const c = board(req);
    const rows = await db.select().from(agents).where(eq(agents.companyId, c));
    let source: typeof deliverySnapshots.$inferSelect | undefined;
    if(req.query.snapshotId!==undefined){
      const parsed=uuid.safeParse(req.query.snapshotId);if(!parsed.success)throw badRequest("请选择条目版本");
      [source]=await db.select().from(deliverySnapshots).where(and(eq(deliverySnapshots.companyId,c),eq(deliverySnapshots.id,parsed.data)));
      if(!source)throw notFound("条目版本不存在");
    }
    let keys=source?.plan.items.filter(i=>i.parentKey).map(i=>i.key)??[];
    if(req.query.jiraKeys!==undefined){
      if(!source || typeof req.query.jiraKeys!=="string")throw badRequest("请选择条目及待匹配工单");
      keys=req.query.jiraKeys.split(",").filter(Boolean);
      if(keys.length>3||keys.some(key=>!/^[A-Z][A-Z0-9_]*-\d+$/.test(key)))throw badRequest("修复链最多查询三张有效工单");
    }
    const assignments=source ? await readDeliveryJiraAssignments(db,c,source.projectId,keys) : new Map();

    res.json(
      rows
        .filter(
          (a) =>
            a.adapterConfig.dsp7Transport === "outbound" &&
            seatOwnerId(a.adapterConfig.dsp7Seat as Record<string, unknown>),
        )
        .map((a) => {
          const presence = a.adapterConfig.dsp7SeatPresence as
            | { lastSeenAt?: string; capabilities?: string[] }
            | undefined;
          const domains = ["analysis", "development", "qa"].flatMap((kind) => {
            try {
              const route = resolveHarnessRoute(a, {
                runId: a.id,
                taskId: a.id,
                kind: kind as "analysis" | "development" | "qa",
                required: true,
              });
              return route ? [{ kind, roles: route.capability.roles }] : [];
            } catch {
              return [];
            }
          });
          return {
            id: a.id,
            name: a.name,
            ...(source ? {jiraKeys:[...assignments.entries()].filter(([,assignment])=>deliverySeatMatchesAssignee(a,source!.projectId,assignment)).map(([key])=>key)} : {}),
            domains,
            online:
              !!presence?.lastSeenAt &&
              Date.now() - Date.parse(presence.lastSeenAt) < 90000,
            clientReady: !!presence?.capabilities?.includes("delivery-flow-v1"),
            orderedReviewReady: !!presence?.capabilities?.includes("delivery-work-review-v1"),
          };
        }),
    );
  });
  router.get(base, async (req, res) => {
    const c = board(req);
    const snapshotId = uuid.safeParse(req.query.snapshotId);
    if (!snapshotId.success) throw badRequest("请选择条目版本");
    const [snapshot] = await db
      .select()
      .from(deliverySnapshots)
      .where(
        and(
          eq(deliverySnapshots.companyId, c),
          eq(deliverySnapshots.id, snapshotId.data),
        ),
      );
    if (!snapshot) throw notFound("条目不存在");
    const rows = await db
      .select()
      .from(deliveryWorkflows)
      .where(
        and(
          eq(deliveryWorkflows.companyId, c),
          eq(deliveryWorkflows.projectId, snapshot.projectId),
          eq(deliveryWorkflows.demandNo, snapshot.demandNo),
        ),
      );
    res.setHeader("Cache-Control", "no-store");
    res.json(
      rows.filter(
        (f) =>
          isSeatManager(req, c) ||
          f.stages.some(
            (s) =>
              s.ownerUserId === req.actor.userId ||
              s.reviewerUserId === req.actor.userId,
          ),
      ),
    );
  });
  router.get(base + "/:workflowId", async (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    res.json(await record(req));
  });
  router.post(base, async (req, res) => {
    const c = board(req, true);
    const p = deliveryWorkflowStartSchema.safeParse(req.body);
    if (!p.success || containsCredential(JSON.stringify(p.data)))
      throw badRequest(
        "请按模板配置真实工作单、评审关联和执行席位；测试阶段需提供环境引用，不能包含凭据",
      );
    res
      .status(201)
      .json(
        await startDeliveryWorkflow(
          db,
          c,
          req.actor.userId ?? "local-board",
          p.data,
        ),
      );
  });
  router.post(base + "/:workflowId/answer", async (req, res) => {
    const f = await record(req);
    const p = z
      .object({
        taskId: uuid,
        digest: z.string().regex(/^[a-f0-9]{64}$/),
        answer: z.string().trim().min(1).max(4000),
      })
      .strict()
      .safeParse(req.body);
    if (!p.success || containsCredential(JSON.stringify(p.data)))
      throw badRequest("请填写当前问题的答复，不要填写凭据");
    await db.transaction(async (tx) => {
      const [fresh] = await tx
        .select()
        .from(deliveryWorkflows)
        .where(eq(deliveryWorkflows.id, f.id))
        .for("update");
      const s = fresh.stages.find((s) => s.taskId === p.data.taskId);
      if (
        fresh.state !== "active" ||
        !s?.question ||
        s.question.digest !== p.data.digest ||
        s.question.answer ||
        s.state !== "waiting"
      )
        throw conflict("问题版本已变化或已答复");
      if (
        !isSeatManager(req, f.companyId) &&
        s.ownerUserId !== req.actor.userId
      )
        throw forbidden("需要席位负责人或管理员答复");
      const scope = await assertDeliveryRun(
        tx as unknown as Db,
        f.companyId,
        s.seatId,
        s.runId!,
      );
      if (scope.run.status !== "running")
        throw conflict("会话已结束，请刷新后处理当前阶段");
      s.question = {
        ...s.question,
        answer: p.data.answer,
        by: req.actor.userId ?? "local-board",
        at: new Date().toISOString(),
      };
      await tx
        .update(deliveryWorkflows)
        .set({ stages: fresh.stages, updatedAt: new Date() })
        .where(eq(deliveryWorkflows.id, f.id));
      await workflowAudit(
        tx as unknown as Db,
        f.companyId,
        s.question.by!,
        "delivery.question.answered",
        f.id,
        {
          taskId: s.taskId,
          digest: p.data.digest,
          question: s.question.text,
          answer: p.data.answer,
          runId: s.runId,
        },
      );
    });
    res.json({ received: true });
  });
  router.post(base + "/:workflowId/review", async (req, res) => {
    const f = await record(req),
      p = z
        .object({
          taskId: uuid,
          digest: z.string().regex(/^[a-f0-9]{64}$/),
          decision: z.enum(["approve", "reject"]),
          reference,
          note: z.string().trim().min(1).max(2000),
          manualDelivery: z.object({
            version: z.string().trim().min(1).max(500),
            artifactReferences: z.array(reference).min(1).max(20),
            testResults: z.object({total:z.number().int().positive().max(1000000),passed:z.number().int().nonnegative(),failed:z.number().int().nonnegative(),blocked:z.number().int().nonnegative(),skipped:z.number().int().nonnegative()}).strict().optional(),
          }).strict().optional(),
        })
        .strict()
        .safeParse(req.body);
    if (!p.success || containsCredential(JSON.stringify(p.data)))
      throw badRequest("请填写当前版本的正式结论链接和评审说明");
    await db.transaction(async (tx) => {
      const [fresh] = await tx
        .select()
        .from(deliveryWorkflows)
        .where(eq(deliveryWorkflows.id, f.id))
        .for("update");
      const s = fresh.stages.find((s) => s.taskId === p.data.taskId);
      if (
        fresh.state !== "active" ||
        !s ||
        s.state !== "review" ||
        deliveryReviewDigest(s) !== p.data.digest ||
        s.review
      )
        throw conflict("当前交付版本或评审状态已变化，请刷新");
      if (fresh.config.template) {
        if (
          !s.requiresReview ||
          s.reviewerUserId !== (req.actor.userId ?? "local-board")
        )
          throw forbidden("请由模板指定的审核人处理");
        await assertTemplateReviewer(
          tx as unknown as Db,
          f.companyId,
          s.reviewerUserId,
        );
      } else if (
        !isSeatManager(req, f.companyId) &&
        s.ownerUserId !== req.actor.userId
      )
        throw forbidden("只有该席位负责人或管理员可以核验评审");
      if (s.executionMode === "human") {
        await assertHumanReviewScope(tx as unknown as Db,fresh,s);
        const formal=new URL(p.data.reference);
        if(formal.pathname!=="/browse/"+s.jiraKey)throw conflict("请引用当前真实评审工单的正式结论链接");
        if(p.data.decision==="approve") {
          if (!s.reviewWorkKeys) {
            if (!p.data.manualDelivery) throw badRequest("人工工作单须填写交付版本和正式材料链接");
            const previous=s.reworkHistory?.flatMap(r=>r.previous.manualDelivery?[r.previous.manualDelivery]:[])??[];
            if(previous.some(old=>old.version===p.data.manualDelivery!.version))throw conflict("返工后请登记新交付版本，不能沿用退回版本");
            const result=p.data.manualDelivery.testResults;
            if(s.stage==="functional-test" && (!result || result.total!==result.passed+result.failed+result.blocked+result.skipped || result.passed!==result.total)) throw conflict("人工功能测试须登记可对账的全部通过结果；失败、阻塞或跳过时不能放行");
            if(s.stage!=="functional-test" && result) throw badRequest("仅功能测试可登记测试结果");
            s.manualDelivery=p.data.manualDelivery;
          } else if(p.data.manualDelivery) throw badRequest("评审节点仅登记正式评审结论");
          s.state="done";
          await tx.update(issues).set({status:"done",updatedAt:new Date()}).where(and(eq(issues.id,s.taskId),eq(issues.companyId,f.companyId)));
        }
      } else {
        await assertDeliveryRun(tx as unknown as Db,f.companyId,s.seatId,s.runId!);
      }
      s.review = {
        ...p.data,
        by: req.actor.userId ?? "local-board",
        at: new Date().toISOString(),
      };
      await tx
        .update(deliveryWorkflows)
        .set({
          stages: fresh.stages,
          state: p.data.decision === "reject" && fresh.config.template?.definition.stages[s.stage].rejectionHandling !== "automatic_rework" ? "blocked" : "active",
          message:
            p.data.decision === "reject"
              ? (fresh.config.template?.definition.stages[s.stage].rejectionHandling === "automatic_rework" ? "评审退回，等待调度原执行人修改：" : "评审退回，已暂停，等待手动发起返工：") + p.data.note
              : "当前版本评审已核验，等待推进",
          updatedAt: new Date(),
        })
        .where(eq(deliveryWorkflows.id, f.id));
      await workflowAudit(
        tx as unknown as Db,
        f.companyId,
        req.actor.userId ?? "local-board",
        "delivery.stage.reviewed",
        f.id,
        { ...p.data, method: "manual-attestation", automaticReadback: false },
      );
    });
    res.json({ received: true });
  });
  router.post(base + "/:workflowId/rework", async (req, res) => {
    const f = await record(req);
    const parsed=z.object({taskId:uuid,digest:z.string().regex(/^[a-f0-9]{64}$/)}).strict().safeParse(req.body);
    if(!parsed.success)throw badRequest("请指定当前退回的评审版本");
    await db.transaction(async tx=>{
      const [fresh]=await tx.select().from(deliveryWorkflows).where(and(eq(deliveryWorkflows.id,f.id),eq(deliveryWorkflows.companyId,f.companyId))).for("update");
      const stage=fresh.stages.find(s=>s.taskId===parsed.data.taskId);
      if(fresh.state!=="blocked"||stage?.review?.decision!=="reject"||deliveryReviewDigest(stage)!==parsed.data.digest)throw conflict("退回状态或版本已变化，请刷新");
      if(!isSeatManager(req,f.companyId)&&stage.review.by!==req.actor.userId)throw forbidden("请由原评审人或组织管理员发起返工");
      await assertWorkflowSource(tx as unknown as Db,fresh);
      if(stage.reviewerUserId)await assertTemplateReviewer(tx as unknown as Db,f.companyId,stage.reviewerUserId);
      await tx.update(deliveryWorkflows).set({state:"active",message:"已确认返工，等待旧进程停止核验后派回原执行人",updatedAt:new Date()}).where(eq(deliveryWorkflows.id,f.id));
      await workflowAudit(tx as unknown as Db,f.companyId,req.actor.userId??"local-board","delivery.review.rework.requested",f.id,parsed.data);
    });
    res.json({received:true});
  });
  router.post(base + "/:workflowId/accept", async (req, res) => {
    const f = await record(req);
    board(req, true);
    const p = z
      .object({
        reference,
        note: z.string().trim().min(1).max(2000),
        fingerprint: z.string(),
      })
      .strict()
      .safeParse(req.body);
    if (!p.success || containsCredential(JSON.stringify(p.data)))
      throw badRequest("请提供正式验收结论");
    await db.transaction(async (tx) => {
      const [fresh] = await tx
        .select()
        .from(deliveryWorkflows)
        .where(eq(deliveryWorkflows.id, f.id))
        .for("update");
      if (
        fresh.state !== "acceptance" ||
        fresh.fingerprint !== p.data.fingerprint ||
        fresh.stages.some((s) => s.state !== "done")
      )
        throw conflict("尚未满足验收条件或输入已变化");
      await assertWorkflowSource(tx as unknown as Db, fresh);
      const acceptance = {
        reference: p.data.reference,
        note: p.data.note,
        by: req.actor.userId ?? "local-board",
        at: new Date().toISOString(),
      };
      await tx
        .update(deliveryWorkflows)
        .set({
          state: "completed",
          acceptance,
          message: "已登记正式验收结论；源系统状态由正式流程维护",
          updatedAt: new Date(),
        })
        .where(eq(deliveryWorkflows.id, f.id));
      await workflowAudit(
        tx as unknown as Db,
        f.companyId,
        acceptance.by,
        "delivery.workflow.accepted",
        f.id,
        { ...acceptance, method: "manual-attestation" },
      );
    });
    res.json({ received: true });
  });
  router.post(base + "/:workflowId/cancel", async (req, res) => {
    const f = await record(req);
    board(req, true);
    const runs: Array<{ runId: string; seatId: string; taskId: string }> = [];
    await db.transaction(async (tx) => {
      const [fresh] = await tx
        .select()
        .from(deliveryWorkflows)
        .where(eq(deliveryWorkflows.id, f.id))
        .for("update");
      if (["completed", "cancelled"].includes(fresh.state))
        throw conflict("流程已结束");
      for (const stage of fresh.stages) {
        if (stage.state === "done") continue;
        let runId = stage.runId;
        if (stage.stage === "analysis") {
          const [a] = await tx
            .select()
            .from(analysisExecutions)
            .where(eq(analysisExecutions.id, stage.taskId));
          runId = a.activeRunId;
        }
        if (runId) {
          const [agent] = await tx
            .select()
            .from(agents)
            .where(
              and(
                eq(agents.id, stage.seatId),
                eq(agents.companyId, f.companyId),
              ),
            );
          await recordSeatStopIntent(
            tx as unknown as Db,
            agent,
            runId,
            stage.taskId,
          );
          runs.push({ runId, seatId: stage.seatId, taskId: stage.taskId });
        }
        await tx
          .update(issues)
          .set({ status: "cancelled", updatedAt: new Date() })
          .where(eq(issues.id, stage.taskId));
      }
      await tx
        .update(deliveryWorkflows)
        .set({
          state: "cancelled",
          message: "已停止后续派发；本机退出以进程树回执为准",
          updatedAt: new Date(),
        })
        .where(eq(deliveryWorkflows.id, f.id));
      await workflowAudit(
        tx as unknown as Db,
        f.companyId,
        req.actor.userId ?? "local-board",
        "delivery.workflow.cancelled",
        f.id,
        { runs },
      );
    });
    for (const run of runs)
      await heartbeatService(db).cancelRun(
        run.runId,
        "Delivery workflow cancelled",
        { resultJson: { cancelledByActorType: "user" } },
      );
    res.json({ received: true, executionStopVerified: false });
  });
  router.post(base + "/:workflowId/repair", async (req, res) => {
    const flow = await record(req);
    board(req, true);
    const parsed = deliveryRepairStartSchema.safeParse(req.body);
    if (!parsed.success)
      throw badRequest("请指定当前失败版本、独立修复和评审席位及三个真实工单");
    res.json(
      await startDeliveryRepair(
        db,
        flow.companyId,
        req.actor.userId ?? "local-board",
        flow.id,
        parsed.data,
      ),
    );
  });
  // No silent rerun after failure: operator may explicitly resume the same native directory only after tree-stop verification.
  router.post(base + "/:workflowId/confirm-start", async (req, res) => {
    const f = await record(req),
      parsed = z
        .object({
          taskId: uuid,
          inputDigest: z.string().regex(/^[a-f0-9]{64}$/),
        })
        .strict()
        .safeParse(req.body);
    if (!parsed.success) throw badRequest("请提交有效的阶段编号和输入版本");
    const input = parsed.data;
    await db.transaction(async (tx) => {
      const [fresh] = await tx
        .select()
        .from(deliveryWorkflows)
        .where(eq(deliveryWorkflows.id, f.id))
        .for("update");
      const stage = readyDeliveryStages(fresh.stages).find(
        (s) => s.taskId === input.taskId,
      );
      if (
        fresh.state !== "active" ||
        !stage ||
        stage.startMode !== "confirmation" ||
        stage.runId ||
        stage.startApprovedBy ||
        stage.inputDigest !== input.inputDigest
      )
        throw conflict("阶段状态已变化或前置尚未完成");
      if (
        !isSeatManager(req, f.companyId) &&
        stage.ownerUserId !== req.actor.userId
      )
        throw forbidden("只有席位负责人或管理员可以确认启动");
      await assertWorkflowSource(tx as unknown as Db, fresh);
      stage.startApprovedBy = req.actor.userId ?? "local-board";
      await tx
        .update(deliveryWorkflows)
        .set({ stages: fresh.stages, updatedAt: new Date() })
        .where(eq(deliveryWorkflows.id, f.id));
      await workflowAudit(
        tx as unknown as Db,
        f.companyId,
        stage.startApprovedBy,
        "delivery.stage.start_confirmed",
        f.id,
        { taskId: stage.taskId, inputDigest: stage.inputDigest },
      );
    });
    res.json({ received: true });
  });
  router.post(base + "/:workflowId/retry", async (req, res) => {
    const f = await record(req);
    board(req, true);
    const parsed = z
      .object({ taskId: uuid.optional() })
      .strict()
      .safeParse(req.body);
    if (!parsed.success) throw badRequest("阶段编号无效");
    const input = parsed.data;
    const { randomUUID } = await import("node:crypto");
    await db.transaction(async (tx) => {
      const [fresh] = await tx
        .select()
        .from(deliveryWorkflows)
        .where(eq(deliveryWorkflows.id, f.id))
        .for("update");
      const s = fresh.stages.find((s) =>
        input.taskId ? s.taskId === input.taskId : s.state !== "done",
      );
      if (
        fresh.state !== "active" ||
        !s ||
        s.stage === "analysis" ||
        s.state !== "interrupted"
      )
        throw conflict("仅中断阶段可恢复；分析任务请在分析页面恢复");
      if ((s.resumeCount ?? 0) >= DELIVERY_STAGE_MAX_RESUMES)
        throw conflict("本阶段已达到三次恢复上限，请人工排查并重新规划交付");
      const [permit] = s.runId
        ? await tx
            .select()
            .from(seatExecutionPermits)
            .where(eq(seatExecutionPermits.runId, s.runId))
        : [];
      if (s.runId && !permit?.treeStopVerifiedAt)
        throw conflict("请先核验本机旧进程树已停止");
      await workflowAudit(
        tx as unknown as Db,
        f.companyId,
        req.actor.userId ?? "local-board",
        "delivery.stage.retry",
        f.id,
        {
          taskId: s.taskId,
          oldRunId: s.runId,
          oldDispatchId: s.dispatchId,
          resumeCount: (s.resumeCount ?? 0) + 1,
        },
      );
      s.resumeCount = (s.resumeCount ?? 0) + 1;
      s.receipt = null;
      s.receiptDigest = null;
      s.review = null;
      s.dispatchId = randomUUID();
      s.runId = null;
      delete s.question;
      delete s.waitingSince;
      s.state = "pending";
      s.message = null;
      await tx
        .update(deliveryWorkflows)
        .set({ stages: fresh.stages, message: null, updatedAt: new Date() })
        .where(eq(deliveryWorkflows.id, f.id));
    });
    res.json({ received: true });
  });
  async function device(req: Request, store: Db = db) {
    if (
      req.actor.type !== "agent" ||
      req.actor.source !== "agent_key" ||
      req.actor.agentId !== String(req.params.id) ||
      (req.actor.keyScope && req.actor.keyScope.kind !== "standard")
    )
      throw forbidden("需要本席位独立凭证");
    assertCompanyAccess(req, req.actor.companyId!);
    const p = z
      .object({
        seat_id: uuid,
        machine_id: uuid,
        machine_fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
        lease: uuid,
      })
      .safeParse(req.body);
    if (!p.success || !uuid.safeParse(req.params.runId).success)
      throw forbidden("设备身份无效");
    const s = await assertDeliveryRun(
      store,
      req.actor.companyId!,
      req.actor.agentId!,
      String(req.params.runId),
    );
    const seat = s.agent.adapterConfig.dsp7Seat as Record<string, unknown>;
    if (
      p.data.seat_id !== s.agent.id ||
      p.data.machine_id !== seat.machineId ||
      p.data.machine_fingerprint !== seat.machineFingerprint
    )
      throw forbidden("设备绑定不匹配");
    const [permit] = await store
      .select()
      .from(seatExecutionPermits)
      .where(
        and(
          eq(seatExecutionPermits.companyId, s.flow.companyId),
          eq(seatExecutionPermits.runId, s.run.id),
          eq(
            seatExecutionPermits.leaseHash,
            createHash("sha256").update(p.data.lease).digest("hex"),
          ),
        ),
      );
    if (
      !permit ||
      permit.revokedAt ||
      permit.expiresAt.getTime() <= Date.now() ||
      s.run.status !== "running"
    )
      throw conflict("交付执行许可已失效");
    return s;
  }
  function liveStage(
    flow: typeof deliveryWorkflows.$inferSelect,
    scope: Awaited<ReturnType<typeof assertDeliveryRun>>,
  ) {
    const current = flow.stages.find(
      (x) =>
        x.taskId === scope.stage.taskId &&
        x.dispatchId === scope.stage.dispatchId &&
        x.runId === scope.run.id,
    );
    if (flow.state !== "active" || !current)
      throw conflict("交付流程已停止或运行授权已变化");
    return current;
  }
  const cb = "/agents/:id/delivery-runs/:runId";
  router.post(cb + "/context", async (req, res) => {
    const s = await device(req);
    const ancestors = deliveryAncestors(s.flow.stages, s.stage.taskId);
    const analysisStage = s.flow.stages.find((x) => x.stage === "analysis");
    const [analysis] = analysisStage
      ? await db
          .select()
          .from(analysisExecutions)
          .where(
            and(
              eq(analysisExecutions.id, analysisStage!.taskId),
              eq(analysisExecutions.companyId, s.flow.companyId),
            ),
          )
      : [];
    res.json({
      analysis: analysis
        ? { publication: analysis.publication, delivery: analysis.delivery }
        : null,
      workflowId: s.flow.id,
      demandNo: s.flow.demandNo,
      stage: s.stage,
      delegatedReviewKeys: s.flow.stages.filter(node=>node.reviewWorkKeys?.includes(s.stage.jiraKey??"" )).map(node=>node.jiraKey),
      environmentReference: s.flow.config.environmentReference,
      upstream: s.flow.stages
        .filter((s) => s.state === "done" && ancestors.has(s.taskId))
        .map((s) => ({
          stage: s.stage,
          receipt: s.receipt,
          receiptDigest: s.receiptDigest,
          jiraKey:s.jiraKey,
          executionMode:s.executionMode,
          manualDelivery:s.manualDelivery,
          review: s.review,
        })),
      snapshotId: s.flow.snapshotId,
    });
  });
  router.post(cb + "/question", async (req, res) => {
    const p = z
      .object({
        text: z.string().trim().min(1).max(4000),
        digest: z.string().regex(/^[a-f0-9]{64}$/),
      })
      .safeParse(req.body);
    if (!p.success || containsCredential(p.data.text))
      throw badRequest("问题内容无效或包含凭据");
    let answer: string | null = null;
    await db.transaction(async (tx) => {
      const scope = await device(req, tx as unknown as Db);
      const [f] = await tx
        .select()
        .from(deliveryWorkflows)
        .where(eq(deliveryWorkflows.id, scope.flow.id))
        .for("update");
      const s = liveStage(f, scope);
      if (s.receipt) throw conflict("交付已冻结");
      if (
        s.question?.digest !== p.data.digest ||
        s.question.text !== p.data.text
      ) {
        s.question = { ...p.data, answer: null, by: null, at: null };
        s.waitingSince = new Date().toISOString();
        await tx.insert(activityLog).values({
          companyId: f.companyId,
          actorType: "agent",
          actorId: scope.agent.id,
          agentId: scope.agent.id,
          action: "delivery.question.created",
          entityType: "delivery_workflow",
          entityId: f.id,
          details: { taskId: s.taskId, runId: s.runId, ...p.data },
        });
      }
      if (!s.waitingSince) s.waitingSince = new Date().toISOString();
      answer = s.question.answer;
      s.state = "waiting";
      s.message = "等待席位负责人决定：" + p.data.text;
      await tx
        .update(deliveryWorkflows)
        .set({ stages: f.stages, message: s.message, updatedAt: new Date() })
        .where(eq(deliveryWorkflows.id, f.id));
    });
    res.json({ answer });
  });
  router.post(cb + "/observe", async (req, res) => {
    const s = await device(req);
    const p = z
      .object({ message: z.string().max(2000), waiting: z.boolean() })
      .strict()
      .safeParse(req.body.observation);
    if (!p.success || containsCredential(JSON.stringify(p.data)))
      throw badRequest("阶段观察无效");
    await db.transaction(async (tx) => {
      const [f] = await tx
        .select()
        .from(deliveryWorkflows)
        .where(eq(deliveryWorkflows.id, s.flow.id))
        .for("update");
      const current = liveStage(f, s);
      if (current.receipt) return;
      current.state = p.data.waiting ? "waiting" : "running";
      current.message = p.data.message;
      await tx
        .update(deliveryWorkflows)
        .set({
          stages: f.stages,
          message: p.data.message,
          updatedAt: new Date(),
        })
        .where(eq(deliveryWorkflows.id, f.id));
    });
    res.json({ received: true });
  });
  router.post(cb + "/delivery", async (req, res) => {
    const p = deliveryStageReceiptSchema.safeParse(req.body.receipt);
    if (!p.success || containsCredential(JSON.stringify(p.data)))
      throw badRequest("交付回执无效或包含凭据");
    await db.transaction(async (tx) => {
      const s = await device(req, tx as unknown as Db);
      const [f] = await tx
        .select()
        .from(deliveryWorkflows)
        .where(eq(deliveryWorkflows.id, s.flow.id))
        .for("update");
      const current = liveStage(f, s);
      current.runId = s.run.id;
      validateStageReceipt(current, p.data);
      const digest = deliveryDigest(p.data);
      if (current.receiptDigest && current.receiptDigest !== digest)
        throw conflict("该运行的交付版本已冻结");
      if (!current.receipt) current.waitingSince = new Date().toISOString();
      current.receipt = p.data;
      current.receiptDigest = digest;
      current.waitingSince ??= new Date().toISOString();
      current.state = "review";
      current.message = null;
      await tx
        .update(deliveryWorkflows)
        .set({
          stages: f.stages,
          message: "交付回执已采集，等待核验与退出",
          updatedAt: new Date(),
        })
        .where(eq(deliveryWorkflows.id, f.id));
      await tx
        .update(issues)
        .set({ status: "in_review", updatedAt: new Date() })
        .where(eq(issues.id, current.taskId));
    });
    res.json({ received: true });
  });
  return router;
}
