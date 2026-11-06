// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { DeliveryStageRecord, DeliveryWorkflow } from "@paperclipai/shared";
import { DeliveryRepairControls } from "./DeliveryRepairControls";

const api = vi.hoisted(() => ({ seats: vi.fn(), repair: vi.fn() }));
vi.mock("@/api/delivery-workflows", () => ({ deliveryWorkflowApi: api }));
let container: HTMLDivElement, root: ReturnType<typeof createRoot>, client: QueryClient;
const changed = vi.fn();
function fixture(): DeliveryWorkflow {
  const stage: DeliveryStageRecord = { stage: "functional-test", taskId: "test", seatId: "qa", ownerUserId: "owner", jiraKey: "QA-1", dispatchId: "dispatch", state: "review", runId: "run", capabilityId: "cap", registryRevision: 1, inputDigest: "input", receiptDigest: "old-digest", review: null, message: null, receipt: { protocolVersion: 1, taskId: "test", runId: "run", stage: "functional-test", jiraKey: "QA-1", inputDigest: "input", stateDigest: "state", trackerReceiptId: "42", jiraReference: "https://jira.example/browse/QA-1", artifacts: [], testResults: { total: 1, passed: 0, failed: 1, blocked: 0, skipped: 0, testedVersion: "build", sourcePath: "execution-records.md", sourceSha256: "hash" } } };
  return { id: "flow", companyId: "company", projectId: "project", snapshotId: "snapshot", demandNo: "DEMAND", fingerprint: "fingerprint", createdBy: "owner", state: "blocked", config: {} as DeliveryWorkflow["config"], stages: [stage], message: null, acceptance: null, createdAt: "now", updatedAt: "now" };
}
beforeEach(() => {
  api.seats.mockReset().mockResolvedValue([
    { id: "dev", name: "Developer", online: true, domains: [{ roles: ["bug-fix", "code-review"] }] },
    { id: "review", name: "Reviewer", online: true, domains: [{ roles: ["code-review"] }] },
    { id: "qa", name: "QA", online: true, domains: [{ roles: ["functional-test"] }] },
  ]);
  api.repair.mockReset().mockResolvedValue({}); changed.mockReset();
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
  client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
});
afterEach(async () => { await act(async () => root.unmount()); client.clear(); container.remove(); });
async function render(workflow = fixture()) { await act(async () => root.render(<QueryClientProvider client={client}><DeliveryRepairControls companyId="company" workflow={workflow} onChanged={changed} /></QueryClientProvider>)); }
async function open() { await act(async () => container.querySelector("button")!.click()); await vi.waitFor(() => expect(container.querySelectorAll("option").length).toBeGreaterThan(3)); }
async function fill() {
  await act(async () => {
    [...container.querySelectorAll("input")].forEach((input, index) => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, ["BUG-1", "REVIEW-1", "QA-2"][index]);
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    [...container.querySelectorAll("select")].forEach((select, index) => { select.value = ["dev", "review", "qa"][index]; select.dispatchEvent(new Event("change", { bubbles: true })); });
  });
}
async function submit() { await act(async () => { container.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })); }); }
it("loads seats on expansion, excludes self review and pins authorization to the viewed failed version", async () => {
  await render(); expect(api.seats).not.toHaveBeenCalled(); await open(); await fill();
  const reviewer = container.querySelectorAll("select")[1];
  expect(reviewer.querySelector<HTMLOptionElement>('option[value="dev"]')!.disabled).toBe(true);
  const newer = fixture(); newer.stages[0].receiptDigest = "new-digest"; await render(newer);
  await submit(); await vi.waitFor(() => expect(changed).toHaveBeenCalledOnce());
  expect(api.repair).toHaveBeenCalledExactlyOnceWith("company", "flow", { expectedReceiptDigest: "old-digest", defectKey: "BUG-1", reviewKey: "REVIEW-1", retestKey: "QA-2", developmentSeatId: "dev", reviewSeatId: "review", qaSeatId: "qa" });
});
it("keeps conflict errors visible and never silently retries a repair", async () => {
  api.repair.mockRejectedValue(new Error("当前失败版本已变化"));
  await render(); await open(); await fill(); await submit();
  await vi.waitFor(() => expect(container.querySelector('[role="alert"]')?.textContent).toContain("当前失败版本已变化"));
  expect(api.repair).toHaveBeenCalledOnce(); expect(changed).not.toHaveBeenCalled();
});
it("stops at three repair rounds without loading seats", async () => {
  const workflow = fixture(); workflow.stages[0].repairHistory = Array.from({ length: 3 }, (_, index) => ({ attempt: index + 1 })) as NonNullable<DeliveryStageRecord["repairHistory"]>;
  await render(workflow); expect(container.textContent).toContain("已达到修复上限");
  expect(container.querySelector("button")).toBeNull(); expect(api.seats).not.toHaveBeenCalled(); expect(api.repair).not.toHaveBeenCalled();
});
