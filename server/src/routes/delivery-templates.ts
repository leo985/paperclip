import { containsCredential } from "../services/managed-sessions.js";
import { Router } from "express";
import { z } from "zod";
import { sql } from "drizzle-orm";
import {
  activityLog,
  agents,
  deliveryWorkflowTemplates,
  type Db,
} from "@paperclipai/db";
import { and, eq } from "drizzle-orm";
import { publishDeliveryTemplateSchema } from "@paperclipai/shared";
import { assertBoard, assertCompanyAccess } from "./authz.js";
import { isSeatManager } from "./dsp7-seat-owners.js";
import { badRequest, conflict, forbidden } from "../errors.js";
import {
  assertTemplateReviewer,
  deliveryTemplateSettings,
  publicDeliveryTemplate,
} from "../services/delivery-templates.js";
export function deliveryTemplateRoutes(db: Db) {
  const router = Router(),
    base = "/companies/:companyId/delivery-templates";
  router.use(base, (req, _res, next) => {
    assertBoard(req);
    assertCompanyAccess(req, String(req.params.companyId));
    next();
  });
  router.get(base, async (req, res) => {
    const query = z
      .object({ projectId: z.string().uuid().optional() })
      .safeParse(req.query);
    if (!query.success) throw badRequest("项目参数无效");
    res.setHeader("Cache-Control", "no-store");
    res.json(
      await deliveryTemplateSettings(
        db,
        String(req.params.companyId),
        query.data.projectId,
      ),
    );
  });
  router.post(base, async (req, res) => {
    const c = String(req.params.companyId);
    if (!isSeatManager(req, c))
      throw forbidden("只有组织管理员可以发布交付流程模板");
    const parsed = publishDeliveryTemplateSchema.safeParse(req.body);
    if (!parsed.success)
      throw badRequest(parsed.error.issues.map((x) => x.message).join("；"));
    const input = parsed.data;
    if(containsCredential(JSON.stringify(input.definition))) throw badRequest("流程配置不能包含凭据");
    if (!input.projectId && input.definition.inheritOrganization)
      throw badRequest("组织模板不能继承自身");
    const result = await db.transaction(async (tx) => {
      const store = tx as unknown as Db;
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtextextended(${c + ":delivery-template:" + (input.projectId ?? "organization")},0))`,
      );
      const current = await deliveryTemplateSettings(store, c, input.projectId);
      if ((current.own?.revision ?? 0) !== input.expectedRevision)
        throw conflict("流程模板已被其他人修改，请刷新后重新发布");
      for (const value of input.definition.inheritOrganization
        ? []
        : Object.values(input.definition.stages)) {
        for (const userId of [value.workExecutorUserId,value.reviewExecutorUserId].filter(Boolean)) await assertTemplateReviewer(store,c,userId!);
      if (value.review === "specified_user")
          await assertTemplateReviewer(store, c, value.reviewerUserId!);
        for (const seatId of [value.seatId,value.reviewSeatId].filter(Boolean)) {
          const [seat] = await tx
            .select({ id: agents.id })
            .from(agents)
            .where(and(eq(agents.companyId, c), eq(agents.id, seatId!)));
          if (!seat) throw forbidden("模板默认席位不属于当前组织");
        }
      }
      if (!input.definition.inheritOrganization && input.definition.automaticRepair) {
        for (const route of input.definition.automaticRepair.routes) for (const seatId of [route.developmentSeatId,route.reviewSeatId,route.qaSeatId]) {
          const [seat]=await tx.select({id:agents.id}).from(agents).where(and(eq(agents.companyId,c),eq(agents.id,seatId)));
          if (!seat) throw forbidden("自动修复路由席位不属于当前组织");
        }
      }
      const [row] = await tx
        .insert(deliveryWorkflowTemplates)
        .values({
          companyId: c,
          projectId: input.projectId ?? null,
          scopeKey: input.projectId ?? "organization",
          revision: input.expectedRevision + 1,
          definition: input.definition,
          createdBy: req.actor.userId ?? "local-board",
        })
        .returning();
      await tx
        .insert(activityLog)
        .values({
          companyId: c,
          actorType: "user",
          actorId: req.actor.userId ?? "local-board",
          action: "delivery.template.published",
          entityType: "delivery_workflow_template",
          entityId: row.id,
          details: {
            projectId: input.projectId ?? null,
            revision: row.revision,
            previousRevision: input.expectedRevision,
            definition: input.definition,
          },
        });
      return publicDeliveryTemplate(row);
    });
    res.status(201).json(result);
  });
  return router;
}
