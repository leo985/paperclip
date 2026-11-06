import { Router } from "express";
import { and, eq, inArray } from "drizzle-orm";
import { activityLog, companyMemberships, issues, managementFollowUps, type Db } from "@paperclipai/db";
import { managementFollowUpSchema } from "@paperclipai/shared";
import { z } from "zod";
import { assertBoard, assertCompanyAccess } from "./authz.js";
import { isSeatManager } from "./dsp7-seat-owners.js";
import { badRequest, conflict, forbidden, notFound } from "../errors.js";
import { authorizationService } from "../services/authorization.js";

export function managementFollowUpRoutes(db: Db) {
  const router = Router();
  const base = "/companies/:companyId/management-follow-ups";
  const present = (row: typeof managementFollowUps.$inferSelect) => ({ ...row, remindAt: row.remindAt?.toISOString() ?? null, updatedAt: row.updatedAt.toISOString() });
  router.get(base, async (req, res) => {
    const c = String(req.params.companyId);
    assertBoard(req);
    if (!z.string().uuid().safeParse(c).success) throw badRequest("无效的组织编号");
    assertCompanyAccess(req, c);
    const ids = z.array(z.string().uuid()).max(100).safeParse(String(req.query.issueIds ?? "").split(",").filter(Boolean));
    if (!ids.success) throw badRequest("最多查询 100 个有效工单编号");
    if (!ids.data.length) return res.json([]);
    const rows = await db.select({ followUp: managementFollowUps, source: issues }).from(managementFollowUps)
      .innerJoin(issues, and(eq(issues.id, managementFollowUps.issueId), eq(issues.companyId, managementFollowUps.companyId)))
      .where(and(eq(managementFollowUps.companyId, c), inArray(managementFollowUps.issueId, ids.data)));
    const allowed = [];
    for (const { followUp, source } of rows) {
      const decision = await authorizationService(db).decide({ actor: req.actor, action: "issue:read", resource: { type: "issue", companyId: c, issueId: followUp.issueId, status: source.status, assigneeAgentId: source.assigneeAgentId, assigneeUserId: source.assigneeUserId, projectId: source.projectId } });
      if (decision.allowed) allowed.push(present(followUp));
    }
    res.json(allowed);
  });
  router.put(base + "/:issueId", async (req, res) => {
    const c = String(req.params.companyId), issueId = String(req.params.issueId);
    assertBoard(req);
    if (!z.string().uuid().safeParse(c).success) throw badRequest("无效的组织编号");
    assertCompanyAccess(req, c);
    if (!z.string().uuid().safeParse(issueId).success) throw badRequest("无效的工单编号");
    const parsed = managementFollowUpSchema.safeParse(req.body);
    if (!parsed.success) throw badRequest("跟进人或提醒时间无效");
    const input = parsed.data, actor = req.actor.userId ?? (req.actor.source === "local_implicit" ? "local-board" : null);
    if (!actor) throw forbidden("需要已登录的人员身份");
    if (input.remindAt && (Date.parse(input.remindAt) <= Date.now() || Date.parse(input.remindAt) > Date.now() + 366 * 86_400_000)) throw badRequest("提醒时间须在未来一年内");
    const result = await db.transaction(async tx => {
      const store = tx as unknown as Db;
      const [issue] = await tx.select().from(issues).where(and(eq(issues.id, issueId), eq(issues.companyId, c))).for("update");
      if (!issue) throw notFound("工单不存在");
      const decision = await authorizationService(store).decide({ actor: req.actor, action: "issue:mutate", resource: { type: "issue", companyId: c, issueId, status: issue.status, assigneeAgentId: issue.assigneeAgentId, assigneeUserId: issue.assigneeUserId, projectId: issue.projectId } });
      if (!decision.allowed) throw forbidden(decision.explanation);
      const [current] = await tx.select().from(managementFollowUps).where(and(eq(managementFollowUps.companyId, c), eq(managementFollowUps.issueId, issueId)));
      if ((current?.version ?? 0) !== input.expectedVersion) throw conflict("跟进记录已被更新，请刷新后重试");
      const manager = isSeatManager(req, c);
      if (!manager && current?.ownerUserId && current.ownerUserId !== actor) throw forbidden("该事项已由其他人员跟进，请管理员转交");
      if (!manager && input.ownerUserId !== undefined && input.ownerUserId !== null && input.ownerUserId !== actor) throw forbidden("仅管理员可转交给其他成员");
      const owner = input.ownerUserId === undefined ? current?.ownerUserId ?? actor : input.ownerUserId;
      if (owner && !(owner === "local-board" && req.actor.source === "local_implicit")) {
        const [member] = await tx.select({ id: companyMemberships.id }).from(companyMemberships).where(and(eq(companyMemberships.companyId, c), eq(companyMemberships.principalType, "user"), eq(companyMemberships.principalId, owner), eq(companyMemberships.status, "active"), inArray(companyMemberships.membershipRole, ["owner", "admin", "operator", "member"])));
        if (!member) throw badRequest("请选择本组织的有效成员，观察成员不能跟进");
      }
      const values = { companyId: c, issueId, ownerUserId: owner, remindAt: owner === null ? null : input.remindAt === undefined ? current?.remindAt ?? null : input.remindAt ? new Date(input.remindAt) : null, version: (current?.version ?? 0) + 1, updatedBy: actor, updatedAt: new Date() };
      const [row] = await tx.insert(managementFollowUps).values(values).onConflictDoUpdate({ target: [managementFollowUps.companyId, managementFollowUps.issueId], set: values }).returning();
      await tx.insert(activityLog).values({ companyId: c, actorType: "user", actorId: actor, action: "management.follow_up.updated", entityType: "issue", entityId: issueId, details: { before: current ? present(current) : null, after: present(row) } });
      return present(row);
    });
    res.json(result);
  });
  return router;
}
