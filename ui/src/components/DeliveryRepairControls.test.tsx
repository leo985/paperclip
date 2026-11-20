// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { DEFAULT_DELIVERY_TEMPLATE, type DeliveryStageRecord, type DeliveryWorkflow } from "@paperclipai/shared";
import { DeliveryRepairControls } from "./DeliveryRepairControls";

const api = vi.hoisted(() => ({ seats: vi.fn(), repair: vi.fn() }));
vi.mock("@/api/delivery-workflows", () => ({ deliveryWorkflowApi: api }));
let container: HTMLDivElement, root: ReturnType<typeof createRoot>, client: QueryClient;
const changed = vi.fn();
function fixture(): DeliveryWorkflow {
  const stage: DeliveryStageRecord = { stage: "functional-test", taskId: "test", seatId: "qa", ownerUserId: "owner", jiraKey: "QA-1", dispatchId: "dispatch", state: "review", runId: "run", capabilityId: "cap", registryRevision: 1, inputDigest: "input", receiptDigest: "old-digest", review: null, message: null, receipt: { protocolVersion: 1, taskId: "test", runId: "run", stage: "functional-test", jiraKey: "QA-1", inputDigest: "input", stateDigest: "state", trackerReceiptId: "42", jiraReference: "https://jira.example/browse/QA-1", artifacts: [], testResults: { total: 1, passed: 0, failed: 1, blocked: 0, skipped: 0, testedVersion: "build", sourcePath: "execution-records.md", sourceSha256: "hash" } } };
  stage.parentKey="MAIN-1";
  stage.receipt!.failureReport={sourcePath:"delivery-failures.json",sourceSha256:"hash",defects:[{caseId:"C1",module:"payments",kind:"product",summary:"failure",steps:"reproduce",expected:"pass",actual:"fail"}]};
  const work={...stage,stage:"coding" as const,taskId:"work",seatId:"dev",jiraKey:"CODE-1",state:"done" as const,receipt:null};
  const review={...work,taskId:"review",seatId:"review",jiraKey:"REVIEW-1",intent:"code-review" as const,reviewWorkKeys:["CODE-1"]};
  const definition=structuredClone(DEFAULT_DELIVERY_TEMPLATE);definition.automaticRepair={maxCycles:2,buildObservationUrl:"https://env.example/version",routes:[{module:"payments",developmentSeatId:"dev",reviewSeatId:"review",qaSeatId:"qa"}]};
  return { id: "flow", companyId: "company", projectId: "project", snapshotId: "snapshot", demandNo: "DEMAND", fingerprint: "fingerprint", createdBy: "owner", state: "blocked", config: {template:{id:"template",revision:1,scope:"project",definition}} as DeliveryWorkflow["config"], stages: [work,review,stage], message: null, acceptance: null, createdAt: "now", updatedAt: "now" };
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

async function submit() {await act(async()=>container.querySelector("button")!.click());}
it("uses only the original tickets and seats without manual ticket inputs",async()=>{
 await render();expect(container.textContent).toContain("CODE-1");expect(container.textContent).toContain("REVIEW-1");expect(container.textContent).toContain("QA-1");
 expect(container.querySelector("input,select")).toBeNull();expect(api.seats).not.toHaveBeenCalled();
 await submit();await vi.waitFor(()=>expect(changed).toHaveBeenCalledOnce());
 expect(api.repair).toHaveBeenCalledExactlyOnceWith("company","flow",{expectedReceiptDigest:"old-digest",defectKey:"CODE-1",reviewKey:"REVIEW-1",retestKey:"QA-1",developmentSeatId:"dev",reviewSeatId:"review",qaSeatId:"qa"});
});
it("does not permit substitute work when the original review is missing",async()=>{
 const workflow=fixture();workflow.stages=workflow.stages.filter(s=>s.taskId!=="review");await render(workflow);
 expect(container.querySelector("button")?.disabled).toBe(true);expect(container.textContent).toContain("无法唯一定位");expect(api.repair).not.toHaveBeenCalled();
});
it("keeps conflict errors visible without silently retrying",async()=>{
 api.repair.mockRejectedValue(new Error("当前失败版本已变化"));await render();await submit();
 await vi.waitFor(()=>expect(container.querySelector('[role="alert"]')?.textContent).toContain("当前失败版本已变化"));
 expect(api.repair).toHaveBeenCalledOnce();expect(changed).not.toHaveBeenCalled();
});
it("stops at the configured round limit",async()=>{
 const workflow=fixture();workflow.stages[2].repairHistory=Array.from({length:2},(_,index)=>({attempt:index+1})) as NonNullable<DeliveryStageRecord["repairHistory"]>;
 await render(workflow);expect(container.textContent).toContain("已达到返工上限");expect(container.querySelector("button")).toBeNull();expect(api.repair).not.toHaveBeenCalled();
});
