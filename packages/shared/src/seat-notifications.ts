import { z } from "zod";

export const seatDingtalkTargetSchema = z.object({
  userId: z.string().regex(/^[A-Za-z0-9_-]{1,100}$/),
  botId: z.string().uuid().optional(),
  profile: z.string().regex(/^[A-Za-z0-9_-]+:[A-Za-z0-9_-]+$/).max(200).optional(),
  groupId: z.string().uuid().optional(),
}).strict().refine(v => Boolean(v.botId) || Boolean(v.profile))
  .refine(v => !v.groupId || Boolean(v.botId));
export type SeatDingtalkTarget = z.infer<typeof seatDingtalkTargetSchema>;
export interface SeatNotificationGroup {
  id: string; name: string; botId: string; corpId: string; enabled: boolean; secretConfigured: boolean;
}

// A group webhook is a credential. Never accept an arbitrary network destination.
export const seatGroupCredentialsSchema = z.object({
  webhookUrl: z.string().url().max(1000).refine(value => {
    try {
    const url = new URL(value);
    return url.origin === "https://oapi.dingtalk.com" && url.pathname === "/robot/send"
      && !url.username && !url.password && !url.hash
      && [...url.searchParams.keys()].length === 1
      && /^[A-Za-z0-9_-]{1,256}$/.test(url.searchParams.get("access_token") ?? "");
    } catch { return false; }
  }, "请填写钉钉群机器人的有效 HTTPS Webhook"),
  signingSecret: z.string().regex(/^SEC[A-Za-z0-9]{16,200}$/),
}).strict();
export const seatNotificationGroupSchema = z.object({
  name: z.string().trim().min(1).max(100),
  botId: z.string().uuid(),
  enabled: z.boolean(),
  credentials: seatGroupCredentialsSchema.optional(),
}).strict();
