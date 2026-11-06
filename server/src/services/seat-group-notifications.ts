import { createHmac } from "node:crypto";
import { and, desc, eq } from "drizzle-orm";
import { activityLog, personnelPeople, personnelSources, type Db, type agents } from "@paperclipai/db";
import { seatGroupCredentialsSchema } from "@paperclipai/shared";
import { seatOwnerId } from "../routes/dsp7-seat-owners.js";
import { badRequest } from "../errors.js";

export interface StoredSeatNotificationGroup {
  id: string; name: string; botId: string; corpId: string; enabled: boolean; secretId: string;
}
export async function seatNotificationGroups(db: Pick<Db, "select">, companyId: string) {
  const rows = await db.select().from(activityLog).where(and(
    eq(activityLog.companyId, companyId), eq(activityLog.action, "dsp7.notification.group.saved"),
  )).orderBy(desc(activityLog.createdAt), desc(activityLog.id));
  const latest = new Map<string, StoredSeatNotificationGroup>();
  for (const row of rows) if (!latest.has(row.entityId)) latest.set(row.entityId, row.details as unknown as StoredSeatNotificationGroup);
  return [...latest.values()];
}
export async function resolveSeatGroupOwner(db: Pick<Db, "select">, agent: typeof agents.$inferSelect, corpId: string) {
  const userId = seatOwnerId(agent.adapterConfig.dsp7Seat as Record<string, unknown> | undefined);
  if (!userId) throw badRequest("席位缺少负责人，无法在群里 @ 负责人");
  const people = await db.select({ externalId: personnelPeople.externalId, name: personnelPeople.name })
    .from(personnelPeople).innerJoin(personnelSources, eq(personnelSources.id, personnelPeople.sourceId))
    .where(and(eq(personnelPeople.userId, userId), eq(personnelPeople.active, true),
      eq(personnelSources.type, "DingTalk"), eq(personnelSources.corpId, corpId), eq(personnelSources.enabled, true)));
  const identities = new Map(people.map(person => [person.externalId, person]));
  if (identities.size !== 1) throw badRequest("席位负责人未唯一关联该机器人企业的有效钉钉账号，请在系统人员联邦核对账号关联");
  const person = [...identities.values()][0]!;
  if (!/^[A-Za-z0-9_-]{1,100}$/.test(person.externalId)) throw badRequest("席位负责人钉钉账号无效");
  return person;
}

// Official custom-robot text contract: text.content + at.atUserIds, not a display-name @.
// Credentials are resolved only on the server, and responses never echo the webhook.
export async function sendSeatGroupMessage(credentials: unknown, owner: { externalId: string; name: string }, content: string) {
  const parsed = seatGroupCredentialsSchema.safeParse(credentials);
  if (!parsed.success) return { status: "failed", code: "GROUP_CONFIGURATION_INVALID" };
  const { webhookUrl, signingSecret } = parsed.data;
  const timestamp = Date.now().toString();
  const sign = createHmac("sha256", signingSecret).update(`${timestamp}\n${signingSecret}`).digest("base64");
  const url = new URL(webhookUrl);
  url.searchParams.set("timestamp", timestamp); url.searchParams.set("sign", sign);
  try {
    const response = await fetch(url, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ msgtype: "text", text: { content: `${content}\n@${owner.externalId}` }, at: { atUserIds: [owner.externalId], isAtAll: false } }),
      redirect: "error", signal: AbortSignal.timeout(10000),
    });
    const result = await response.json() as { errcode?: number };
    if (response.ok && result.errcode === 0) return { status: "submitted", code: "GROUP_ACCEPTED_NOT_READ" };
    if (response.status >= 500 || (response.ok && typeof result.errcode !== "number")) return { status: "unknown", code: "GROUP_RESPONSE_UNKNOWN" };
    return { status: "failed", code: response.ok ? `GROUP_ERR_${result.errcode}` : `GROUP_HTTP_${response.status}` };
  } catch { return { status: "unknown", code: "GROUP_NETWORK_OR_RESPONSE_UNKNOWN" }; }
}
