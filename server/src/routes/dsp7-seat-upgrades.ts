import { Router, type Request } from "express";
import { and, eq, inArray, sql } from "drizzle-orm";
import { activityLog, agents, heartbeatRuns, type Db } from "@paperclipai/db";
import { seatUpgradeRequestSchema, seatUpgradeResultSchema, type SeatUpgradeRequest } from "@paperclipai/shared";
import { badRequest, conflict, forbidden } from "../errors.js";
import { publishedSeatDigest } from "../services/seat-client-release.js";
import { isSeatManager, isSeatManagerUser } from "./dsp7-seat-owners.js";

type Seat = typeof agents.$inferSelect;
const pending = ["queued", "claimed", "verifying"];
export function seatUpgradeState(agent: Pick<Seat, "adapterConfig">, now = Date.now()): SeatUpgradeRequest | null {
  const request = agent.adapterConfig.dsp7SeatUpgrade as SeatUpgradeRequest | undefined;
  if (!request) return null;
  if (pending.includes(request.status) && Date.parse(request.expiresAt) <= now) return { ...request, status: "expired", message: "升级请求已过期，请管理员重新下发" };
  const presence = agent.adapterConfig.dsp7SeatPresence as { bridgeVersion?: string; lastSeenAt?: string } | undefined;
  const seen = Date.parse(presence?.lastSeenAt ?? "");
  if (pending.includes(request.status) && presence?.bridgeVersion === request.targetSha256 && seen >= Date.parse(request.requestedAt) && now - seen < 90000 && seen <= now + 5000) {
    return { ...request, status: "succeeded", message: "服务器已收到目标版本的新心跳" };
  }
  return request;
}

