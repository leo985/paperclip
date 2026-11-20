// @vitest-environment jsdom
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DeliveryPlan, DeliveryWorkItem } from "@paperclipai/shared";
import { DeliveryEntries } from "./DeliveryEntries";

const state = vi.hoisted(() => ({
  companyId: "company-a",
  params: new URLSearchParams("snapshotId=entry-a"),
  breadcrumbs: vi.fn(),
  setParams: vi.fn(),
  hasAnalysis: true,
  plan: {} as Partial<DeliveryPlan>,
  hash: "",
  locationKey: "entry",
  canManage: true,
  multipleProjects: false,
}));
vi.mock("@/context/CompanyContext", () => ({ useCompany: () => ({ selectedCompanyId: state.companyId }) }));
vi.mock("@/context/BreadcrumbContext", () => ({ useBreadcrumbs: () => ({ setBreadcrumbs: state.breadcrumbs }) }));
vi.mock("@/hooks/useManagementAccess", () => ({ useManagementAccess: () => ({ canManage: state.canManage }) }));
vi.mock("@/lib/router", () => ({
  Link: ({ children, to, ...props }: any) => <a href={to} {...props}>{children}</a>,
  useSearchParams: () => [state.params, state.setParams],
  useLocation: () => ({ hash: state.hash, key: state.locationKey }),
}));
// Return data synchronously to cover navigation to an already cached entry.
vi.mock("@tanstack/react-query", () => ({ useQuery: ({ queryKey }: any) => ({
  isSuccess: true,
  refetch: vi.fn(),
  data: queryKey[0] === "delivery-entry" ? {
    snapshot: { id: state.params.get("snapshotId"), projectId: "project", demandNo: "DEMAND-1", collectedAt: "2026-11-06", plan: { title: "条目", roles: [], differences: [], mains: [], items: [], sourceAnalysis: { sourceStatus: "需求评审通过", analysisSaved: true, reviewStages: [] }, ...state.plan } },
    chainAdmission: { ready: true },
    analyses: state.hasAnalysis ? [{ id: "analysis-a", title: "分析报告", revision: 2, state: "published", updatedAt: "2026-11-06" }] : [],
    tasks: [],
  } : queryKey[0] === "delivery-projects" ? [{ id: state.companyId === "company-b" ? "project-b" : "project", name: "DSP" }, ...(state.multipleProjects ? [{ id: "project-two", name: "第二项目" }] : [])] : [],
}) }));
vi.mock("@/components/DeliveryWorkflowPanel", () => ({
  DeliveryWorkflowPanel: ({ startRequested, initialReviewKey }: { startRequested: boolean; initialReviewKey?: string }) => <div data-start-requested={String(startRequested)} data-review-key={initialReviewKey} />,
}));
vi.mock("@/components/DeliveryAdmissionPanel", () => ({ DeliveryAdmissionPanel: () => null }));

vi.mock("@/components/DeliveryWorkDispatch", () => ({ DeliveryWorkDispatch: () => <section aria-label="主子工单与执行" /> }));
vi.mock("@/components/DeliveryMonthlyBoard", () => ({ DeliveryMonthlyBoard: ({ projectId }: any) => <section aria-label="月度清单" data-project-id={projectId} /> }));
vi.mock("@/components/DeliveryDemandLookup", () => ({ DeliveryDemandLookup: () => <section aria-label="按条目编号精确查询" /> }));
vi.mock("./DeliveryIntake", () => ({ DeliverySourcePlan: () => <section aria-label="重复来源工单表" />, DeliverySources: () => null }));

