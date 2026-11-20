// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Routes, Route, useLocation } from "react-router-dom";
import { afterEach, expect, it, vi } from "vitest";
import type { Issue } from "@paperclipai/shared";
import { issuesApi } from "@/api/issues";
import { authApi } from "@/api/auth";
import { getRecentTasksStorageKey, readRecentTasks } from "@/lib/recent-tasks";
import { UnifiedTaskDetailPage } from "./UnifiedTaskDetailPage";
vi.mock("@/lib/router", async () => await import("react-router-dom"));
vi.mock("@/hooks/useStreamlinedUiEnabled", () => ({
  useStreamlinedUiEnabled: () => ({ enabled: true, loaded: true }),
}));
const company = vi.hoisted(() => ({ selectedCompanyId: "company" }));
vi.mock("@/context/CompanyContext", () => ({ useCompany: () => company }));
vi.mock("@/context/BreadcrumbContext", () => ({
  useBreadcrumbs: () => ({ setBreadcrumbs: () => {} }),
}));
vi.mock("@/components/task-detail/TaskExecutionDetail", () => ({
  TaskExecutionDetail: () => (
    <div>
      统一详情内容<a href="#task-detail-overview">概况</a>
    </div>
  ),
}));
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
let cleanup: (() => Promise<void>) | undefined;
afterEach(async () => {
  await cleanup?.();
  cleanup = undefined;
  vi.restoreAllMocks();
  company.selectedCompanyId = "company";
  localStorage.clear();
});
async function mount(search = "", override = {}) {
  vi.spyOn(authApi, "getSession").mockResolvedValue(null);
  vi.spyOn(issuesApi, "markRead").mockResolvedValue({
    id: "task",
    lastReadAt: new Date(),
  });
  vi.spyOn(issuesApi, "get").mockResolvedValue({
    id: "task",
    companyId: "company",
    identifier: "DSP-1",
    title: "任务标题",
    status: "blocked",
    updatedAt: new Date("2026-11-11T01:00:00Z"),
    ...override,
  } as Issue);
  const node = document.createElement("div");
  document.body.append(node);
  const root = createRoot(node);
  const cache = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  function Location() {
    const location = useLocation();
    return (
      <output>{location.pathname + location.search + location.hash}</output>
    );
  }
  await act(async () =>
    root.render(
      <QueryClientProvider client={cache}>
        <MemoryRouter
          initialEntries={[
            {
              pathname: "/issues/DSP-1",
              search: search.split("#")[0],
              hash: search.includes("#") ? "#" + search.split("#")[1] : "",
              state: {
                issueDetailBreadcrumb: {
                  label: "需求分析",
                  href: "/analysis-executions?projectId=p&page=2&snapshotId=s",
                },
              },
            },
          ]}
        >
          <Routes>
            <Route
              path="/issues/:issueId"
              element={
                <>
                  <Location />
                  <UnifiedTaskDetailPage
                    collaboration={<p>完整原有对话、附件、属性与高级操作</p>}
                  />
                </>
              }
            />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    ),
  );
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
  cleanup = async () => {
    await act(async () => root.unmount());
    cache.clear();
    node.remove();
  };
  return node;
}
it("defaults to unified details, retains return context, and opens original capabilities on the same task", async () => {
  const node = await mount();
  expect(node.textContent).toContain("统一详情内容");
  expect(issuesApi.markRead).toHaveBeenCalledWith("task");
  expect(
    readRecentTasks(getRecentTasksStorageKey("company", null), "company")[0]
      ?.id,
  ).toBe("task");
  expect(node.textContent).not.toContain("完整原有对话");
  expect(
    node.querySelector(
      'a[href="/analysis-executions?projectId=p&page=2&snapshotId=s"]',
    ),
  ).not.toBeNull();
  const original = [...node.querySelectorAll("a")].find(
    (a) => a.textContent === "对话、文件与高级操作",
  )!;
  await act(async () => original.click());
  expect(node.textContent).toContain("完整原有对话、附件、属性与高级操作");
  expect(node.querySelector("output")?.textContent).toBe(
    "/issues/DSP-1?detailView=collaboration",
  );
  await act(async () =>
    [...node.querySelectorAll("a")]
      .find((a) => a.textContent === "任务详情")!
      .click(),
  );
  expect(node.textContent).toContain("统一详情内容");
});
it("preserves historical comment and file deep links", async () => {
  const node = await mount("?tab=activity#comment-123");
  expect(node.textContent).toContain("完整原有对话");
  expect(node.textContent).not.toContain("统一详情内容");
  expect(issuesApi.markRead).not.toHaveBeenCalled();
});
it("does not mistake a shared detail section anchor for a historic deep link", async () => {
  const node = await mount("#task-detail-overview");
  expect(node.textContent).toContain("统一详情内容");
  expect(node.textContent).not.toContain("完整原有对话");
});
it("does not show task controls for another selected organization", async () => {
  const node = await mount("", { companyId: "other-company" });
  expect(node.querySelector('[role="alert"]')?.textContent).toContain(
    "不属于所选组织",
  );
  expect(node.textContent).not.toContain("统一详情内容");
});
