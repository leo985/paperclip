// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, useLocation, useNavigate } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DeliveryEntryDetail, DeliveryStageRecord, DeliveryWorkflow, DeliveryMonthlyEntries, Project } from "@paperclipai/shared";
import { DeliveryEntryEvidence, deliveryEvidenceRecords, type DeliveryEvidenceState } from "./DeliveryMaterials";
import { DeliveryWorkDispatch } from "./DeliveryWorkDispatch";
import { ProjectReadiness } from "./ProjectReadiness";
import { DeliveryMonthlyBoard } from "./DeliveryMonthlyBoard";
const mocks = vi.hoisted(() => ({ analysis: vi.fn(), get: vi.fn(), post: vi.fn(), seats: vi.fn() }));
vi.mock("@/lib/router", () => import("react-router-dom"));
vi.mock("@/api/analysis-executions", () => ({ analysisApi: { detail: mocks.analysis } }));
vi.mock("@/api/client", () => ({ api: { get: mocks.get, post: mocks.post } }));
vi.mock("@/api/dsp7-seats", () => ({ dsp7SeatsApi: { list: mocks.seats } }));
const detail = {
  snapshot: {
    id: "snapshot", projectId: "p1", collectedAt: "2026-10-27",
    plan: { mains: [], items: [{ key: "DSP-1", parentKey: "DSP-10", type: "系统设计", status: "已完成" }] },
  },
  analyses: [],
} as unknown as DeliveryEntryDetail;
const stage: DeliveryStageRecord = { stage: "design", taskId: "t1", seatId: "s1", ownerUserId: "u1", jiraKey: "DSP-1", dispatchId: "d1", state: "done", runId: "r1", capabilityId: null, registryRevision: null, inputDigest: "input", receiptDigest: "receipt", receipt: { protocolVersion: 1, taskId: "t1", runId: "r1", stage: "design", jiraKey: "DSP-1", inputDigest: "input", stateDigest: "state", trackerReceiptId: "tracker", jiraReference: "https://jira.example.com/DSP-1", artifacts: [{ path: "design.md", sha256: "hash" }] }, review: { decision: "approve", digest: "receipt", reference: "https://jira.example.com/review", note: "", by: "u1", at: "2026-10-27" }, message: null };
let cleanup: (() => void) | undefined;
beforeEach(() => { vi.resetAllMocks(); mocks.get.mockResolvedValue(null); mocks.seats.mockResolvedValue([]); });
afterEach(async () => { await act(async () => cleanup?.()); cleanup = undefined; });
async function mount(element: React.ReactNode, client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } })) {
  const node = document.createElement("div"); document.body.append(node); const root = createRoot(node);
  await act(async () => root.render(<QueryClientProvider client={client}><MemoryRouter initialEntries={["/?month=2026-10"]}>{element}</MemoryRouter></QueryClientProvider>));
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 25)); });
  cleanup = () => { root.unmount(); client.clear(); node.remove(); }; return node;
}
function workAndEvidence(entry = detail, workflows: DeliveryWorkflow[] = [], workflowState: DeliveryEvidenceState = "ready") {
  const records = deliveryEvidenceRecords(workflows);
  const { snapshot } = entry;
  return <>
    <DeliveryWorkDispatch plan={snapshot.plan} tasks={[]} admission={null} projectId={snapshot.projectId} snapshotId={snapshot.id} canManage records={records} workflowState={workflowState} />
    <DeliveryEntryEvidence companyId="c1" detail={entry} records={records} workflows={workflows} workflowState={workflowState} />
  </>;
}
function materials(record = stage) { return workAndEvidence(detail, [{ stages: [record] } as DeliveryWorkflow]); }
function SearchNavigation() {
  const location=useLocation(),navigate=useNavigate();
  return <><output aria-label="当前查询参数">{location.search}</output><button onClick={()=>navigate("?month=2026-10&mq=需求")}>打开历史关键词</button><button onClick={()=>navigate(-1)}>返回上次筛选</button></>;
}
function inputValue(input: HTMLInputElement, value: string, isComposing=false) {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,"value")!.set!.call(input,value);
  input.dispatchEvent(new InputEvent("input",{bubbles:true,inputType:"insertText",data:value,isComposing}));
}