let root: Root;
let container: HTMLDivElement;
function render() { flushSync(() => root.render(<DeliveryEntries />)); }
function mount() {
  localStorage.clear();
  state.multipleProjects = false;
  state.companyId = "company-a";
  state.canManage = true;
  state.hasAnalysis = true;
  state.plan = {};
  state.hash = "";
  state.locationKey = "entry";
  state.params = new URLSearchParams("snapshotId=entry-a");
  state.setParams.mockReset().mockImplementation(update => { state.params = update(state.params); });
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
  it("opens and scrolls to the plan from a work link without requesting generation", async () => {
    mount();
    state.params.set("tab", "work");
    state.hash = "#delivery-workflow";
    state.locationKey = "plan";
    render();
    const panel = container.querySelector<HTMLDetailsElement>("#delivery-workflow")!;
    await vi.waitFor(() => expect(panel.open).toBe(true));
    expect(container.querySelector("[data-start-requested]")?.getAttribute("data-start-requested")).toBe("false");
    panel.scrollIntoView = vi.fn();
    vi.mocked(requestAnimationFrame).mock.lastCall?.[0](0);
    expect(panel.scrollIntoView).toHaveBeenCalledWith({ block: "start" });
  });

  it("opens delivery configuration with the review selected from the work table", async () => {
    mount(); state.params = new URLSearchParams("snapshotId=entry-a&tab=work&reviewKey=REVIEW-1"); render();
    await vi.waitFor(()=>expect(container.querySelector("details")?.open).toBe(true));
    expect(container.querySelector("[data-review-key]")?.getAttribute("data-review-key")).toBe("REVIEW-1");
    expect(container.querySelector("[data-start-requested]")?.getAttribute("data-start-requested")).toBe("true");
  });
  it("renders one work and execution view without a repeated source tree or task list", () => {
    mount(); state.params = new URLSearchParams("snapshotId=entry-a&tab=work"); render();
    expect(container.querySelectorAll('[aria-label="主子工单与执行"]')).toHaveLength(1);
    expect(container.querySelector('[aria-label="重复来源工单表"]')).toBeNull();
    expect(container.textContent).not.toContain("平台任务与运行");
    expect(container.textContent).toContain("待核对差异");
  });
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
    state.params.set("tab", "materials"); render();
    expect(container.querySelector("details")?.open).toBe(true);
    state.companyId = "company-b"; render();
    expectClosed();
  });
});

it("keeps one monthly board through permission and filter rerenders", () => {
  const errors = vi.spyOn(console, "error").mockImplementation(() => {});
  try {
    mount(); errors.mockClear();
    state.params = new URLSearchParams("projectId=project&month=2026-11");
    for (let i = 0; i < 4; i++) {
      state.canManage = false; render();
      expect(container.querySelectorAll('[aria-label="按条目编号精确查询"]')).toHaveLength(0);
      state.canManage = true; state.params.set("mq", String(i)); render();
      expect(container.querySelectorAll('[aria-label="按条目编号精确查询"]')).toHaveLength(0);
      expect(container.querySelectorAll('[aria-label="月度清单"]')).toHaveLength(1);
    }
    expect(errors.mock.calls.filter(args => /same key/.test(args.join(" ")))).toEqual([]);
  } finally { errors.mockRestore(); }
});

it("inherits the sidebar company project and discards another company's stale project parameter", () => {
  mount();
  state.params = new URLSearchParams("month=2026-11"); render();
  expect(container.querySelector('[aria-label="月度排期项目"]')).toBeNull();
  expect(container.querySelector('[data-project-id]')?.getAttribute("data-project-id")).toBe("project");
  state.companyId = "company-b";
  state.params.set("projectId", "project"); render();
  expect(container.querySelector('[aria-label="月度排期项目"]')).toBeNull();
  expect(container.querySelector('[data-project-id]')?.getAttribute("data-project-id")).toBe("project-b");
});

