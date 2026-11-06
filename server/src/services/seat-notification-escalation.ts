import { createHash } from "node:crypto";

export type SeatNotificationChannel = "message" | "ding" | "group";
export interface WaitingAlert { id: string; taskId: string | null; elapsedMinutes: number }
export function seatNotificationAttempts(
  agentId: string,
  target: { botId?: string; userId: string; groupId?: string },
  policy: { reminderMinutes: number; escalationMinutes: number },
  alert: WaitingAlert,
) {
  const level = alert.elapsedMinutes >= policy.escalationMinutes ? "urgent" : "warning";
  const scope = [agentId, target.botId, target.userId, alert.id];
  const digest = (parts: unknown[]) => createHash("sha256").update(parts.join(":")).digest("hex");
  const attempts: Array<{ channel: SeatNotificationChannel; key: string; level: string }> = [];
  // A DING belongs to one waiting episode. It has no periodic bucket: even an
  // unknown network outcome must not result in repeated emergency messages.
  if (level === "urgent") attempts.push({ channel: "ding", key: digest([...scope, "ding"]), level });
  // Preserve the old message key, including after upgrading existing seats.
  attempts.push({ channel: "message", key: digest([...scope, level, Math.floor(alert.elapsedMinutes / policy.reminderMinutes)]), level });
  if (target.groupId) attempts.push({ channel: "group", key: digest([agentId, target.botId, target.groupId, alert.id, "group", level, Math.floor(alert.elapsedMinutes / policy.reminderMinutes)]), level });
  return attempts;
}

export function isCurrentSeatWait(presence: unknown, alert: WaitingAlert, threshold: number, now = Date.now()) {
  if (!presence || typeof presence !== "object") return false;
  const p = presence as { lastSeenAt?: string; alerts?: WaitingAlert[] };
  const seen = Date.parse(p.lastSeenAt ?? "");
  return Number.isFinite(seen) && seen <= now + 5000 && now - seen < 90000
    && Array.isArray(p.alerts) && p.alerts.some(a => a.id === alert.id && a.taskId === alert.taskId && a.elapsedMinutes >= threshold);
}

// Contract: official DingTalk RobotSendDing SDK, robot_1_0/client.go.
// remindType 1 is application-only; this path cannot send SMS or telephone DING.
export async function sendSeatDing(accessToken: string, robotCode: string, userId: string, content: string) {
  try {
    const response = await fetch("https://api.dingtalk.com/v1.0/robot/ding/send", {
      method: "POST", headers: { "Content-Type": "application/json", "x-acs-dingtalk-access-token": accessToken },
      body: JSON.stringify({ robotCode, receiverUserIdList: [userId], content, remindType: 1 }),
      redirect: "error", signal: AbortSignal.timeout(10000),
    });
    const result = await response.json() as { openDingId?: string; failedList?: Record<string, unknown>; code?: string };
    const providerCode = typeof result.code === "string" && /^[A-Za-z0-9_.-]{1,80}$/.test(result.code) ? result.code : undefined;
    if (response.ok && typeof result.openDingId === "string" && result.openDingId.trim() && !Object.keys(result.failedList ?? {}).length) {
      return { status: "submitted", code: "DING_ACCEPTED_NOT_HANDLED", openDingId: result.openDingId };
    }
    if (response.status >= 500 || (response.ok && !result.openDingId)) return { status: "unknown", code: "DING_RESPONSE_UNKNOWN" };
    return { status: "failed", code: providerCode ? "DING_" + providerCode : response.ok ? "DING_RECIPIENT_REJECTED" : "DING_HTTP_" + response.status };
  } catch {
    return { status: "unknown", code: "DING_NETWORK_OR_RESPONSE_UNKNOWN" };
  }
}
