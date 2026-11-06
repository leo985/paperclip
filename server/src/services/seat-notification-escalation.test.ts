import { afterEach, describe, expect, it, vi } from "vitest";
import { isCurrentSeatWait, seatNotificationAttempts, sendSeatDing } from "./seat-notification-escalation.js";

const policy = { reminderMinutes: 10, escalationMinutes: 30 };
const target = { botId: "bot", userId: "owner" };
const alert = { id: "run:native:question:tool-1", taskId: "task", elapsedMinutes: 29 };
afterEach(() => vi.unstubAllGlobals());
describe("seat DING escalation", () => {
  it("fans out to a group without changing existing personal deduplication keys", () => {
    const personal = seatNotificationAttempts("seat", target, policy, alert);
    const both = seatNotificationAttempts("seat", { ...target, groupId: "group-a" }, policy, alert);
    expect(both.map(a => a.channel)).toEqual(["message", "group"]);
    expect(both[0]).toEqual(personal[0]);
    expect(both[1].key).not.toBe(seatNotificationAttempts("seat", { ...target, groupId: "group-b" }, policy, alert)[1].key);
    expect(both[1].key).toBe(seatNotificationAttempts("seat", { ...target, userId: "another-dm-recipient", groupId: "group-a" }, policy, alert)[1].key);
  });
  it("keeps ordinary reminders below the threshold and prioritizes DING at it", () => {
    expect(seatNotificationAttempts("seat", target, policy, alert).map(a => a.channel)).toEqual(["message"]);
    expect(seatNotificationAttempts("seat", target, policy, { ...alert, elapsedMinutes: 30 }).map(a => a.channel)).toEqual(["ding", "message"]);
  });
  it("reserves only one DING for the same waiting episode across reminder buckets", () => {
    const first = seatNotificationAttempts("seat", target, policy, { ...alert, elapsedMinutes: 30 });
    const later = seatNotificationAttempts("seat", target, policy, { ...alert, elapsedMinutes: 90 });
    expect(first[0].key).toBe(later[0].key);expect(first[1].key).not.toBe(later[1].key);
    expect(first[0].key).not.toBe(seatNotificationAttempts("seat", target, policy, { ...alert, id: "new-wait", elapsedMinutes: 30 })[0].key);
  });
  it("separates recipients and seats so a different seat cannot claim another DING", () => {
    const a = { ...alert, elapsedMinutes: 30 };
    const key = seatNotificationAttempts("seat", target, policy, a)[0].key;
    expect(key).not.toBe(seatNotificationAttempts("other-seat", target, policy, a)[0].key);
    expect(key).not.toBe(seatNotificationAttempts("seat", { ...target, userId: "other-owner" }, policy, a)[0].key);
  });
  it("requires fresh presence and the same still-pending task and waiting episode", () => {
    const now = Date.now(), waiting = { ...alert, elapsedMinutes: 30 };
    const presence = { lastSeenAt: new Date(now).toISOString(), alerts: [waiting] };
    expect(isCurrentSeatWait(presence, waiting, 30, now)).toBe(true);
    expect(isCurrentSeatWait({ ...presence, alerts: [] }, waiting, 30, now)).toBe(false);
    expect(isCurrentSeatWait(presence, { ...waiting, taskId: "other" }, 30, now)).toBe(false);
    expect(isCurrentSeatWait(presence, { ...waiting, id: "old" }, 30, now)).toBe(false);
    expect(isCurrentSeatWait({ ...presence, lastSeenAt: new Date(now - 90000).toISOString() }, waiting, 30, now)).toBe(false);
  });
  it("uses the configured enterprise robot and only the application DING channel", async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify({ openDingId: "ding-receipt" }), { status: 200 }));
    vi.stubGlobal("fetch", fetcher);
    expect(await sendSeatDing("private-token", "configured-robot", "owner", "pending task")).toEqual({ status: "submitted", code: "DING_ACCEPTED_NOT_HANDLED", openDingId: "ding-receipt" });
    expect(fetcher.mock.calls[0][0]).toBe("https://api.dingtalk.com/v1.0/robot/ding/send");
    expect(JSON.parse(fetcher.mock.calls[0][1].body)).toEqual({ robotCode: "configured-robot", receiverUserIdList: ["owner"], content: "pending task", remindType: 1 });
  });
  it("requires a real DING receipt and never silently falls back to a different sender", async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response("{}", { status: 200 }));vi.stubGlobal("fetch", fetcher);
    expect((await sendSeatDing("token", "robot", "owner", "pending")).status).toBe("unknown");
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it("records missing DING permission and does not call a personal-account API", async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify({ code: "Forbidden.AccessDenied" }), { status: 403 }));vi.stubGlobal("fetch", fetcher);
    expect(await sendSeatDing("token", "robot", "owner", "pending")).toEqual({ status: "failed", code: "DING_Forbidden.AccessDenied" });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it("does not retry when the provider outcome is unknown", async () => {
    const fetcher = vi.fn().mockRejectedValue(new Error("timeout"));vi.stubGlobal("fetch", fetcher);
    expect((await sendSeatDing("token", "robot", "owner", "pending")).status).toBe("unknown");
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});
