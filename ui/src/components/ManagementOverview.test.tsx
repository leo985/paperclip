// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, useLocation } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CompactIssue } from "@paperclipai/shared";
import type { RegisteredSeat } from "@/api/dsp7-seats";
import { CollaborationWorkbench } from "./CollaborationWorkbench";
import { FocusedInbox } from "./FocusedInbox";

const state = vi.hoisted(() => ({ company: "c1", user: "u1", manager: true, loading: false, issues: [] as unknown[], seats: [] as unknown[] }));
vi.mock("@/lib/router", () => import("react-router-dom"));
vi.mock("@/context/CompanyContext", () => ({ useCompany: () => ({ selectedCompanyId: state.company }) }));
vi.mock("@/hooks/useManagementAccess", () => ({ useManagementAccess: () => ({ canManage: state.manager, loading: state.loading }) }));
vi.mock("@/hooks/useManagementIssues", () => ({ useManagementIssues: () => ({ data: { pages: [state.issues] }, isSuccess: true, hasNextPage: false, isFetching: false, refetch: vi.fn() }) }));
vi.mock("@/api/auth", () => ({ authApi: { getSession: async () => ({ user: { id: state.user } }) } }));
vi.mock("@/api/access", () => ({ accessApi: { listUserDirectory: async () => ({ users: [] }) } }));
vi.mock("@/api/dsp7-seats", () => ({ dsp7SeatsApi: { list: async () => state.seats } }));
vi.mock("@/api/heartbeats", () => ({ heartbeatsApi: { liveRunsForCompany: async () => [] } }));
vi.mock("@/pages/Inbox", () => ({ Inbox: () => <p>原平台通知</p> }));

const issue = { id: "t1", identifier: "DSP-1", title: "核对支付权限", status: "in_progress", assigneeAgentId: "s1", assigneeUserId: null, projectId: "p1", updatedAt: new Date() } as unknown as CompactIssue;
const seat = { agentId: "s1", name: "研发电脑", isMine: true, owner: { name: "李工" }, online: true, presence: { state: "busy", activeTaskId: "t1", lastSeenAt: new Date().toISOString(), tasks: [], alerts: [{ id: "a1", taskId: "t1", message: "请核对当前输入", elapsedMinutes: 12 }, { id: "a2", taskId: "t1", message: "请核对当前输入", elapsedMinutes: 15 }] } } as unknown as RegisteredSeat;
let cleanup: (() => void) | undefined;
beforeEach(() => { state.company = "c1"; state.user = "u1"; state.manager = true; state.loading = false; state.issues = [issue]; state.seats = [seat]; localStorage.clear(); });
afterEach(async () => { await act(async () => cleanup?.()); cleanup = undefined; });
function Location() { return <output>{useLocation().search}</output>; }
async function mount(path = "/", inbox = false) {
  const node = document.createElement("div"); document.body.append(node); const root = createRoot(node);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  await act(async () => { root.render(<QueryClientProvider client={client}><MemoryRouter initialEntries={[path]}>{inbox ? <FocusedInbox /> : <CollaborationWorkbench companyId={state.company} />}<Location /></MemoryRouter></QueryClientProvider>); });
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 25)); });
  cleanup = () => { root.unmount(); client.clear(); node.remove(); }; return node;
}
async function click(node: HTMLElement, text: string) { const button = [...node.querySelectorAll("button")].find(b => b.textContent === text); expect(button).toBeTruthy(); await act(async () => button!.click()); }

describe("management overview interactions", () => {
  it("defaults managers to company and renders one alerted task with matching scoped drilldown", async () => {
    const node = await mount("/?projectId=p1");
    expect(node.querySelector("h1")?.textContent).toBe("组织管理概览");
    expect(node.querySelectorAll("article")).toHaveLength(1);
    expect(node.textContent?.match(/请核对当前输入/g)).toHaveLength(1);
    expect(node.textContent).toContain("处理负责人：李工"); expect(node.textContent).toContain("下一步：");
    const href = node.querySelector('a[aria-label="需要处理与核实 1 项"]')?.getAttribute("href");
    const params = new URL(href!, "http://localhost").searchParams;
    expect(params.get("scope")).toBe("company"); expect(params.get("projectId")).toBe("p1"); expect(params.get("view")).toBe("attention");
    expect(node.querySelector('a[aria-label="正在执行 0 项"]')).toBeTruthy();
  });
  it("remembers the selected scope for this account and company", async () => {
    const node = await mount(); await click(node, "我的工作");
    expect(node.querySelector("output")?.textContent).toContain("scope=mine"); expect(localStorage.getItem("zhiyan:management-scope:u1:c1")).toBe("mine");
    await act(async () => cleanup?.()); cleanup = undefined;
    const again = await mount(); expect(again.querySelector("h1")?.textContent).toBe("我的工作台");
  });
  it("does not reuse another account or company's preference and URL takes precedence", async () => {
    localStorage.setItem("zhiyan:management-scope:u2:c1", "mine"); localStorage.setItem("zhiyan:management-scope:u1:c2", "mine");
    const node = await mount(); expect(node.querySelector("h1")?.textContent).toBe("组织管理概览");
    await act(async () => cleanup?.()); cleanup = undefined;
    const direct = await mount("/?scope=mine"); expect(direct.querySelector("h1")?.textContent).toBe("我的工作台");
  });
  it("waits for access resolution before saving a default preference", async () => {
    state.loading = true; state.manager = false; await mount();
    expect(localStorage.getItem("zhiyan:management-scope:u1:c1")).toBeNull();
  });
  it("defaults a member to Mine and excludes reassigned stale seat registrations", async () => {
    state.manager = false; state.issues = [{ ...issue, assigneeAgentId: "other-seat" }];
    const node = await mount(); expect(node.querySelector("h1")?.textContent).toBe("我的工作台"); expect(node.querySelectorAll("article")).toHaveLength(0);
  });
  it("redirects the old inbox into the workbench without changing the task or project", async () => {
    const node = await mount("/inbox?scope=company&projectId=p1", true);
    expect(issue.status).toBe("in_progress");
    expect(node.querySelector("output")?.textContent).toContain("projectId=p1");
    expect(node.querySelector("output")?.textContent).toContain("tab=organization");
  });
});
