// @vitest-environment jsdom
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DeliveryEntries } from "./DeliveryEntries";

const state = vi.hoisted(() => ({
  companyId: "company-a",
  params: new URLSearchParams("snapshotId=entry-a"),
  breadcrumbs: vi.fn(),
}));
vi.mock("@/context/CompanyContext", () => ({ useCompany: () => ({ selectedCompanyId: state.companyId }) }));
vi.mock("@/context/BreadcrumbContext", () => ({ useBreadcrumbs: () => ({ setBreadcrumbs: state.breadcrumbs }) }));
vi.mock("@/hooks/useManagementAccess", () => ({ useManagementAccess: () => ({ canManage: true }) }));
vi.mock("@/lib/router", () => ({
  Link: ({ children }: any) => <span>{children}</span>,
  useSearchParams: () => [state.params, vi.fn()],
}));
// Return data synchronously to cover navigation to an already cached entry.
vi.mock("@tanstack/react-query", () => ({ useQuery: ({ queryKey }: any) => ({
  isSuccess: true,
  refetch: vi.fn(),
  data: queryKey[0] === "delivery-entry" ? {
    snapshot: { id: state.params.get("snapshotId"), projectId: "project", demandNo: "DEMAND-1", collectedAt: "2026-11-06", plan: { title: "条目", roles: [], differences: [] } },
    chainAdmission: { ready: true }, analyses: [], tasks: [],
  } : [],
}) }));
vi.mock("@/components/DeliveryWorkflowPanel", () => ({
  DeliveryWorkflowPanel: ({ startRequested }: { startRequested: boolean }) => <div data-start-requested={String(startRequested)} />,
}));
vi.mock("@/components/DeliveryEntryStages", () => ({ DeliveryEntryStages: () => null }));
vi.mock("@/components/DeliveryChainAdmissionPanel", () => ({ DeliveryChainAdmissionPanel: () => null }));
vi.mock("@/components/DeliveryAdmissionPanel", () => ({ DeliveryAdmissionPanel: () => null }));
vi.mock("@/components/DeliveryMaterials", () => ({ DeliveryMaterials: () => null }));
vi.mock("@/components/DeliveryWorkDispatch", () => ({ DeliveryWorkDispatch: () => null }));
vi.mock("@/components/DeliveryMonthlyBoard", () => ({ DeliveryMonthlyBoard: () => null }));
vi.mock("./DeliveryIntake", () => ({ DeliverySourcePlan: () => null, DeliverySources: () => null }));

let root: Root;
let container: HTMLDivElement;
function render() { flushSync(() => root.render(<DeliveryEntries />)); }
function mount() {
  state.companyId = "company-a";
  state.params = new URLSearchParams("snapshotId=entry-a");
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  vi.stubGlobal("requestAnimationFrame", vi.fn());
  render();
}
function openStart() {
  const button = [...container.querySelectorAll("button")].find(b => b.textContent === "启动 AI 交付链")!;
  flushSync(() => button.click());
  expect(container.querySelector("details")?.open).toBe(true);
  expect(container.querySelector("[data-start-requested]")?.getAttribute("data-start-requested")).toBe("true");
}
function expectClosed() {
  expect(container.querySelector("details")?.open).toBe(false);
  expect(container.querySelector("[data-start-requested]")?.getAttribute("data-start-requested")).toBe("false");
}
afterEach(() => {
  flushSync(() => root?.unmount());
  container?.remove();
  vi.unstubAllGlobals();
});

describe("delivery entry start panel navigation", () => {
  it("resets the panel and start request when switching directly to a cached entry", () => {
    mount(); openStart();
    state.params = new URLSearchParams("snapshotId=entry-b"); render();
    expectClosed();
  });
  it("resets when returning through the list, including reopening the same entry", () => {
    mount(); openStart();
    state.params = new URLSearchParams(); render();
    state.params = new URLSearchParams("snapshotId=entry-a"); render();
    expectClosed();
  });
  it("resets across companies but preserves the panel when changing tabs on the same entry", () => {
    mount(); openStart();
    state.params.set("tab", "analysis"); render();
    expect(container.querySelector("details")?.open).toBe(true);
    state.companyId = "company-b"; render();
    expectClosed();
  });
});
