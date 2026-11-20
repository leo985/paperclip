// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { afterEach, expect, it, vi } from "vitest";
import { analysisApi, type AnalysisDetail } from "@/api/analysis-executions";
import { projectsApi } from "@/api/projects";
import { AnalysisExecutions, AnalysisExecutionsRedirect } from "./AnalysisExecutions";
vi.mock("@/lib/router", async () => await import("react-router-dom"));
vi.mock("@/context/CompanyContext", () => ({
  useCompany: () => ({ selectedCompanyId: "company" }),
}));
vi.mock("@/context/BreadcrumbContext", () => ({
  useBreadcrumbs: () => ({ setBreadcrumbs: () => {} }),
}));
vi.mock("@/hooks/useManagementAccess", () => ({
  useManagementAccess: () => ({ canManage: true }),
}));
vi.mock("@/components/HarnessEnrollmentGuide", () => ({
  HarnessEnrollmentGuide: () => null,
}));
vi.mock("@/components/AnalysisQingzhouWriteback", () => ({
  AnalysisQingzhouOptionsFields: () => null,
}));
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
let cleanup: (() => Promise<void>) | undefined;
afterEach(async () => {
  await cleanup?.();
  cleanup = undefined;
  vi.restoreAllMocks();
});
const execution = {
  id: "analysis-id",
  companyId: "company",
  projectId: "project",
  seatId: "seat",
  title: "原分析",
  brief: "原始业务诉求与材料位置",
  demandNo: "TWGF-00919",
  revision: 1,
  state: "local_completed",
  delivery: { inputDigest: "digest" },
} as AnalysisDetail["execution"];
async function mount(search: string, legacyRedirect = false, createOnly = false) {
  vi.spyOn(projectsApi, "list").mockResolvedValue([
    { id: "project", name: "项目" },
  ] as never);
  vi.spyOn(analysisApi, "seats").mockResolvedValue([
    {
      id: "seat",
      name: "本机",
      capabilityId: "cap",
      clientReady: true,
      online: true,
    },
  ] as never);
  vi.spyOn(analysisApi, "list").mockResolvedValue({
    items: [execution],
    hasMore: false,
  });
  vi.spyOn(analysisApi, "detail").mockResolvedValue({
    execution,
    decisions: [],
    run: null,
  });
  const node = document.createElement("div");
  document.body.append(node);
  const root = createRoot(node);
  const cache = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  function Destination() {
    const location = useLocation();
    return (
      <>
        <output>{location.pathname}</output>
        <pre>{JSON.stringify(location.state)}</pre>
      </>
    );
  }
  await act(async () =>
    root.render(
      <QueryClientProvider client={cache}>
        <MemoryRouter initialEntries={["/analysis-executions" + search]}>
          <Routes>
            <Route
              path="/analysis-executions"
              element={legacyRedirect ? <AnalysisExecutionsRedirect /> : <AnalysisExecutions createOnly={createOnly} />}
            />
            <Route path="/issues" element={<AnalysisExecutions createOnly={createOnly} />} />
            <Route path="/issues/:issueId" element={<Destination />} />
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
it("redirects an old analysis URL to the task while preserving project, page and demand context", async () => {
  const node = await mount(
    "?projectId=project&page=3&snapshotId=snapshot&executionId=analysis-id",
  );
  expect(node.querySelector("output")?.textContent).toBe("/issues/analysis-id");
  const state = JSON.parse(node.querySelector("pre")!.textContent!);
  expect(state.issueDetailSource).toBe("analysis");
  expect(state.issueDetailBreadcrumb.href).toBe(
    "/issues?projectId=project&page=3&snapshotId=snapshot&taskType=analysis",
  );
});
it("opens list items in the same task detail and does not dispatch work", async () => {
  const dispatch = vi.spyOn(analysisApi, "dispatch");
  const node = await mount("?projectId=project&page=2");
  await act(async () =>
    [...node.querySelectorAll("button")]
      .find((button) => button.textContent?.includes("原分析 · 修订 1"))!
      .click(),
  );
  expect(node.querySelector("output")?.textContent).toBe("/issues/analysis-id");
  expect(dispatch).not.toHaveBeenCalled();
});
it("prefills a new revision from the existing analysis and uses the original create contract", async () => {
  const create = vi
    .spyOn(analysisApi, "create")
    .mockResolvedValue({ ...execution, id: "new-revision", revision: 2 });
  const node = await mount("?projectId=project&supersedesId=analysis-id");
  expect(node.textContent).toContain("建立新修订（不覆盖原分析）");
  expect(
    (node.querySelector('[aria-label="分析标题"]') as HTMLInputElement).value,
  ).toBe(execution.title);
  expect(
    (node.querySelector('[aria-label="分析诉求"]') as HTMLTextAreaElement)
      .value,
  ).toBe(execution.brief);
  await act(async () =>
    node
      .querySelector("form")!
      .dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })),
  );
  expect(create).toHaveBeenCalledWith(
    "company",
    expect.objectContaining({
      projectId: "project",
      seatId: "seat",
      supersedesId: "analysis-id",
      brief: execution.brief,
      demandNo: "TWGF-00919",
    }),
  );
  expect(node.querySelector("output")?.textContent).toBe(
    "/issues/new-revision",
  );
});

it("moves bookmarked analysis collections into tasks and preserves revision context", async () => {
  vi.spyOn(analysisApi, "create").mockResolvedValue({ ...execution, id: "new-revision", revision: 2 });
  const node = await mount("?projectId=project&page=3&snapshotId=snapshot&supersedesId=analysis-id", true);
  expect(node.textContent).toContain("建立新修订（不覆盖原分析）");
  await act(async () => node.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
  const state = JSON.parse(node.querySelector("pre")!.textContent!);
  expect(state.issueDetailBreadcrumb.href).toBe("/issues?projectId=project&page=3&snapshotId=snapshot&taskType=analysis");
});

it("uses the original analysis create form without loading a separate list", async () => {
  const node = await mount("?taskType=analysis&createAnalysis=1&projectId=project", false, true);
  expect(node.querySelector("form")).not.toBeNull();
  expect(node.querySelector('[aria-label="分析任务列表"]')).toBeNull();
  expect(analysisApi.list).not.toHaveBeenCalled();
});

it("does not offer an unrelated create form when a requested revision cannot be loaded", async () => {
  const node = await mount("?taskType=analysis&createAnalysis=1&projectId=project&supersedesId=missing", false, true);
  expect(node.querySelector("form")).toBeNull();
  expect([...node.querySelectorAll("button")].some(button => button.textContent === "创建分析任务")).toBe(false);
});
