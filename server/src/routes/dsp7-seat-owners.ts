import { Router, type Request } from "express";
import { and, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import { activityLog, agentApiKeys, agents, authUsers, companyMemberships, heartbeatRuns, instanceUserRoles, type Db } from "@paperclipai/db";
import { z } from "zod";
import { assertBoard, assertCompanyAccess } from "./authz.js";
import { badRequest, conflict, forbidden, notFound } from "../errors.js";
import { agentService } from "../services/agents.js";

export function isSeatManager(req: Request, companyId: string) {
  return req.actor.type === "board" && (req.actor.isInstanceAdmin || req.actor.source === "local_implicit" || Boolean(req.actor.memberships?.some(m => m.companyId === companyId && m.status === "active" && ["owner", "admin"].includes(m.membershipRole ?? ""))));
}
/** Recheck persisted human roles when a machine consumes a dispatch grant. */
export async function isSeatManagerUser(db: Db, companyId: string, userId: string | null | undefined) {
  if (!userId) return false;
  const [instanceRole] = await db.select({ id: instanceUserRoles.id }).from(instanceUserRoles).where(and(eq(instanceUserRoles.userId, userId), eq(instanceUserRoles.role, "instance_admin"))).limit(1);
  if (instanceRole) return true;
  const [membership] = await db.select({ id: companyMemberships.id }).from(companyMemberships).where(and(eq(companyMemberships.companyId, companyId), eq(companyMemberships.principalType, "user"), eq(companyMemberships.principalId, userId), eq(companyMemberships.status, "active"), inArray(companyMemberships.membershipRole, ["owner", "admin"]))).limit(1);
  return Boolean(membership);
}
export async function canCreateSeatIntake(db: Db, agent: typeof agents.$inferSelect, userId: string | null | undefined) {
  if (!userId) return false;
  const seat = agent.adapterConfig.dsp7Seat as { intakeUserIds?: string[] } | undefined;
  return Boolean(seat?.intakeUserIds?.includes(userId)) || await isSeatManagerUser(db, agent.companyId, userId);
}
export function seatOwnerId(seat: Record<string, unknown> | undefined): string | null {
  return typeof seat?.ownerUserId === "string" ? seat.ownerUserId : Array.isArray(seat?.intakeUserIds) && typeof seat.intakeUserIds[0] === "string" ? seat.intakeUserIds[0] : null;
}
export function canConfigureSeat(req: Request, companyId: string, seat: Record<string, unknown> | undefined) {
  return isSeatManager(req, companyId) || Boolean(req.actor.type === "board" && req.actor.userId && req.actor.userId === seatOwnerId(seat));
}
export async function requireSeatOwner(db: Db, companyId: string, userId: string) {
  const [member] = await db.select({ id: authUsers.id, name: authUsers.name, email: authUsers.email }).from(companyMemberships).innerJoin(authUsers, eq(authUsers.id, companyMemberships.principalId)).where(and(eq(companyMemberships.companyId, companyId), eq(companyMemberships.principalType, "user"), eq(companyMemberships.principalId, userId), eq(companyMemberships.status, "active"), inArray(companyMemberships.membershipRole, ["owner", "admin", "operator", "member"])));
  if (!member) throw badRequest("请选择本组织已激活的研发成员或管理员；观察成员不能负责席位");
  return member;
}
export function dsp7SeatOwnerRoutes(db: Db) {
  const router = Router();
  router.delete("/companies/:companyId/dsp7-seats/:id", async (req, res) => {
    const companyId=String(req.params.companyId);assertBoard(req);assertCompanyAccess(req,companyId);
    if(!isSeatManager(req,companyId)) throw forbidden("只有管理员可以删除席位");
    await db.transaction(async tx=>{
      const agent=await agentService(tx as unknown as Db).remove(String(req.params.id),companyId);
      if(!agent) throw notFound("席位不存在");
      await tx.insert(activityLog).values({companyId,actorType:"user",actorId:req.actor.userId??"local-board",action:"dsp7.seat.deleted",entityType:"agent",entityId:agent.id,details:{name:agent.name}});
    });
    res.json({ok:true});
  });
  router.get("/companies/:companyId/dsp7-seat-owner-candidates", async (req, res) => {
    const companyId = String(req.params.companyId); assertBoard(req); assertCompanyAccess(req, companyId);
    if (!isSeatManager(req, companyId)) throw forbidden("指定席位负责人需要管理员权限");
    const rows = await db.select({ id: authUsers.id, name: authUsers.name, email: authUsers.email }).from(companyMemberships).innerJoin(authUsers, eq(authUsers.id, companyMemberships.principalId)).where(and(eq(companyMemberships.companyId, companyId), eq(companyMemberships.principalType, "user"), eq(companyMemberships.status, "active"), inArray(companyMemberships.membershipRole, ["owner", "admin", "operator", "member"])));
    res.json(rows);
  });
  router.patch("/companies/:companyId/dsp7-seats/:id/owner", async (req, res) => {
    const companyId = String(req.params.companyId); assertBoard(req); assertCompanyAccess(req, companyId);
    if (!isSeatManager(req, companyId)) throw forbidden("只有管理员可以指定或更换席位负责人");
    const parsed = z.object({ userId: z.string().trim().min(1).max(200) }).strict().safeParse(req.body);
    if (!parsed.success) throw badRequest("请选择席位负责人");
    const result = await db.transaction(async tx => {
      const owner = await requireSeatOwner(tx as unknown as Db, companyId, parsed.data.userId);
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${String(req.params.id)+":seat-commands"},0))`);
      const [agent] = await tx.select().from(agents).where(and(eq(agents.companyId, companyId), eq(agents.id, String(req.params.id)))).for("update");
      const seat = agent?.adapterConfig.dsp7Seat as Record<string, unknown> | undefined;
      if (!agent || !seat || agent.adapterConfig.dsp7WebJiraIntake !== true) throw notFound("席位不存在");
      const previousOwnerUserId = seatOwnerId(seat);
      const changed = previousOwnerUserId !== owner.id;
      if (changed) {
        const [run] = await tx.select({ id: heartbeatRuns.id }).from(heartbeatRuns).where(and(eq(heartbeatRuns.agentId, agent.id), inArray(heartbeatRuns.status, ["queued", "running", "scheduled_retry"])));
        const presence = agent.adapterConfig.dsp7SeatPresence as { state?: string; activeTaskId?: string } | undefined;
        if (run || presence?.activeTaskId || ["busy", "waiting_decision", "awaiting_local"].includes(presence?.state ?? "")) throw conflict("席位有执行中或待决策任务，请结束当前任务后再更换负责人");
      }
      if (changed) {
        const events = await tx.select().from(activityLog).where(and(eq(activityLog.companyId, companyId), eq(activityLog.agentId, agent.id), eq(activityLog.entityType, "dsp7_seat_command"))).orderBy(desc(activityLog.createdAt)).limit(500);
        for (const request of events.filter(e=>e.action==="dsp7.seat.command.requested")) {
          const details=request.details!; const latest=events.filter(e=>e.action==="dsp7.seat.command.result"&&e.details?.commandId===details.commandId).sort((a,b)=>Number(b.details?.sequence??0)-Number(a.details?.sequence??0))[0]?.details;
          const status=String(latest?.status??"queued");
          if (["queued","awaiting_local","accepted"].includes(status) && Date.parse(String(details.expiresAt)) <= Date.now()) continue;
          if (status==="running" && typeof latest?.runId==="string") { const [run]=await tx.select({status:heartbeatRuns.status}).from(heartbeatRuns).where(and(eq(heartbeatRuns.id,latest.runId),eq(heartbeatRuns.agentId,agent.id))); if(run && !["queued","running","scheduled_retry"].includes(run.status)) continue; }
          if (["accepted","running"].includes(status)) throw conflict("本机正在处理请求，请等待请求结束后更换负责人");
          if (["queued","awaiting_local"].includes(status)) await tx.insert(activityLog).values({companyId,agentId:agent.id,actorType:"user",actorId:req.actor.userId??"local-board",action:"dsp7.seat.command.result",entityType:"dsp7_seat_command",entityId:String(details.commandId),details:{commandId:details.commandId,status:"cancelled",message:"管理员更换席位负责人，取消旧请求",sequence:Number(latest?.sequence??0)+1}});
        }
      }
      const config: Record<string, unknown> = { ...agent.adapterConfig, dsp7Seat: { ...seat, ownerUserId: owner.id, intakeUserIds: [owner.id], ownerAssignedBy: req.actor.userId ?? "local-board" } };
      if (changed) {
        const rule = config.dsp7JiraDispatch as Record<string, unknown> | undefined;
        if (rule) { const { jiraSecretId: _secret, ...safe } = rule; config.dsp7JiraDispatch = { ...safe, enabled: false, intakePaused: true, ownerUserId: owner.id, revision: Number(rule.revision ?? 0) + 1 }; }
        config.dsp7SeatPolicy = { mode: "manual", jiraKeys: [], reminderMinutes: 10, escalationMinutes: 30, dingtalk: null };
      }
      await tx.update(agents).set({ adapterConfig: config, updatedAt: new Date() }).where(eq(agents.id, agent.id));
      await tx.update(agentApiKeys).set({ responsibleUserId: owner.id }).where(and(eq(agentApiKeys.agentId, agent.id), eq(agentApiKeys.companyId, companyId), isNull(agentApiKeys.revokedAt), inArray(agentApiKeys.name, ["DSP7 machine seat", "DSP7 outbound personal seat"])));
      await tx.insert(activityLog).values({ companyId, agentId: agent.id, actorType: "user", actorId: req.actor.userId ?? "local-board", action: "dsp7.seat.owner.assigned", entityType: "agent", entityId: agent.id, details: { previousOwnerUserId, ownerUserId: owner.id, dispatchReset: changed } });
      return { agentId: agent.id, owner, dispatchReset: changed };
    }); res.json(result);
  });
  return router;
}
