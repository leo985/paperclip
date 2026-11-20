// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, expect, it, vi } from "vitest";
import { IssueManagement } from "./IssueManagement";
const state = vi.hoisted(() => ({ canManage: true, items: [] as unknown[], crumbs: vi.fn() }));
vi.mock("@/lib/router", async () => import("react-router-dom"));
vi.mock("@/context/CompanyContext", () => ({ useCompany: () => ({ selectedCompanyId: "company" }) }));
vi.mock("@/context/BreadcrumbContext", () => ({ useBreadcrumbs: () => ({ setBreadcrumbs: state.crumbs }) }));
vi.mock("@/context/DialogContext", () => ({ useDialogActions: () => ({ openNewIssue: vi.fn() }) }));
vi.mock("@/hooks/useManagementAccess", () => ({ useManagementAccess: () => ({ canManage: state.canManage }) }));
vi.mock("@/hooks/useManagementIssues", () => ({ useManagementIssues: () => ({ data: { pages: [state.items] }, isSuccess: true, isFetching: false, hasNextPage: false }) }));
vi.mock("@/api/auth", () => ({ authApi: { getSession: async () => ({ user: { id: "user" } }) } }));
vi.mock("@/api/projects", () => ({ projectsApi: { list: async () => [] } }));
vi.mock("@/api/dsp7-seats", () => ({ dsp7SeatsApi: { list: async () => [] } }));
vi.mock("@/api/agents", () => ({ agentsApi: { list: async () => [] } }));
vi.mock("@/api/access", () => ({ accessApi: { listUserDirectory: async () => ({ users: [] }) } }));
vi.mock("@/api/heartbeats", () => ({ heartbeatsApi: { liveRunsForCompany: async () => [] } }));
vi.mock("@/api/issues", () => ({ issuesApi: { listLabels: async () => [] } }));
vi.mock("./IssuesList", () => ({ IssuesList: () => null }));
vi.mock("./Dsp7ExecutionStatus", () => ({ Dsp7ExecutionStatus: () => null }));
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
let cleanup: () => Promise<void>;
afterEach(async () => { await cleanup?.(); localStorage.clear(); });
function task(id: string, stages: string[], status = "todo") { return { id, title: id, identifier: id, companyId: "company", projectId: null, status, priority: "medium", createdAt: "2026-11-12", updatedAt: "2026-11-12", deliveryStages: stages }; }
async function mount(query: string) {
  const node = document.createElement("div"); document.body.append(node); const root = createRoot(node);
  const cache = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  cleanup = async () => { await act(async () => root.unmount()); cache.clear(); node.remove(); };
  await act(async () => { root.render(<QueryClientProvider client={cache}><MemoryRouter initialEntries={["/issues?" + query]}><IssueManagement /></MemoryRouter></QueryClientProvider>); });
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 30)); });
  return node;
}
it("combines delivery stage and task state before counting and paginating the shared table", async () => {
  state.items = [task("design-pending", ["design"]), task("design-done", ["design"], "done"), task("coding-done", ["coding"], "done"), task("other", [])];
  const node = await mount("taskType=design&status=done");
  expect(node.querySelector("tbody")?.textContent).toContain("design-done");
  expect(node.querySelector("tbody")?.textContent).not.toContain("coding-done");
  expect(node.querySelector("tbody")?.textContent).not.toContain("design-pending");
  expect(node.querySelector("footer")?.textContent).toContain("共 1 条");
  expect(node.textContent).toContain("安排研发设计任务");
});
it("offers analysis creation and refuses to classify unavailable metadata as other", async () => {
  state.items = [task("analysis", ["analysis"])];
  const node = await mount("taskType=analysis&projectId=project");
  expect(node.querySelector('a[href*="createAnalysis=1"]')?.getAttribute("href")).toContain("projectId=project");
});
it("shows unavailable stage metadata instead of an empty/other conclusion", async () => {
  state.items = [{ ...task("unknown", []), deliveryStages: undefined }];
  const node = await mount("taskType=other");
  expect(node.querySelector('[role="alert"]')?.textContent).toContain("环节信息未完整返回");
  expect(node.querySelector("tbody")?.textContent).not.toContain("unknown");
  expect(node.textContent).not.toContain("当前条件下没有工单");
});
it("defaults members to personal tasks and ignores organization scope in a shared URL", async () => {
  state.canManage = false;
  try {
    state.items = [{ ...task("mine", []), assigneeUserId: "user" }, { ...task("another-member", []), assigneeUserId: "someone-else" }];
    const node = await mount("scope=company");
    const scope = node.querySelector('[aria-label="工单展示范围"]') as HTMLSelectElement;
    expect(scope.disabled).toBe(true); expect(scope.value).toBe("mine");
    expect(node.querySelector("tbody")?.textContent).toContain("mine");
    expect(node.querySelector("tbody")?.textContent).not.toContain("another-member");
    expect(node.textContent).toContain("你尚未绑定席位");
    expect(node.textContent).not.toContain("新建需求分析");
  } finally { state.canManage = true; }
});
it("defaults administrators to organization tasks and allows switching to personal scope", async () => {
  state.items = [{ ...task("mine", []), assigneeUserId: "user" }, { ...task("organization-task", []), assigneeUserId: "other" }];
  const node = await mount(""); const scope = node.querySelector('[aria-label="工单展示范围"]') as HTMLSelectElement;
  expect(scope.disabled).toBe(false); expect(scope.value).toBe("company"); expect(node.querySelector("tbody")?.textContent).toContain("organization-task");
  await act(async () => { scope.value = "mine"; scope.dispatchEvent(new Event("change", { bubbles: true })); });
  expect(node.querySelector("tbody")?.textContent).not.toContain("organization-task");
});