describe("delivery entry analysis stage", () => {
  const panel = '[aria-label="需求分析 · 关联工单与任务"]';

  it("consolidates analysis under the stage cards and keeps the current tab and keyboard focus", () => {
    mount();
    state.params.set("tab", "work");
    state.plan = { items: [{ key: "ANALYSIS-1", parentKey: "MAIN-1", status: "已完成", title: "需求拆解", type: "需求分析", scheduled: true, assignee: "" }] };
    render();
    const tabs = container.querySelector('nav[aria-label="条目详情视图"]')!;
    expect([...tabs.querySelectorAll("button")].map(button => button.textContent)).toEqual(["交付概览", "工单与执行"]);
    expect(container.querySelector(panel)).toBeNull();
    const stage = container.querySelector<HTMLButtonElement>('[aria-label="选择条目交付阶段"] button')!;
    stage.focus();
    flushSync(() => stage.click());
    render();

    expect(state.params.get("tab")).toBe("work");
    expect(state.params.get("stage")).toBe("analysis");
    expect(stage.getAttribute("aria-pressed")).toBe("true");
    expect(document.activeElement).toBe(stage);
    const analysis = container.querySelector('[aria-label="条目阶段交付总览"] ' + panel)!;
    expect(analysis.querySelector('[aria-label="轻舟需求分析与评审"]')).not.toBeNull();
    expect(analysis.querySelector('a[href*="executionId=analysis-a"]')?.textContent).toContain("分析报告 · 修订 2 · 最新");
    expect(analysis.textContent).toContain("ANALYSIS-1");
    expect(analysis.textContent).toContain("创建或查看分析任务");
    expect(container.querySelectorAll(panel)).toHaveLength(1);
    expect(container.querySelector('[aria-label="主子工单与执行"]')).not.toBeNull();
  });

  it("shows the empty state and the source review in the upper panel", () => {
    mount();
    state.hasAnalysis = false;
    state.params.set("stage", "analysis");
    render();
    const analysis = container.querySelector(panel);
    expect(analysis?.textContent).toContain("无需求分析任务");
    expect(analysis?.textContent).toContain("需求评审通过");
    expect(container.textContent).toContain("条目交付进度");
  });

  it("scrolls to the stage panel when linked from delivery materials", () => {
    mount();
    state.params.set("stage", "analysis");
    render();
    const analysis = container.querySelector<HTMLElement>(panel)!;
    analysis.scrollIntoView = vi.fn();
    state.hash = "#delivery-entry-analysis";
    render();
    expect(analysis.scrollIntoView).toHaveBeenCalledWith({ block: "start" });
  });

  it("opens analysis in the upper panel for old tab links and keeps it open on tab changes", () => {
    mount();
    state.params.set("tab", "analysis");
    state.params.set("stage", "design");
    render();
    expect(container.querySelector(panel)).not.toBeNull();
    const work = [...container.querySelectorAll<HTMLButtonElement>('nav[aria-label="条目详情视图"] button')]
      .find(button => button.textContent === "工单与执行")!;
    flushSync(() => work.click());
    render();
    expect(state.params.get("tab")).toBe("work");
    expect(state.params.get("stage")).toBe("analysis");
    expect(container.querySelector(panel)).not.toBeNull();
  });
});

