import { afterEach, expect, it, vi } from "vitest";
import type { DeliveryPlan } from "@paperclipai/shared";
import { readAutomaticDeliverySource } from "./delivery-automatic-source.js";
vi.mock("./delivery-seat-assignment.js", () => ({
  deliveryJiraCredentials: async () => ({
    origin: "https://jira.example",
    token: "private",
  }),
}));
afterEach(() => vi.unstubAllGlobals());
const plan = {
  mains: [{ key: "MAIN-1" }],
  items: [],
} as unknown as DeliveryPlan;
const row = {
  key: "DEV-1",
  fields: {
    summary: "编码",
    parent: { key: "MAIN-1" },
    issuetype: { name: "编码" },
    status: { name: "待受理" },
    updated: "v1",
    assignee: { name: "account", displayName: "张三" },
    issuelinks: [
      { type: { name: "Blocks" }, outwardIssue: { key: "REV-9" } },
      { type: { name: "Review" }, inwardIssue: { key: "REV-1" } },
    ],
  },
};
it("reads all live children and retains only explicit review relations and exact accounts", async () => {
  const fetcher = vi.fn(async (_url: URL) =>
    Response.json({ total: 1, startAt: 0, issues: [row] }),
  );
  vi.stubGlobal("fetch", fetcher);
  const source = await readAutomaticDeliverySource(
    {} as any,
    "company",
    "project",
    plan,
  );
  expect(source.items[0]).toMatchObject({
    account: "account",
    reviewLinks: ["REV-1"],
  });
  expect(
    new URL(String(fetcher.mock.calls[0][0])).searchParams.get("jql"),
  ).toContain("parent in (MAIN-1)");
  expect(JSON.stringify(source)).not.toContain("private");
});
it.each([
  { total: 2, startAt: 0, issues: [row] },
  { total: 1, startAt: 100, issues: [row] },
  {
    total: 1,
    startAt: 0,
    issues: [
      { ...row, fields: { ...row.fields, parent: { key: "FOREIGN-1" } } },
    ],
  },
])("rejects incomplete or foreign source %j", async (page) => {
  vi.stubGlobal("fetch", async () => Response.json(page));
  await expect(
    readAutomaticDeliverySource({} as any, "c", "p", plan),
  ).rejects.toThrow();
});
it("fails without usable project main identities", async () => {
  await expect(
    readAutomaticDeliverySource({} as any, "c", "p", { ...plan, mains: [] }),
  ).rejects.toThrow("有效主工单");
});
