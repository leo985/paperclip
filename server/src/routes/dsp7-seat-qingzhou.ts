import { Router, type Request } from "express";
import { and, eq } from "drizzle-orm";
import { activityLog, agents, seatQingzhouAccounts, type Db } from "@paperclipai/db";
import { seatQingzhouSaveSchema, seatQingzhouRevisionSchema } from "@paperclipai/shared";
import { z } from "zod";
import { assertBoard, assertCompanyAccess } from "./authz.js";
import { canConfigureSeat } from "./dsp7-seat-owners.js";
import { badRequest, conflict, forbidden, notFound } from "../errors.js";
import { secretService } from "../services/secrets.js";
import { qingzhouClient, QingzhouReadError } from "../services/qingzhou-client.js";
import { publicSeatQingzhouAccount, resolveSeatQingzhouCredentials, lockSeatQingzhouSecret, seatQingzhouLock } from "../services/seat-qingzhou.js";

export function seatQingzhouRoutes(db: Db, dependencies = { secrets: secretService, fetch: globalThis.fetch }) {
  const router = Router(), base = "/companies/:companyId/dsp7-seats/:id/qingzhou-account";
  async function access(req: Request, tx = db, lock = false) {
    assertBoard(req);
    const companyId = String(req.params.companyId), seatId = String(req.params.id);
    assertCompanyAccess(req, companyId);
    if (!z.string().uuid().safeParse(companyId).success || !z.string().uuid().safeParse(seatId).success) throw badRequest("席位标识无效");
    if (lock) await tx.execute(seatQingzhouLock(companyId, seatId));
    const query = tx.select().from(agents).where(and(eq(agents.companyId, companyId), eq(agents.id, seatId)));
    const [seat] = await (lock ? query.for("update") : query);
    if (!seat?.adapterConfig.dsp7Seat) throw notFound("席位不存在");
    if (!canConfigureSeat(req, companyId, seat.adapterConfig.dsp7Seat as Record<string, unknown>)) throw forbidden("仅席位负责人或管理员可以配置轻舟账号");
    return { companyId, seatId };
  }
  async function current(tx: Db, companyId: string, seatId: string) {
    const [row] = await tx.select().from(seatQingzhouAccounts).where(and(eq(seatQingzhouAccounts.companyId, companyId), eq(seatQingzhouAccounts.seatId, seatId)));
    return row;
  }
  async function audit(tx: Db, req: Request, companyId: string, seatId: string, action: string, revision: number, status?: string) {
    await tx.insert(activityLog).values({ companyId, agentId: seatId, actorType: "user", actorId: req.actor.userId ?? "local-board", action,
      entityType: "agent", entityId: seatId, details: { revision, ...(status ? { status } : {}) } });
  }
  router.get(base, async (req, res) => {
    const { companyId, seatId } = await access(req);
    res.setHeader("Cache-Control", "no-store");
    res.json(publicSeatQingzhouAccount(seatId, await current(db, companyId, seatId)));
  });
  router.put(base, async (req, res) => {
    await access(req);
    const parsed = seatQingzhouSaveSchema.safeParse(req.body);
    if (!parsed.success) throw badRequest("请填写有效的轻舟账号、密码和配置版本");
    const result = await db.transaction(async transaction => {
      const tx = transaction as unknown as Db, { companyId, seatId } = await access(req, tx, true);
      const old = await current(tx, companyId, seatId), input = parsed.data;
      if ((old?.revision ?? 0) !== input.expectedRevision) throw conflict("轻舟账号配置已变化，请刷新后重试");
      if (!input.password && (!old?.credentialSecretId || old.username !== input.username)) throw badRequest("首次配置或更换轻舟账号时必须填写密码");
      let secretId = old?.credentialSecretId;
      if (secretId) {
        const secret = await lockSeatQingzhouSecret(tx, companyId, secretId, false);
        if (secret.deletedAt || secret.status !== "active") {
          if (!input.password) throw badRequest("已保存的轻舟凭据已失效，请重新填写密码");
          secretId = null;
        }
      }
      const secrets = dependencies.secrets(tx);
      if (input.password) {
        const value = JSON.stringify({ username: input.username, password: input.password });
        if (secretId) await secrets.rotate(secretId, { value }, { userId: req.actor.userId });
        else secretId = (await secrets.create(companyId, { name: "席位轻舟账号 " + seatId, provider: "local_encrypted", value }, { userId: req.actor.userId })).id;
      }
      const fields = { username: input.username, credentialSecretId: secretId!, revision: (old?.revision ?? 0) + 1, lastCheckStatus: "not_checked", lastCheckedAt: null, updatedAt: new Date() };
      const [row] = old
        ? await tx.update(seatQingzhouAccounts).set(fields).where(eq(seatQingzhouAccounts.id, old.id)).returning()
        : await tx.insert(seatQingzhouAccounts).values({ companyId, seatId, ...fields }).returning();
      await audit(tx, req, companyId, seatId, "dsp7.seat.qingzhou.saved", row.revision);
      return publicSeatQingzhouAccount(seatId, row);
    });
    res.json(result);
  });
  router.post(base + "/check", async (req, res) => {
    await access(req);
    const parsed = seatQingzhouRevisionSchema.safeParse(req.body);
    if (!parsed.success) throw badRequest("账号配置版本无效");
    const result = await db.transaction(async transaction => {
      const tx = transaction as unknown as Db, { companyId, seatId } = await access(req, tx, true);
      const old = await current(tx, companyId, seatId);
      if (!old?.credentialSecretId) throw badRequest("请先保存席位的轻舟账号");
      if (old.revision !== parsed.data.expectedRevision) throw conflict("轻舟账号配置已变化，请刷新后重试");
      let error: string | undefined;
      try {
        await qingzhouClient({ fetch: dependencies.fetch, credentials: () => resolveSeatQingzhouCredentials(tx, companyId, old, dependencies.secrets) }).verifyAuthentication();
      } catch (caught) {
        error = caught instanceof QingzhouReadError ? caught.message : "轻舟连接检查失败，请稍后重试";
      }
      const [row] = await tx.update(seatQingzhouAccounts).set({ lastCheckStatus: error ? "failed" : "valid", lastCheckedAt: new Date() }).where(eq(seatQingzhouAccounts.id, old.id)).returning();
      await audit(tx, req, companyId, seatId, "dsp7.seat.qingzhou.checked", row.revision, row.lastCheckStatus);
      return { ...publicSeatQingzhouAccount(seatId, row), ...(error ? { error } : {}) };
    });
    res.json(result);
  });
  router.delete(base, async (req, res) => {
    await access(req);
    const parsed = seatQingzhouRevisionSchema.safeParse(req.body);
    if (!parsed.success) throw badRequest("账号配置版本无效");
    const result = await db.transaction(async transaction => {
      const tx = transaction as unknown as Db, { companyId, seatId } = await access(req, tx, true);
      const old = await current(tx, companyId, seatId);
      if ((old?.revision ?? 0) !== parsed.data.expectedRevision) throw conflict("轻舟账号配置已变化，请刷新后重试");
      if (!old?.credentialSecretId) return publicSeatQingzhouAccount(seatId, old);
      await lockSeatQingzhouSecret(tx, companyId, old.credentialSecretId, false);
      const [row] = await tx.update(seatQingzhouAccounts).set({ username: null, credentialSecretId: null, revision: old.revision + 1, lastCheckStatus: "not_checked", lastCheckedAt: null, updatedAt: new Date() }).where(eq(seatQingzhouAccounts.id, old.id)).returning();
      await dependencies.secrets(tx).remove(old.credentialSecretId);
      await audit(tx, req, companyId, seatId, "dsp7.seat.qingzhou.removed", row.revision);
      return publicSeatQingzhouAccount(seatId, row);
    });
    res.json(result);
  });
  return router;
}