describe("delivery entry overview", () => {
  function work(key: string, parentKey: string | null, status: string): DeliveryWorkItem {
    return { key, parentKey, status, title: key, type: "系统设计", scheduled: true, assignee: "" };
  }

  it("counts each eligible Jira child once across all parents and only prompts for actionable items", () => {
    mount();
    state.plan = {
      items: [
        work("MAIN-1", null, "部分交付"),
        work("DONE-1", "MAIN-1", "已关闭"),
        work("DONE-1", "MAIN-1", "已关闭"),
        work("VOID-1", "MAIN-1", "已取消"),
        work("LATE-2", "MAIN-2", "待受理"),
        work("OPEN-2", "MAIN-2", "设计中"),
      ],
      monthlyChildIssues: { issues: {
        "LATE-2": { dueDate: "2020-01-01", deadlineSource: "child", account: "", done: false, cancelled: false },
      } },
    };
    render();
    const progress = container.querySelector('[aria-label="条目交付进度"]');
    expect(progress?.textContent).toContain("33%");
    expect(progress?.querySelector('[role="progressbar"]')?.getAttribute("aria-valuemax")).toBe("3");
    const groups = progress?.querySelector('[aria-label="各主工单完成进度"]');
    expect(groups?.children[0]?.textContent).toContain("MAIN-1已完成 1 / 1");
    expect(groups?.children[1]?.textContent).toContain("MAIN-2已完成 0 / 2");
    const attention = container.querySelector('[aria-label="需要处理"]');
    expect(attention?.textContent).toContain("已逾期 · LATE-2");
    expect(attention?.textContent).not.toContain("OPEN-2");
    expect(container.textContent).not.toContain("新增编码准入与结论登记");
    const risk = attention?.querySelector<HTMLButtonElement>("button")!;
    flushSync(() => risk.click());
    render();
    expect(state.params.get("tab")).toBe("work");
    expect(container.textContent).toContain("新增编码准入与结论登记");
  });

  it("shows progress without an attention panel when there is no action to take", () => {
    mount();
    state.plan = { items: [work("DONE", "MAIN", "已完成")] };
    state.params.set("stage", "design");
    render();
    expect(container.querySelector('[aria-label="条目交付进度"]')?.textContent).toContain("100%");
    expect(container.querySelector('[aria-label="需要处理"]')).toBeNull();
  });
});


describe("delivery project preference", () => {
  it("remembers a selection after returning through the sidebar and remounting", () => {
    mount(); state.multipleProjects = true; state.params = new URLSearchParams(); render();
    const select = container.querySelector<HTMLSelectElement>('[aria-label="月度排期项目"]')!;
    flushSync(() => { select.value = "project-two"; select.dispatchEvent(new Event("change", { bubbles: true })); });
    state.params = new URLSearchParams("snapshotId=entry-a"); render();
    state.params = new URLSearchParams(); render();
    expect(container.querySelector('[data-project-id]')?.getAttribute("data-project-id")).toBe("project-two");
  });
  it("lets an explicit project link override the remembered selection", () => {
    mount(); state.multipleProjects = true;
    localStorage.setItem("zhiyan:delivery-project:company-a", "project-two");
    state.params = new URLSearchParams("projectId=project"); render();
    expect(container.querySelector('[data-project-id]')?.getAttribute("data-project-id")).toBe("project");
    state.params = new URLSearchParams(); render();
    expect(container.querySelector('[data-project-id]')?.getAttribute("data-project-id")).toBe("project");
  });
  it("does not restore a project absent from the current company's active list", () => {
    mount(); state.multipleProjects = true;
    localStorage.setItem("zhiyan:delivery-project:company-a", "archived-project");
    state.params = new URLSearchParams(); render();
    expect(container.querySelector('[data-project-id]')).toBeNull();
    localStorage.setItem("zhiyan:delivery-project:company-a", "project");
    state.companyId = "company-b"; render();
    expect(container.querySelector('[data-project-id]')).toBeNull();
  });
  it("forgets the selection when the user chooses the empty option", () => {
    mount(); state.multipleProjects = true; state.params = new URLSearchParams("projectId=project"); render();
    const select = container.querySelector<HTMLSelectElement>('[aria-label="月度排期项目"]')!;
    flushSync(() => { select.value = ""; select.dispatchEvent(new Event("change", { bubbles: true })); });
    render();
    expect(container.querySelector('[data-project-id]')).toBeNull();
    expect(localStorage.getItem("zhiyan:delivery-project:company-a")).toBeNull();
  });
});


it("opens the merged work view from legacy evidence links", () => {
  mount();
  state.params.set("tab", "materials");
  render();
  const activeTab = container.querySelector('[aria-label="条目详情视图"] button[aria-pressed="true"]');
  expect(activeTab?.textContent).toBe("工单与执行");
  expect(container.querySelector('[aria-label="主子工单与执行"]')).not.toBeNull();
  expect(container.querySelector('[aria-label="正式验收"]')).not.toBeNull();
});
