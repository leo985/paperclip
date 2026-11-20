import { afterEach, expect, it, vi } from "vitest";
import type { Db } from "@paperclipai/db";
import type { DeliveryPlan } from "@paperclipai/shared";
import { readDeliveryJiraReviewResults } from "./delivery-jira-review-results.js";

const credentials = vi.hoisted(() => vi.fn(async (_db: Db, _companyId: string, _projectId: string) => ({ origin: "https://jira.example", token: "fixture" })));
vi.mock("./delivery-seat-assignment.js", () => ({ deliveryJiraCredentials: credentials }));
afterEach(() => { vi.unstubAllGlobals(); credentials.mockClear(); });

const db = {} as Db;
const review = { key: "JIRA-1", parentKey: "JIRA-10", title: "评审", type: "代码评审", status: "已完成", assignee: "", scheduled: false };
const plan: DeliveryPlan = {
  demandId: "1", demandNo: "DEMAND-1", title: "条目", status: "", sourceMode: "online_readonly", executionAllowed: false,
  roles: [], mains: [], items: [review, { ...review, key: "JIRA-2", type: "编码" }, { ...review, key: "JIRA-3", status: "已取消" }],
  scheduleCount: 0, differences: [], fingerprint: "",
};
const page = {
  startAt: 0, total: 1, names: { customfield_14608: "结果描述" },
  issues: [{ key: review.key, fields: { parent: { key: review.parentKey }, status: { name: review.status }, issuetype: { name: review.type }, customfield_14608: "评审未通过\n需要补充异常测试" } }],
};

it("reads only completed review children and returns the raw result even when the conclusion is negative", async () => {
  const fetcher = vi.fn(async (_url: URL) => Response.json(page));
  vi.stubGlobal("fetch", fetcher);
  const result = await readDeliveryJiraReviewResults(db, "company", "project", plan);
  expect(credentials).toHaveBeenCalledWith(db, "company", "project");
  expect(fetcher.mock.calls[0][0].searchParams.get("jql")).toBe('key in ("JIRA-1")');
  expect(result.results).toEqual([{ jiraKey: "JIRA-1", description: "评审未通过\n需要补充异常测试", url: "https://jira.example/browse/JIRA-1" }]);
});

it("excludes an issue whose parent, type or completion status changed", async () => {
  const fields = page.issues[0].fields;
  for (const changed of [{ parent: { key: "JIRA-11" } }, { status: { name: "待受理" } }, { issuetype: { name: "设计评审" } }]) {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ ...page, issues: [{ key: review.key, fields: { ...fields, ...changed } }] })));
    expect((await readDeliveryJiraReviewResults(db, "company", "project", plan)).results).toEqual([]);
  }
});

it("rejects a missing result-field identity and never queries Jira for manual snapshots", async () => {
  const fetcher = vi.fn(async () => Response.json({ ...page, names: {} }));
  vi.stubGlobal("fetch", fetcher);
  await expect(readDeliveryJiraReviewResults(db, "company", "project", plan)).rejects.toThrow(/未完整返回/);
  expect((await readDeliveryJiraReviewResults(db, "company", "project", { ...plan, sourceMode: "manual_snapshot" })).results).toEqual([]);
  expect(fetcher).toHaveBeenCalledTimes(1);
});
