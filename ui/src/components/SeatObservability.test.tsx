// @vitest-environment jsdom
import { act, createElement, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { DEFAULT_SEAT_WORK_SCHEDULE, type SeatPeriodReport } from "@paperclipai/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { managedSessionsApi } from "@/api/managed-sessions";
import { SeatObservability } from "./SeatObservability";

vi.mock("@/api/managed-sessions", () => ({ managedSessionsApi: { report: vi.fn(), updateWorkSchedule: vi.fn() } }));
vi.mock("@/components/ManagedSessionPanel", () => ({ duration: (ms: number) => `${ms / 60_000} 分钟` }));
vi.mock("@/lib/router",()=>({Link:({to,children,...props}:{to:string;children:ReactNode})=>createElement("a",{href:to,...props},children)}));
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root | undefined;
let container: HTMLDivElement;
let cache: QueryClient;
beforeEach(() => vi.stubGlobal("ResizeObserver", class {
  observe() {} unobserve() {} disconnect() {}
}));
const date = new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 10);
function fixture(manager = true): SeatPeriodReport {
  const timing = { onlineMs: 60_000, onlineGaps: [{ from: "2026-10-19T01:00:00Z", to: "2026-10-19T02:00:00Z" }], executingMs: 0, waitingMs: 0, idleMs: 0, unknownMs: 300_000 };
  return { timezone: "Asia/Shanghai", from: "2026-10-18T16:00:00Z", to: "2026-10-25T16:00:00Z", period: "week", simulatedExcluded: true, workSchedule: structuredClone(DEFAULT_SEAT_WORK_SCHEDULE), canConfigureWorkSchedule: manager, note: "统计说明",
    seats: [{ seatId: "seat", ownerUserId: "user", name: "电脑", ownerName: "研发", backlog: 1, jiraBacklog: 1, jiraScope: null, started: 1, delivered: 0, cancelled: 0, coverage: 0.1, defects: null, qualityCoverage: 0, matureDeliveries: 0, defectRate: null, ...timing }],
    people: [{ ownerUserId: "user", name: "研发", ...timing }],
  };
}
async function render(data: SeatPeriodReport) {
  container = document.createElement("div"); document.body.append(container);
  cache = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  cache.setQueryData(["managed-seat-report", "company", "week", date], data);
  root = createRoot(container);
  await act(async () => root!.render(<QueryClientProvider client={cache}><SeatObservability companyId="company" /></QueryClientProvider>));
}
afterEach(async () => {
  await act(async () => root?.unmount()); root = undefined;
  container?.remove(); cache?.clear(); vi.clearAllMocks(); vi.unstubAllGlobals();
});
async function setTime(label: string, value: string) {
  const input = container.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`)!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
async function submit() {
  await act(async () => container.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
}

describe("seat statistics", () => {
  it("keeps connectivity as one auxiliary column and places gaps/settings in collapsed details", async () => {
    await render(fixture());
    await act(async () => [...container.querySelectorAll("button")].find(b=>b.textContent==="工作与等待")!.click());
    const headers = [...container.querySelectorAll("th")].map(th => th.textContent);
    expect(headers).toHaveLength(8);
    expect(headers).toContain("工作时段在线");
    expect(headers).not.toContain("未知"); expect(headers).not.toContain("覆盖率");
    expect(headers).toContain("未知时间");
    expect(container.querySelector("th[title]")?.getAttribute("title")).toContain("09:00–12:00");
    const details = [...container.querySelectorAll("details")];
    expect(details.every(detail => !detail.open)).toBe(true);
    expect(container.textContent).toContain("统计不完整");
    expect(container.textContent).toContain("10/19 09:00");
  });
  it("does not offer organization settings to ordinary members", async () => {
    await render(fixture(false));
    expect(container.querySelector("form")).toBeNull();
    expect(container.textContent).not.toContain("工作时段设置");
  });
  it("rejects overlapping shifts, then saves valid settings and refreshes the report", async () => {
    const data = fixture();
    await render(data);
    await setTime("时段 2 开始", "11:00");
    await submit();
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("重叠");
    expect(managedSessionsApi.updateWorkSchedule).not.toHaveBeenCalled();
    await setTime("时段 2 开始", "14:00");
    const next = { ...data.workSchedule, periods: [{ start: "09:00", end: "12:00" }, { start: "14:00", end: "18:00" }] };
    vi.mocked(managedSessionsApi.updateWorkSchedule).mockResolvedValue(next);
    vi.mocked(managedSessionsApi.report).mockResolvedValue({ ...data, workSchedule: next });
    await submit();
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 20)); });
    expect(managedSessionsApi.updateWorkSchedule).toHaveBeenCalledWith("company", next);
    expect(container.textContent).toContain("工作时段已保存");
    await act(async () => [...container.querySelectorAll("button")].find(b=>b.textContent==="工作与等待")!.click());
    expect(container.querySelector("th[title]")?.getAttribute("title")).toContain("14:00–18:00");
  });
});
