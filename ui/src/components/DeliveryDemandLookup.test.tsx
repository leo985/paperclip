// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { DeliveryDemandLookup } from "./DeliveryDemandLookup";

const state = vi.hoisted(() => ({ post: vi.fn(), navigate: vi.fn(), invalidateQueries: vi.fn(), configured: true }));
vi.mock("@/api/client", () => ({ api: { post: state.post } }));
vi.mock("@tanstack/react-query", () => ({ useQueryClient: () => ({ invalidateQueries: state.invalidateQueries }), useQuery: () => ({ data: { revision: 3, credentialsConfigured: state.configured } }) }));
vi.mock("@/lib/router", () => ({ useNavigate: () => state.navigate, Link: ({ to, children }: any) => <a href={to}>{children}</a> }));
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
let cleanup: (() => Promise<void>) | undefined;
afterEach(async () => { await cleanup?.(); cleanup = undefined; state.post.mockReset(); state.navigate.mockReset(); state.invalidateQueries.mockReset(); state.configured = true; });
async function mount(month?: string) {
  const node = document.createElement("div"); document.body.append(node); const root = createRoot(node);
  await act(async () => root.render(<DeliveryDemandLookup companyId="company" projectId="project" month={month} />));
  cleanup = async () => { await act(async () => root.unmount()); node.remove(); };
  return {
    node,
    input: async (value: string) => { await act(async () => {
      const input = node.querySelector("input")!;
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
      input.dispatchEvent(new Event("input", { bubbles: true }));
    }); },
    submit: async () => { await act(async () => { node.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })); }); },
  };
}
const result = { demandNo: "TWGF-00919", title: "未排期需求", sourceStatus: "待需求分析", owner: "", analysisOwner: "分析人员", snapshotId: null, collectedAt: "2026-11-11T00:00:00Z" };
it("queries an unsaved demand independently of the month and normalizes the complete number", async () => {
  state.post.mockResolvedValue(result);
  const { node, input, submit } = await mount(); await input(" twgf-00919 "); await submit();
  expect(state.post).toHaveBeenCalledWith("/companies/company/delivery-connections/lookup", { projectId: "project", expectedRevision: 3, demandNo: "TWGF-00919" });
  expect(node.textContent).toContain("TWGF-00919 · 未排期需求"); expect(node.textContent).toContain("本组织尚未保存条目版本");
  expect(node.querySelector('a[href*="view=sources"]')?.getAttribute("href")).toContain("demandNo=TWGF-00919");
  await input("TWGF-00920"); expect(node.querySelector('[aria-label="条目精确查询结果"]')).toBeNull();
});
it("links an already managed demand to its saved detail", async () => {
  state.post.mockResolvedValue({ ...result, snapshotId: "saved" });
  const { node, input, submit } = await mount(); await input("TWGF-00919"); await submit();
  expect(node.querySelector('a[href*="snapshotId=saved"]')).not.toBeNull();
});
it("rejects incomplete numbers and clears the old result when the next query fails", async () => {
  const { node, input, submit } = await mount(); await input("TWGF"); await submit();
  expect(state.post).not.toHaveBeenCalled(); expect(node.textContent).toContain("请填写完整条目编号");
  state.post.mockResolvedValueOnce(result); await input("TWGF-00919"); await submit();
  state.post.mockRejectedValueOnce(new Error("来源权限不足")); await submit();
  expect(node.querySelector('[role="alert"]')?.textContent).toBe("来源权限不足");
  expect(node.querySelector('[aria-label="条目精确查询结果"]')).toBeNull();
});
it("disables upstream lookup until project credentials are configured", async () => {
  state.configured = false; const { node, input, submit } = await mount();
  expect(node.querySelector("button")?.disabled).toBe(true);
  await input("TWGF-00919"); await submit(); expect(state.post).not.toHaveBeenCalled();
});

it("opens a saved entry in the project that owns the snapshot", async () => {
  state.post.mockResolvedValue({ ...result, savedEntries: [{ projectId: "foundation", projectName: "基础平台", snapshotId: "saved" }] });
  const { node, input, submit } = await mount("2026-11"); await input("TWGF-00919"); await submit();
  const link = node.querySelector("h3 a");
  expect(link?.getAttribute("href")).toBe("/delivery?projectId=foundation&snapshotId=saved&month=2026-11");
  expect(node.textContent).toContain("查看条目详情（基础平台）");
  expect(node.textContent).not.toContain("同步工单并打开详情");
});

it("syncs an unsaved entry only after the user clicks and opens the resulting snapshot", async () => {
  state.post.mockResolvedValueOnce(result).mockResolvedValueOnce({ snapshot: { id: "synced", projectId: "project" } });
  const { node, input, submit } = await mount("2026-10"); await input("TWGF-00919"); await submit();
  expect(state.post).toHaveBeenCalledTimes(1);
  const sync = [...node.querySelectorAll("button")].find(button => button.textContent === "同步工单并打开详情")!;
  await act(async () => { sync.click(); });
  expect(state.post).toHaveBeenLastCalledWith("/companies/company/delivery-connections/sync", {
    projectId: "project", expectedRevision: 3, demandNo: "TWGF-00919", months: ["2026-10"],
  });
  expect(state.navigate).toHaveBeenCalledWith("/delivery?projectId=project&snapshotId=synced&month=2026-10");
});
