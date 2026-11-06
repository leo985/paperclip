// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ManagementFollowUpControls } from "./ManagementFollowUpControls";
const mocks = vi.hoisted(() => ({ get: vi.fn(), update: vi.fn(), manage: false }));
vi.mock("@/api/management-follow-ups", () => ({ managementFollowUpApi: mocks }));
vi.mock("@/api/auth", () => ({ authApi: { getSession: async () => ({ user: { id: "me" } }) } }));
vi.mock("@/api/access", () => ({ accessApi: { listUserDirectory: async () => ({ users: [{ principalId: "other", user: { name: "Other member" } }] }) } }));
vi.mock("@/hooks/useManagementAccess", () => ({ useManagementAccess: () => ({ canManage: mocks.manage }) }));
let container: HTMLDivElement, root: ReturnType<typeof createRoot>, client: QueryClient;
const record = { companyId: "company", issueId: "issue", ownerUserId: "me", remindAt: null, version: 4, updatedBy: "me", updatedAt: new Date().toISOString() };
beforeEach(() => {
  mocks.manage = false; mocks.get.mockReset().mockResolvedValue(null); mocks.update.mockReset();
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
  client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
});
afterEach(async () => { await act(async () => root.unmount()); client.clear(); container.remove(); });
async function settle() { await act(async () => { await new Promise(resolve => setTimeout(resolve, 30)); }); }
async function render() {
  await act(async () => root.render(<QueryClientProvider client={client}><ManagementFollowUpControls companyId="company" issueId="issue" /></QueryClientProvider>));
}
async function open() { await act(async () => { const d = container.querySelector("details")!; d.open = true; d.dispatchEvent(new Event("toggle")); }); await settle(); }
async function click(text: string) {
  const button = [...container.querySelectorAll("button")].find(b => b.textContent === text)!;
  expect(button).toBeDefined(); expect(button.disabled).toBe(false);
  await act(async () => button.click()); await settle();
}
it("loads only when expanded, claims with the persisted version, then releases", async () => {
  mocks.update.mockResolvedValue(record);
  await render(); expect(mocks.get).not.toHaveBeenCalled(); await open();
  await click("由我跟进"); expect(mocks.update).toHaveBeenLastCalledWith("company", "issue", { expectedVersion: 0, ownerUserId: "me" });
  expect(container.textContent).toContain("当前跟进人：我");
  mocks.update.mockResolvedValue({ ...record, ownerUserId: null, version: 5 });
  await click("释放跟进"); expect(mocks.update).toHaveBeenLastCalledWith("company", "issue", { expectedVersion: 4, ownerUserId: null, remindAt: null });
  expect(container.textContent).toContain("尚未认领");
});
it("prevents taking over another member's work", async () => {
  mocks.get.mockResolvedValue({ ...record, ownerUserId: "other" }); await render(); await open();
  expect(container.textContent).not.toContain("由我跟进"); expect(container.textContent).not.toContain("释放跟进");
  expect([...container.querySelectorAll("button")].find(b => b.textContent === "一小时后提醒")?.disabled).toBe(true);
  expect(mocks.update).not.toHaveBeenCalled();
});
it("shows conflicts and refreshes the record instead of overwriting a newer owner", async () => {
  mocks.get.mockResolvedValue(record); mocks.update.mockRejectedValue(new Error("跟进记录已被更新"));
  await render(); await open(); await click("释放跟进");
  expect(container.querySelector('[role="alert"]')?.textContent).toContain("跟进记录已被更新");
  expect(mocks.get.mock.calls.length).toBeGreaterThan(1);
});
it("transfers to a directory member using optimistic concurrency", async () => {
  mocks.manage = true; mocks.get.mockResolvedValue(record); mocks.update.mockResolvedValue({ ...record, ownerUserId: "other", version: 5 });
  await render(); await open();
  await act(async () => { const select = container.querySelector("select")!; select.value = "other"; select.dispatchEvent(new Event("change", { bubbles: true })); });
  await click("转交跟进"); expect(mocks.update).toHaveBeenLastCalledWith("company", "issue", { expectedVersion: 4, ownerUserId: "other" });
  expect(container.textContent).toContain("Other member");
});
