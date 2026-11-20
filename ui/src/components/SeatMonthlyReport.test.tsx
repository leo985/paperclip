// @vitest-environment jsdom
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import type { DashboardIssue } from "@/lib/delivery-dashboard";
import { SeatMonthlyReport } from "./SeatMonthlyReport";

const fixture = vi.hoisted(() => ({ issues: [] as DashboardIssue[] }));
vi.mock("@tanstack/react-query", () => ({
  useQuery: () => ({ data: { issues: fixture.issues, seats: [], asOf: "2026-11-19T00:00:00Z" } }),
}));
vi.mock("@/lib/router", () => ({
  Link: ({ to, children, ...props }: React.PropsWithChildren<{ to: string }>) => <a href={to} {...props}>{children}</a>,
  useSearchParams: () => [new URLSearchParams("month=2026-11"), vi.fn()],
}));

let cleanup: (() => void) | undefined;
afterEach(() => cleanup?.());

it("shows only parent groups by default and expands filtered children within their group", () => {
  fixture.issues = Array.from({ length: 42 }, (_, i) => ({
    id: String(i), key: `CHILD-${String(i).padStart(2, "0")}`, title: `子单 ${i}`,
    parentKey: `MAIN-${i < 22 ? "00" : String(i - 21).padStart(2, "0")}`,
    projectId: "project", projectName: "项目", snapshotId: "snapshot", demandNo: "DEMAND",
    issueType: "编码", status: i === 0 ? "已完成" : "待受理", seatIds: [],
    dueDate: "2026-11-19", deadlineSource: "child", collectedAt: "2026-11-19T00:00:00Z",
    risk: i === 0 ? "done" : "on_track", completed: i === 0, inMonth: true,
  }));
  const node = document.createElement("div");
  const root = createRoot(node);
  flushSync(() => root.render(<SeatMonthlyReport companyId="company" />));
  cleanup = () => flushSync(() => root.unmount());
  const table = node.querySelector("table")!;
  expect(table.querySelectorAll("tbody")).toHaveLength(20);
  expect(table.querySelectorAll('th[scope="row"]')).toHaveLength(0);
  const main = [...table.querySelectorAll("tbody")].find(group => group.textContent?.includes("MAIN-00"))!;
  const toggle = main.querySelector("button")!;
  expect(toggle.getAttribute("aria-expanded")).toBe("false");
  expect(main.textContent).toContain("当前筛选 22 个子工单");
  flushSync(() => toggle.click());
  expect(toggle.getAttribute("aria-expanded")).toBe("true");
  expect(main.querySelectorAll('th[scope="row"]')).toHaveLength(22);
  expect(table.querySelectorAll('th[scope="row"]')).toHaveLength(22);
  flushSync(() => toggle.click());
  expect(table.querySelectorAll('th[scope="row"]')).toHaveLength(0);
  const bulkToggle = [...node.querySelectorAll("button")].find(button => button.textContent === "全部展开")!;
  flushSync(() => bulkToggle.click());
  expect(bulkToggle.textContent).toBe("全部收起");
  expect(table.querySelectorAll('th[scope="row"]')).toHaveLength(41);
  const next = [...node.querySelectorAll("button")].find(button => button.textContent === "下一页")!;
  flushSync(() => next.click());
  expect(table.querySelectorAll("tbody")).toHaveLength(1);
  expect(table.textContent).toContain("MAIN-20");
  expect(table.textContent).not.toContain("MAIN-00");
  expect(table.querySelectorAll('th[scope="row"]')).toHaveLength(1);
  flushSync(() => bulkToggle.click());
  expect(bulkToggle.textContent).toBe("全部展开");
  expect(table.querySelectorAll('th[scope="row"]')).toHaveLength(0);
  flushSync(() => bulkToggle.click());
  const filter = node.querySelector<HTMLSelectElement>('[aria-label="工单风险筛选"]')!;
  flushSync(() => { filter.value = "done"; filter.dispatchEvent(new Event("change", { bubbles: true })); });
  expect(table.querySelectorAll("tbody")).toHaveLength(1);
  expect(table.querySelectorAll('th[scope="row"]')).toHaveLength(0);
  expect(table.textContent).toContain("当前筛选 1 个子工单");
  flushSync(() => table.querySelector("button")!.click());
  expect(table.querySelectorAll('th[scope="row"]')).toHaveLength(1);
  expect(table.textContent).toContain("CHILD-00");
  expect(node.textContent).not.toContain("下一页");
});
