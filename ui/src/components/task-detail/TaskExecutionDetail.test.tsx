// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Issue } from "@paperclipai/shared";
import { analysisApi } from "@/api/analysis-executions";
import { TaskExecutionDetail } from "./TaskExecutionDetail";
vi.mock("@/lib/router", () => ({
  useLocation: () => ({ state: null, search: "" }),
  Link: ({ to, children }: { to: string; children: React.ReactNode }) => (
    <a href={to}>{children}</a>
  ),
}));
vi.mock("@/api/delivery-workflows",()=>({deliveryWorkflowApi:{forTask:async()=>null}}));
vi.mock("./DeliveryWorkflowTaskLink",()=>({DeliveryWorkflowTaskLink:()=>null}));
vi.mock("./TaskIdentitySummary", () => ({
  TaskIdentitySummary: () => <p>执行席位与负责人</p>,
}));
vi.mock("./AnalysisTaskDetail", () => ({
  AnalysisTaskDetail: ({
    detail,
  }: {
    detail: { execution: { id: string } };
  }) => <p>分析专属详情 {detail.execution.id}</p>,
}));
vi.mock("@/components/Dsp7ExecutionStatus", () => ({
  Dsp7ExecutionStatus: () => <p>通用派单、恢复与撤销</p>,
}));
vi.mock("@/components/JiraRequirementPanel", () => ({
  JiraRequirementPanel: () => <p>Jira 需求总览</p>,
}));
vi.mock("@/components/ManagedSessionPanel", () => ({
  ManagedSessionPanel: ({ taskId }: { taskId: string }) => (
    <p>会话与阶段 {taskId}</p>
  ),
}));
vi.mock("@/components/issue-properties/IssuePropertiesArtifactsTab", () => ({
  IssuePropertiesArtifactsTab: () => <p>已有成果、文档与附件</p>,
}));
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
let cleanup: (() => Promise<void>) | undefined;
afterEach(async () => {
  await cleanup?.();
  cleanup = undefined;
  vi.restoreAllMocks();
});
const issue = {
  id: "task",
  companyId: "company",
  title: "研发或测试任务",
  identifier: "DSP-1",
  description: "既有说明",
  status: "blocked",
  assigneeAgentId: null,
  assigneeUserId: null,
} as Issue;
async function mount() {
  const node = document.createElement("div");
  document.body.append(node);
  const root = createRoot(node);
  const cache = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  await act(async () => {
    root.render(
      <QueryClientProvider client={cache}>
        <TaskExecutionDetail issue={issue} />
      </QueryClientProvider>,
    );
  });
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
describe("unified task domain selection", () => {
  it("shows common task capabilities only on explicit analysis absence, preserving sessions even after unassignment", async () => {
    vi.spyOn(analysisApi, "forTask").mockResolvedValue({ analysis: null });
    const node = await mount();
    for (const text of [
      "统一任务详情",
      "通用派单、恢复与撤销",
      "Jira 需求总览",
      "已有成果、文档与附件",
      "会话与阶段 task",
    ]) {
      if (text === "统一任务详情")
        expect(
          node.querySelector('[aria-label="统一任务详情"]'),
        ).not.toBeNull();
      else expect(node.textContent).toContain(text);
    }
    expect(
      node.querySelector('a[href="/issues/DSP-1?detailView=collaboration"]'),
    ).not.toBeNull();
    const nav = [...node.querySelectorAll("nav a")];
    for (const anchor of nav)
      expect(
        node.querySelector(`[id="${anchor.getAttribute("href")!.slice(1)}"]`),
      ).not.toBeNull();
  });
  it("uses the analysis-specific controls instead of generic dispatch", async () => {
    vi.spyOn(analysisApi, "forTask").mockResolvedValue({
      analysis: { execution: { id: "task", projectId: "project" } } as never,
    });
    const node = await mount();
    expect(node.textContent).toContain("分析专属详情 task");
    expect(node.textContent).not.toContain("通用派单");
  });
  it("keeps access and read failures visible, without exposing generic controls", async () => {
    vi.spyOn(analysisApi, "forTask").mockRejectedValue(
      new Error("无权查看或读取失败"),
    );
    const node = await mount();
    expect(node.querySelector('[role="alert"]')?.textContent).toContain(
      "无权查看或读取失败",
    );
    expect(node.textContent).not.toContain("通用派单");
    expect(node.textContent).not.toContain("会话与阶段");
  });
});
