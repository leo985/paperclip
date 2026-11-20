// @vitest-environment jsdom
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Dsp7ExecutionStatus } from "./Dsp7ExecutionStatus";
const mock = vi.hoisted(() => ({ canManage: true, update: vi.fn(), state: vi.fn() }));
vi.mock("../hooks/useManagementAccess", () => ({ useManagementAccess: () => ({ canManage: mock.canManage, loading: false }) }));
vi.mock("../api/issues", () => ({ issuesApi: { update: mock.update } }));
vi.mock("../api/dsp7-seats", () => ({ dsp7SeatsApi: { dispatchStatus: mock.state } }));
vi.mock("./JiraIntakeSourceStatus", () => ({ JiraIntakeSourceStatus: () => null, useJiraIntakeSource: () => ({ data: { eligible: true }, isError: false }) }));
vi.mock("./SeatStartupProgress", () => ({ SeatStartupProgress: () => null }));
vi.mock("./SeatWaitingGuidance", () => ({ SeatWaitingGuidance: () => null }));
let node: HTMLDivElement, root: Root, cache: QueryClient;
const issue = { id: "task", companyId: "company", identifier: "DSP-11", description: '<!-- DSP7-JIRA-INTAKE {"seat_id":"seat"} -->' };
function render(phase = "blocked") {
  cache.setQueryData(["platform-dispatch", "company", "seat", "task"], { phase, authorized: true });
  flushSync(() => root.render(<QueryClientProvider client={cache}><Dsp7ExecutionStatus issue={issue} /></QueryClientProvider>));
}
function click(text: string) {
  const button = [...node.querySelectorAll('button')].find(b => b.textContent === text);
  expect(button).toBeDefined(); flushSync(() => button!.click());
}
beforeEach(() => {
  vi.clearAllMocks(); mock.canManage = true; mock.state.mockResolvedValue({ phase: "blocked", authorized: true });
  cache = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity }, mutations: { retry: false } } });
  node = document.createElement('div'); document.body.append(node); root = createRoot(node);
});
afterEach(() => { flushSync(() => root.unmount()); cache.clear(); node.remove(); });
describe("admin revocation in the task execution panel", () => {
  it("requires explicit confirmation and cancels only the current platform task", async () => {
    mock.update.mockResolvedValue({ ...issue, status: "cancelled" });
    render(); click("撤销本次执行");
    expect(node.textContent).toContain("Jira 工单不变"); expect(mock.update).not.toHaveBeenCalled();
    click("返回"); expect(mock.update).not.toHaveBeenCalled();
    click("撤销本次执行"); mock.state.mockResolvedValue({ phase: "cancelled", authorized: true }); click("确认撤销");
    await vi.waitFor(() => expect(node.textContent).toContain("本次平台执行已取消"));
    expect(mock.update).toHaveBeenCalledExactlyOnceWith("task", { status: "cancelled" });
    expect(node.textContent).not.toContain("确认撤销"); expect(node.textContent).not.toContain("撤销本次执行");
  });
  it("shows server denials without pretending the task was cancelled", async () => {
    mock.update.mockRejectedValue(new Error("没有取消权限")); render(); click("撤销本次执行"); click("确认撤销");
    await vi.waitFor(() => expect(node.textContent).toContain("撤销失败：没有取消权限"));
    expect(node.textContent).toContain("确认撤销"); expect(node.textContent).not.toContain("本次平台执行已取消");
  });
  it("does not expose admin revocation to ordinary members", () => {
    mock.canManage = false; render(); expect(node.textContent).not.toContain("撤销本次执行"); expect(mock.update).not.toHaveBeenCalled();
  });
  it.each(["running", "waiting_decision", "interrupted", "startup_failed"])("offers the same cancellation flow while %s", phase => {
    render(phase); expect(node.textContent).toContain("撤销本次执行"); expect(mock.update).not.toHaveBeenCalled();
  });
});
