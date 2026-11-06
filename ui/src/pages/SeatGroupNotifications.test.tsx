import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { describe, expect, it } from "vitest";
import type { RegisteredSeat } from "@/api/dsp7-seats";
import { SeatPolicyEditor } from "./Seats";

function render(ownerIds = ["ding-seat-owner"]) {
  const cache = new QueryClient();
  const seat = { agentId: "seat", owner: { id: "platform-owner" }, policy: {
    mode: "manual", jiraKeys: [], reminderMinutes: 10, escalationMinutes: 30,
    dingtalk: { botId: "bot", userId: "personal-recipient", groupId: "group" },
  } } as unknown as RegisteredSeat;
  cache.setQueryData(["dsp7-notification-bots", "company"], [{ id: "bot", name: "企业机器人", corpId: "corp", enabled: true }]);
  cache.setQueryData(["dsp7-notification-groups", "company"], [
    { id: "group", name: "研发通知群", botId: "bot", corpId: "corp", enabled: true },
    { id: "wrong-corp", name: "其他企业群", botId: "bot", corpId: "other-corp", enabled: true },
  ]);
  cache.setQueryData(["dsp7-seat-contacts", "company", "seat"], [
    { externalId: "personal-recipient", name: "个人接收人", userId: "another-user", corpId: "corp", departments: [], organization: "公司" },
    ...ownerIds.map(externalId => ({ externalId, name: "席位负责人", userId: "platform-owner", corpId: "corp", departments: [], organization: "公司" })),
  ]);
  cache.setQueryData(["dsp7-notification-deliveries", "company", "seat"], [
    { channel: "group", status: "submitted", createdAt: "2026-11-04T03:00:00Z", groupName: "研发通知群", mentionedUserId: "ding-seat-owner" },
  ]);
  return renderToStaticMarkup(<QueryClientProvider client={cache}><SeatPolicyEditor companyId="company" seat={seat} section="notifications" /></QueryClientProvider>);
}
describe("seat notification group settings", () => {
  it("shows the actual seat owner for group mentions independently of the DM recipient", () => {
    const html = render();
    expect(html).toContain("群内将 @ 席位负责人：席位负责人（ding-seat-owner）");
    expect(html).toContain("研发通知群");
    expect(html).not.toContain("其他企业群");
    expect(html).toContain("群消息 · 研发通知群 · @ding-seat-owner");
    expect(html).toContain("个人提醒保留");
  });
  it.each([{ ids: [] }, { ids: ["first-account", "second-account"] }])("explains missing or ambiguous owner mapping", ({ ids }) => {
    expect(render(ids)).toContain("无法唯一匹配席位负责人的钉钉账号");
  });
});