describe("management evidence and scheduling interactions", () => {
  it("keeps IME composition local, filters committed Chinese text and restores cleared or historical keywords", async () => {
    const client=new QueryClient({defaultOptions:{queries:{retry:false,staleTime:Infinity,gcTime:0}}});
    client.setQueryData(["delivery-connection","c1","p1"],{revision:1,credentialsConfigured:true});
    const rows:DeliveryMonthlyEntries["items"]=["需求设计","编码开发"].map((title,i)=>({demandNo:`DSP-${i}`,title,owner:"李工",sourceStatus:"开发中",startDate:"2026-10-01",endDate:"2026-10-31",workCount:1,snapshotId:`s-${i}`,admission:null}));
    client.setQueryData(["delivery-monthly","c1","p1",1,"2026-10"],{month:"2026-10",collectedAt:"2026-10-27",items:rows});
    const node=await mount(<><DeliveryMonthlyBoard companyId="c1" projectId="p1" canManage/><SearchNavigation/></>,client);
    const input=node.querySelector<HTMLInputElement>('[aria-label="月度条目搜索"]')!;
    input.focus();
    await act(async()=>input.dispatchEvent(new CompositionEvent("compositionstart",{bubbles:true})));
    for(const value of ["x","xu","需求"]){
      await act(async()=>inputValue(input,value,true));
      expect(input.value).toBe(value);expect(document.activeElement).toBe(input);
      expect(node.querySelector('[aria-label="当前查询参数"]')?.textContent).not.toContain("mq=");
      expect(node.querySelectorAll("tbody tr")).toHaveLength(2);
    }
    await act(async()=>input.dispatchEvent(new CompositionEvent("compositionend",{bubbles:true,data:"需求"})));
    expect(new URLSearchParams(node.querySelector('[aria-label="当前查询参数"]')!.textContent!).get("mq")).toBe("需求");
    expect(input.value).toBe("需求");expect(node.querySelectorAll("tbody tr")).toHaveLength(1);
    await act(async()=>inputValue(input,"DSP-1"));
    expect(node.querySelector("tbody")?.textContent).toContain("编码开发");
    const clear=[...node.querySelectorAll("button")].find(b=>b.textContent==="清除筛选")!;
    await act(async()=>clear.click());expect(input.value).toBe("");expect(node.querySelectorAll("tbody tr")).toHaveLength(2);
    // URL navigation and browser history both update the local input draft.
    await act(async()=>[...node.querySelectorAll("button")].find(b=>b.textContent==="打开历史关键词")!.click());
    expect(input.value).toBe("需求");expect(node.querySelectorAll("tbody tr")).toHaveLength(1);
    await act(async()=>[...node.querySelectorAll("button")].find(b=>b.textContent==="返回上次筛选")!.click());
    expect(input.value).toBe("");expect(node.querySelectorAll("tbody tr")).toHaveLength(2);
    expect(mocks.post).not.toHaveBeenCalled();
  });
  it("requires a matching input and run before declaring a reviewed stage delivered", async () => {
    const node = await mount(materials({ ...stage, receipt: { ...stage.receipt!, runId: "old-run" } }));
    expect(node.textContent).toContain("材料版本待重新核对"); expect(node.textContent).not.toContain("本阶段已核验交付");
    expect(node.querySelector('a[href="/issues/t1"]')).toBeTruthy();
  });
  it("requires approval of this receipt version and keeps formal acceptance separate", async () => {
    const node = await mount(materials({ ...stage, review: { ...stage.review!, digest: "old-version" } }));
    expect(node.textContent).toContain("本版本待正式评审核验"); expect(node.textContent).toContain("尚未登记正式验收结论");
  });
  it("shows a matching approved receipt as stage evidence without inferring formal acceptance", async () => {
    const node = await mount(materials()); expect(node.textContent).toContain("本阶段已核验交付"); expect(node.textContent).toContain("尚未登记正式验收结论");
  });
  it("keeps each main issue's attachments and review conclusions with the correct Jira child", async () => {
    const withTwoParents = {
      ...detail,
      snapshot: {
        ...detail.snapshot,
        plan: { ...detail.snapshot.plan, items: [
          ...detail.snapshot.plan.items,
          { key: "DSP-2", parentKey: "DSP-20", type: "代码评审", status: "已完成", title: "代码评审", assignee: "", scheduled: true },
          { key: "DSP-3", parentKey: "DSP-20", type: "功能测试", status: "待受理", title: "功能测试", assignee: "", scheduled: false },
        ] },
      },
    };
    const secondRecord: DeliveryStageRecord = {
      ...stage, stage: "coding", intent: "code-review", taskId: "t2", jiraKey: "DSP-2", receipt: null, receiptDigest: null, review: null,
      priorCompletion: { stage: "coding", jiraKey: "DSP-2", source: "jira", version: "version-2", artifactReferences: [],
        reviewReference: "https://jira.example.com/browse/DSP-2", by: "u1", at: "2026-10-27", snapshotId: "snapshot",
        jiraEvidence: { status: "已完成", updated: "2026-10-27", reviewResult: "代码评审：通过", artifacts: [], comments: [] } },
    };
    const workflows = [{ stages: [stage] }, { stages: [secondRecord] }] as DeliveryWorkflow[];
    const node = await mount(workAndEvidence(withTwoParents, workflows));
    const first = node.querySelector('[aria-label="主工单 DSP-10"]')!;
    const second = node.querySelector('[aria-label="主工单 DSP-20"]')!;
    expect(first.textContent).toContain("design.md");
    expect(first.textContent).not.toContain("代码评审：通过");
    expect(second.textContent).toContain("Jira 结果描述：代码评审：通过");
    expect(second.textContent).toContain("已复用历史交付");
    expect(second.textContent).toContain("待受理");
    const reviewRow = [...second.querySelectorAll("tbody tr")].find(row => row.textContent?.includes("DSP-2 ·"));
    expect(reviewRow?.textContent).toContain("Jira 结果描述：代码评审：通过");
    expect(second.querySelectorAll("tbody tr")).toHaveLength(2);
    expect(second.textContent).not.toContain("design.md");
    expect(second.querySelector('a[href="https://jira.example.com/browse/DSP-2"]')).not.toBeNull();
  });

  it("does not report missing acceptance when workflow records cannot be read", async () => {
    const node = await mount(workAndEvidence(detail, [], "unavailable"));
    expect(node.textContent).toContain("正式验收记录待核实"); expect(node.textContent).not.toContain("尚未登记正式验收结论");
    expect(node.textContent).toContain("流程交付回执待核实");
    const analysisLink = node.querySelector<HTMLAnchorElement>('a[href*="stage=analysis"]');
    expect(analysisLink?.hash).toBe("#delivery-entry-analysis");
    expect(analysisLink?.search).not.toContain("tab=analysis");
  });
  it("reads independent analysis only when expanded and surfaces an authorization failure", async () => {
    mocks.analysis.mockRejectedValue(new Error("403"));
    const node = await mount(workAndEvidence({ ...detail, analyses: [{ id: "a1", title: "分析修订", revision: 1 }] as DeliveryEntryDetail["analyses"] }));
    expect(mocks.analysis).not.toHaveBeenCalled();
    const target = node.querySelector<HTMLDetailsElement>('[aria-label="条目级需求分析材料"] details')!;
    await act(async () => { target.open = true; target.dispatchEvent(new Event("toggle")); });
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 25)); });
    expect(mocks.analysis).toHaveBeenCalledWith("c1", "a1"); expect(node.textContent).toContain("材料索引读取失败或无访问权限");
  });
  it("never equates saved repository and baseline configuration with successful access", async () => {
    const project = { id: "p1", companyId: "c1", workspaces: [{ repoUrl: "https://gitlab.example.com/group/project.git", repoRef: "main" }] } as unknown as Project;
    const node = await mount(<ProjectReadiness project={project} />);
    expect(node.textContent).toContain("1 个仓库 · 1 个已配置基线"); expect(node.textContent).toContain("仓库访问由执行电脑核验"); expect(node.textContent).toContain("尚未配置"); expect(mocks.post).not.toHaveBeenCalled();
  });
  it("filters risks across the whole month before paging and preserves the entry context", async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity, gcTime: 0 } } });
    client.setQueryData(["delivery-connection", "c1", "p1"], { revision: 1, credentialsConfigured: true });
    const rows: DeliveryMonthlyEntries["items"] = Array.from({ length: 25 }, (_, i) => ({ demandNo: `DSP-${i}`, title: "排期条目", owner: i === 24 ? "" : "李工", sourceStatus: "开发中", startDate: "2026-10-01", endDate: "2026-10-31", workCount: 1, snapshotId: `snapshot-${i}`, admission: null }));
    client.setQueryData(["delivery-monthly", "c1", "p1", 1, "2026-10"], { month: "2026-10", collectedAt: "2026-10-27", items: rows });
    const node = await mount(<DeliveryMonthlyBoard companyId="c1" projectId="p1" canManage />, client);
    expect(node.querySelectorAll("tbody tr")).toHaveLength(20);
    const button = [...node.querySelectorAll("button")].find(b => b.textContent?.startsWith("责任人缺失"))!;
    expect(button.textContent).toContain("1"); await act(async () => button.click());
    expect(node.querySelectorAll("tbody tr")).toHaveLength(1); expect(node.querySelector("tbody")?.textContent).toContain("DSP-24");
    const link = node.querySelector<HTMLAnchorElement>('tbody a')!; const params = new URL(link.href).searchParams;
    expect(params.get("mRisk")).toBe("missing_owner"); expect(params.get("month")).toBe("2026-10"); expect(params.get("projectId")).toBe("p1"); expect(params.get("snapshotId")).toBe("snapshot-24");
    expect(mocks.post).not.toHaveBeenCalled();
  });
});