export function seatUpgradeRoutes(db: Db, own: (req: Request) => Promise<Seat>, board: (req: Request) => Promise<Seat>) {
  const router = Router();
  async function locked(tx: Db, agent: Seat) {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${agent.id + ":seat-upgrade"},0))`);
    const [fresh] = await tx.select().from(agents).where(and(eq(agents.id, agent.id), eq(agents.companyId, agent.companyId))).for("update");
    return fresh;
  }
  async function save(tx: Db, agent: Seat, request: SeatUpgradeRequest, actorType: "user" | "agent", actorId: string, action: string) {
    const value = { ...request, updatedAt: new Date().toISOString() };
    await tx.update(agents).set({ adapterConfig: { ...agent.adapterConfig, dsp7SeatUpgrade: value }, updatedAt: new Date() }).where(and(eq(agents.id, agent.id), eq(agents.companyId, agent.companyId)));
    await tx.insert(activityLog).values({ companyId: agent.companyId, agentId: agent.id, actorType, actorId, action, entityType: "dsp7_seat_upgrade", entityId: value.requestId, details: { targetSha256: value.targetSha256, status: value.status } });
    return value;
  }
  router.get("/companies/:companyId/dsp7-seats/:id/client-upgrade", async (req, res) => res.json(seatUpgradeState(await board(req))));
  router.post("/companies/:companyId/dsp7-seats/:id/client-upgrade", async (req, res) => {
    const agent = await board(req);
    if (!isSeatManager(req, agent.companyId)) throw forbidden("只有管理员可以下发客户端升级");
    const parsed = seatUpgradeRequestSchema.safeParse(req.body); if (!parsed.success) throw badRequest("升级请求无效");
    if (parsed.data.targetSha256 !== await publishedSeatDigest()) throw conflict("网站发布版本已变化，请刷新后重新选择");
    const result = await db.transaction(async transaction => {
      const tx = transaction as unknown as Db; const fresh = await locked(tx, agent);
      const presence = fresh.adapterConfig.dsp7SeatPresence as { capabilities?: string[]; bridgeVersion?: string } | undefined;
      if (!presence?.capabilities?.includes("seat-admin-upgrade-v1")) throw conflict("此客户端尚不支持网页升级，请先在本机升级一次");
      if (["terminated", "pending_approval"].includes(fresh.status)) throw conflict("席位当前状态不能升级");
      const previous = seatUpgradeState(fresh); const actorId = req.actor.userId ?? "local-board";
      if (previous?.requestId === parsed.data.requestId) {
        if (previous.targetSha256 !== parsed.data.targetSha256 || previous.requestedBy !== actorId) throw conflict("请求编号已用于其他操作");
        return previous;
      }
      if (previous && pending.includes(previous.status)) throw conflict("已有升级请求等待处理，请先查看或取消");
      if (presence?.bridgeVersion === parsed.data.targetSha256) throw conflict("席位已经是目标版本");
      const now = new Date().toISOString();
      return save(tx, fresh, { ...parsed.data, requestedBy: actorId, requestedAt: now, updatedAt: now, expiresAt: new Date(Date.now() + 86400000).toISOString(), status: "queued", message: "管理员已下发，等待电脑连接并空闲后升级" }, "user", actorId, "dsp7.seat.upgrade.requested");
    }); res.json(result);
  });
  router.post("/companies/:companyId/dsp7-seats/:id/client-upgrade/cancel", async (req, res) => {
    const agent = await board(req); if (!isSeatManager(req, agent.companyId)) throw forbidden("只有管理员可以取消升级");
    const parsed = seatUpgradeRequestSchema.safeParse(req.body); if (!parsed.success) throw badRequest("升级请求无效");
    res.json(await db.transaction(async transaction => {
      const tx = transaction as unknown as Db; const fresh = await locked(tx, agent); const request = seatUpgradeState(fresh);
      if (!request || request.requestId !== parsed.data.requestId || request.targetSha256 !== parsed.data.targetSha256 || request.status !== "queued") throw conflict("请求已领取或结束，不能取消正在进行的升级");
      return save(tx, fresh, { ...request, status: "cancelled", message: "管理员已取消升级" }, "user", req.actor.userId ?? "local-board", "dsp7.seat.upgrade.cancelled");
    }));
  });
  router.post("/agents/:id/dsp7-seat-upgrade/poll", async (req, res) => {
    const agent = await own(req); res.json({ request: seatUpgradeState(agent) });
  });
  router.post("/agents/:id/dsp7-seat-upgrade/claim", async (req, res) => {
    const agent = await own(req); const parsed = seatUpgradeRequestSchema.safeParse({ requestId: req.body.requestId, targetSha256: req.body.targetSha256 });
    if (!parsed.success) throw badRequest("升级请求无效");
    const digest = await publishedSeatDigest();
    res.json(await db.transaction(async transaction => {
      const tx = transaction as unknown as Db; const fresh = await locked(tx, agent); const request = seatUpgradeState(fresh);
      if (!request || request.requestId !== parsed.data.requestId || request.targetSha256 !== parsed.data.targetSha256 || request.status !== "queued") throw conflict("升级请求已变化或过期");
      if (request.targetSha256 !== digest) throw conflict("目标发布已变化，请管理员重新下发升级");
      if (request.requestedBy !== "local-board" && !await isSeatManagerUser(tx, fresh.companyId, request.requestedBy)) throw forbidden("下发者已失去管理员权限，请重新下发");
      const [run] = await tx.select({ id: heartbeatRuns.id }).from(heartbeatRuns).where(and(eq(heartbeatRuns.agentId, fresh.id), eq(heartbeatRuns.companyId, fresh.companyId), inArray(heartbeatRuns.status, ["queued", "running", "scheduled_retry"])));
      const presence = fresh.adapterConfig.dsp7SeatPresence as { state?: string; activeTaskId?: string } | undefined;
      if (run || presence?.activeTaskId || ["busy", "waiting_decision", "awaiting_local"].includes(presence?.state ?? "")) throw conflict("席位仍有活动任务，升级继续等待");
      return save(tx, fresh, { ...request, status: "claimed", message: "本机已领取，正在核验空闲并升级" }, "agent", fresh.id, "dsp7.seat.upgrade.claimed");
    }));
  });
  router.post("/agents/:id/dsp7-seat-upgrade/result", async (req, res) => {
    const agent = await own(req); const parsed = seatUpgradeResultSchema.safeParse({ requestId: req.body.requestId, targetSha256: req.body.targetSha256, status: req.body.status });
    if (!parsed.success) throw badRequest("升级回执无效");
    res.json(await db.transaction(async transaction => {
      const tx = transaction as unknown as Db; const fresh = await locked(tx, agent); const request = seatUpgradeState(fresh);
      if (!request || request.requestId !== parsed.data.requestId || request.targetSha256 !== parsed.data.targetSha256) throw conflict("升级请求已变化");
      if (request.status === "succeeded") return request;
      if (!["claimed", "verifying"].includes(request.status)) throw conflict("升级请求未领取或已结束");
      const next = parsed.data.status === "installed" ? { status: "verifying" as const, message: "本机安装完成，等待目标版本的新心跳" } : parsed.data.status === "deferred" ? { status: "queued" as const, message: "本机仍忙碌，待空闲后重试管理员请求" } : { status: "failed" as const, message: "本机升级失败，请查看原电脑日志后由管理员重试" };
      return save(tx, fresh, { ...request, ...next }, "agent", fresh.id, "dsp7.seat.upgrade.result");
    }));
  });
  return router;
}
