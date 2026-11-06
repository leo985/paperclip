// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import { dsp7SeatsApi, type RegisteredSeat } from "@/api/dsp7-seats";
import { DeleteSeatButton } from "./DeleteSeatButton";

const access = vi.hoisted(() => ({ canManage: true }));
vi.mock("@/hooks/useManagementAccess", () => ({ useManagementAccess: () => access }));
vi.mock("@/api/dsp7-seats", () => ({ dsp7SeatsApi: { remove: vi.fn() } }));
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root;
let container: HTMLDivElement;
let cache: QueryClient;
const deleted = vi.fn();
const seat = { agentId: "seat", name: "Old computer", online: false } as RegisteredSeat;
async function render(overrides: Partial<RegisteredSeat> = {}) {
  container = document.createElement("div"); document.body.append(container);
  cache = new QueryClient({ defaultOptions: {queries: {retry: false}} });
  cache.setQueryData(["dsp7-registered-seats", "company"], [seat, {...seat, agentId: "other"}]);
  root = createRoot(container);
  await act(async () => root.render(<QueryClientProvider client={cache}><DeleteSeatButton companyId="company" seat={{...seat,...overrides}} onDeleted={deleted}/></QueryClientProvider>));
}
async function click(label: string) {
  const button = [...document.querySelectorAll("button")].find(item => item.textContent === label)!;
  await act(async () => button.click());
}
async function typeName(value: string) {
  const input = document.querySelector<HTMLInputElement>('input[aria-label="输入席位名称确认删除"]')!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
    input.dispatchEvent(new Event("input", {bubbles: true}));
  });
}
afterEach(async () => {
  await act(async () => root?.unmount()); container?.remove(); cache?.clear();
  vi.clearAllMocks(); access.canManage = true;
});
describe("administrator seat deletion control", () => {
  it("does not offer deletion to a non-administrator", async () => {
    access.canManage=false; await render(); expect(container.textContent).toBe("");
  });
  it("requires the computer to be offline", async () => {
    await render({online:true});expect(container.querySelector("button")?.disabled).toBe(true);
    expect(container.querySelector("button")?.title).toContain("下线");
  });
  it("requires the exact seat name and permits cancellation without sending a request", async () => {
    await render();await click("删除席位");await typeName("wrong computer");
    expect([...document.querySelectorAll("button")].find(item=>item.textContent==="确认删除席位")?.disabled).toBe(true);
    await click("取消");expect(document.querySelector('[role="alertdialog"]')).toBeNull();
    expect(dsp7SeatsApi.remove).not.toHaveBeenCalled();
  });
  it("keeps the confirmation and actionable error when the server rejects deletion", async () => {
    vi.mocked(dsp7SeatsApi.remove).mockRejectedValue(new Error("席位有未结束的任务，请先转派"));
    await render();await click("删除席位");await typeName(seat.name);await click("确认删除席位");
    expect(document.querySelector('[role="alertdialog"]')).not.toBeNull();
    expect(document.querySelector('[role="alert"]')?.textContent).toContain("转派");
    expect(deleted).not.toHaveBeenCalled();
  });
  it("removes only the selected card after confirmed deletion and updates selection", async () => {
    vi.mocked(dsp7SeatsApi.remove).mockResolvedValue({ok:true});
    await render();await click("删除席位");await typeName(seat.name);await click("确认删除席位");
    expect(dsp7SeatsApi.remove).toHaveBeenCalledWith("company","seat");
    expect(deleted).toHaveBeenCalledOnce();
    expect(cache.getQueryData<RegisteredSeat[]>(["dsp7-registered-seats","company"])?.map(item=>item.agentId)).toEqual(["other"]);
    expect(document.querySelector('[role="alertdialog"]')).toBeNull();
  });
});
