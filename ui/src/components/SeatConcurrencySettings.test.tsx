// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, expect, it, vi } from "vitest";
import { SeatConcurrencySettings } from "./SeatConcurrencySettings";

const save = vi.hoisted(() => vi.fn());
vi.mock("@/api/dsp7-seats", () => ({ dsp7SeatsApi: { saveConcurrency: save } }));
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root, container: HTMLDivElement, cache: QueryClient;
const seat: any = { agentId: "seat", maxConcurrentRuns: 2, canConfigure: true, executionTransport: "outbound", presence: { capabilities: ["seat-concurrency-v1"] } };
async function show(value = seat) {
  save.mockReset();
  container = document.createElement("div"); document.body.append(container);
  root = createRoot(container); cache = new QueryClient();
  await act(async () => root.render(<QueryClientProvider client={cache}><SeatConcurrencySettings companyId="company" seat={value}/></QueryClientProvider>));
}
async function change(value: string) {
  await act(async () => {
    const input = container.querySelector("input")!;
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
async function submit() { await act(async () => { container.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })); }); }
afterEach(async () => { await act(async () => root?.unmount()); container?.remove(); cache?.clear(); });
it("saves the selected seat limit and explains queueing", async () => {
  await show(); save.mockResolvedValue({ maxConcurrentRuns: 3 });
  await change("3"); await submit();
  expect(save).toHaveBeenCalledWith("company", "seat", 3);
  expect(container.textContent).toContain("并发数已保存");
  expect(container.textContent).toContain("已有运行继续");
});
it("keeps failed saves visible and rejects invalid limits", async () => {
  await show(); await change("0"); await submit();
  expect(save).not.toHaveBeenCalled();
  expect(container.querySelector('[role="alert"]')?.textContent).toContain("1–50");
  save.mockRejectedValue(new Error("保存失败")); await change("4"); await submit();
  expect(container.querySelector('[role="alert"]')?.textContent).toBe("保存失败");
});
it("shows the upgrade requirement and disables editing for viewers", async () => {
  await show({ ...seat, canConfigure: false, presence: { capabilities: [] } });
  expect(container.querySelector("input")!.disabled).toBe(true);
  expect(container.textContent).toContain("请更新本机主动连接客户端");
  expect(container.querySelector('button[type="submit"]')).toBeNull();
});
