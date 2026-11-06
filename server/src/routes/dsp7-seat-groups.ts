import { Router } from "express";
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { activityLog, type Db } from "@paperclipai/db";
import { seatNotificationGroupSchema } from "@paperclipai/shared";
import { assertBoard, assertCompanyAccess } from "./authz.js";
import { isSeatManager } from "./dsp7-seat-owners.js";
import { badRequest, forbidden, notFound } from "../errors.js";
import { secretService } from "../services/secrets.js";
import { seatNotificationGroups } from "../services/seat-group-notifications.js";
import { seatNotificationBots } from "./dsp7-seat-bots.js";

export function seatGroupRoutes(db: Db) {
  const router = Router();
  router.get("/companies/:companyId/dsp7-notification-groups", async (req, res) => {
    assertBoard(req); const companyId = String(req.params.companyId); assertCompanyAccess(req, companyId);
    res.json((await seatNotificationGroups(db, companyId)).map(({ secretId, ...group }) => ({ ...group, secretConfigured: Boolean(secretId) })));
  });
  for (const path of ["/companies/:companyId/dsp7-notification-groups", "/companies/:companyId/dsp7-notification-groups/:groupId"]) router.post(path, async (req, res) => {
    assertBoard(req); const companyId = String(req.params.companyId); assertCompanyAccess(req, companyId);
    if (!isSeatManager(req, companyId)) throw forbidden("登记通知群需要组织管理员权限");
    const parsed = seatNotificationGroupSchema.safeParse(req.body);
    if (!parsed.success) throw badRequest("通知群配置无效，请核对名称、企业机器人、Webhook 和加签密钥");
    const id = req.params.groupId ? String(req.params.groupId) : randomUUID();
    const result = await db.transaction(async tx => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${companyId + ":notification-bots"},0))`);
      const old = (await seatNotificationGroups(tx, companyId)).find(group => group.id === id);
      if (req.params.groupId && !old) throw notFound("通知群不存在");
      const { credentials, ...fields } = parsed.data;
      const bot = (await seatNotificationBots(tx, companyId)).find(bot => bot.id === fields.botId);
      if (!bot || (fields.enabled && !bot.enabled)) throw badRequest("请选择本组织已登记且启用的企业机器人");
      if (old && old.botId !== fields.botId) throw badRequest("通知群所属企业机器人不能更换，请新增通知群");
      if (old && fields.enabled && old.corpId !== bot.corpId) throw badRequest("所属机器人的企业身份已变化，请核对目标群并新增通知群");
      let secretId = old?.secretId;
      const service = secretService(tx);
      if (credentials) {
        const value = JSON.stringify(credentials);
        if (secretId) await service.rotate(secretId, { value }, { userId: req.actor.userId });
        else secretId = (await service.create(companyId, { name: "钉钉通知群 " + id, provider: "local_encrypted", value }, { userId: req.actor.userId })).id;
      }
      if (!secretId) throw badRequest("新增通知群需要 Webhook 和加签密钥");
      const corpId = old?.corpId ?? bot.corpId;
      const group = { id, ...fields, corpId, secretId };
      await tx.insert(activityLog).values({ companyId, actorType: "user", actorId: req.actor.userId ?? "local-board", action: "dsp7.notification.group.saved", entityType: "dsp7_notification_group", entityId: id, details: group });
      return { id, ...fields, corpId, secretConfigured: true };
    });
    res.json(result);
  });
  return router;
}
