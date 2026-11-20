// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter, useLocation } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { Workbench } from "./Workbench";
import { workbenchTab } from "@/lib/workbench";

const state = vi.hoisted(() => ({ canManage: false, complete: true, error: false, crumbs: vi.fn(), refresh: vi.fn() }));
vi.mock("@/lib/router", async () => import("react-router-dom"));
vi.mock("@/context/CompanyContext", () => ({ useCompany: () => ({ selectedCompanyId: "company" }) }));
vi.mock("@/context/BreadcrumbContext", () => ({ useBreadcrumbs: () => ({ setBreadcrumbs: state.crumbs }) }));
vi.mock("@/api/projects", () => ({ projectsApi: { list: async () => [] } }));
vi.mock("@/hooks/useWorkbench", async () => {
  const { useSearchParams } = await import("react-router-dom");
  return { useWorkbench: () => {
    const [params] = useSearchParams();
    const tab = workbenchTab(params, state.canManage);
    return { tab, scope: tab === "organization" ? "company" : "mine", complete: state.complete, isError: state.error,
      refresh: state.refresh, access: { canManage: state.canManage }, rows: [], seats: { data: [] }, userNames: new Map([["user", "李巍"]]),
      actions: [{ id: "q", kind: "question", title: "确认业务规则", reason: "Q1 当前业务规则是什么？", ownerUserId: "user", href: "/issues/task", taskId: "task", actionLabel: "回答业务问题", createdAt: "2026-11-12" },
        { id: "review", kind: "review", title: "TWGF-00919 分析", reason: "请评审当前分析结果", ownerUserId: "user", href: "/issues/task", taskId: "task", actionLabel: "评审分析结果", createdAt: "2026-11-12" }],
    };
  } };
});
vi.mock("@/components/ManagementWorkItem", () => ({ ManagementWorkItem: () => null }));
vi.mock("./Inbox", () => ({ Inbox: () => <p>历史通知记录</p> }));
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
let cleanup: () => Promise<void>;
beforeEach(() => { state.canManage = false; state.complete = true; state.error = false; state.refresh.mockClear(); });
afterEach(async () => { await cleanup?.(); });
function Location() { const location = useLocation(); return <output>{location.search}</output>; }
async function mount(query = "") {
  const node = document.createElement("div"); document.body.append(node);
  const root = createRoot(node), cache = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  cleanup = async () => { await act(async () => root.unmount()); cache.clear(); node.remove(); };
  await act(async () => { root.render(<QueryClientProvider client={cache}><MemoryRouter initialEntries={["/dashboard" + query]}><Workbench /><Location /></MemoryRouter></QueryClientProvider>); });
  return node;
}
it("defaults to personal actions with the same total in the tab and list", async () => {
  const node = await mount();
  expect(node.querySelector("h1")?.textContent).toBe("工作台");
  expect(node.querySelector('[aria-label="工作台视图"] button[aria-pressed="true"]')?.textContent).toBe("待我处理 · 2");
  expect(node.querySelector('[aria-label="待我处理清单"] h2')?.textContent).toBe("待我处理 · 2 项");
  expect(node.querySelectorAll("article")).toHaveLength(2);
  expect(node.querySelector('a[href="/issues/task"]')).not.toBeNull();
  expect(node.textContent).not.toContain("组织概览");
  expect(node.textContent).toContain("处理负责人：李巍");
});
it("filters action cards without changing the total or task identities", async () => {
  const node = await mount("?action=review&projectId=p");
  expect(node.querySelectorAll("article")).toHaveLength(1);
  expect(node.querySelector("article")?.textContent).toContain("评审分析结果");
  expect(node.querySelector("h2")?.textContent).toContain("2 项");
  expect(node.querySelector('a[href*="/issues?"]')?.getAttribute("href")).toContain("projectId=p");
});
it("shows administrator organization view separately and preserves project on tab changes", async () => {
  state.canManage = true;
  const node = await mount("?projectId=p");
  const organization = [...node.querySelectorAll("button")].find(button => button.textContent === "组织概览")!;
  await act(async () => organization.click());
  expect(node.querySelector("output")?.textContent).toContain("tab=organization");
  expect(node.querySelector("output")?.textContent).toContain("scope=company");
  expect(node.querySelector("output")?.textContent).toContain("projectId=p");
  expect(node.textContent).toContain("组织待办不等于你的个人待办");
});
it("falls back to personal view for a member opening an organization bookmark", async () => {
  const node = await mount("?tab=organization&scope=company");
  expect(node.querySelector('[aria-label="待我处理清单"]')).not.toBeNull();
  expect(node.querySelector('[aria-label="组织待处理清单"]')).toBeNull();
});
it("labels partial counts and surfaces refresh failures", async () => {
  state.complete = false; state.error = true;
  const node = await mount();
  expect(node.querySelector('[role="alert"]')?.textContent).toContain("清单不完整");
  expect(node.querySelector('[aria-label="工作台视图"] button')?.textContent).toContain("≥2");
  await act(async () => [...node.querySelectorAll("button")].find(button => button.textContent === "刷新")!.click());
  expect(state.refresh).toHaveBeenCalledOnce();
});
it("keeps notification read/archive history separate from current action counts", async () => {
  const node = await mount("?tab=notifications&legacyTab=unread");
  expect(node.textContent).toContain("历史通知记录");
  expect(node.textContent).toContain("不代表任务完成");
  expect(node.querySelector('[aria-label="待我处理清单"]')).toBeNull();
});
