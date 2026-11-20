// @vitest-environment jsdom
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  DEFAULT_DELIVERY_TEMPLATE,
  type DeliveryAutomaticPlan,
  type DeliverySnapshot,
  type DeliveryWorkflow,
} from "@paperclipai/shared";
import { deliveryPlanPreviewQuery } from "@/api/delivery-workflows";
import { AutomaticDeliveryStart } from "./AutomaticDeliveryStart";
const mocks = vi.hoisted(() => ({ plan: vi.fn(), start: vi.fn(), savedPlan: vi.fn(), initialPlan: vi.fn() }));
vi.mock("@/api/delivery-workflows", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/api/delivery-workflows")>();
  return {
    ...actual,
    deliveryWorkflowApi: { plan: mocks.plan, automaticStart: mocks.start, savedPlan: mocks.savedPlan, initialPlan: mocks.initialPlan },
    deliveryPlanPreviewQuery: (companyId: string, snapshotId: string) => ({
      ...actual.deliveryPlanPreviewQuery(companyId, snapshotId),
      queryFn: () => mocks.savedPlan(companyId, snapshotId),
    }),
  };
});
let cleanup = () => {};
afterEach(() => cleanup());
beforeEach(() => {
  mocks.plan.mockReset();
  mocks.start.mockReset();
  mocks.savedPlan.mockReset().mockResolvedValue(null);
  mocks.initialPlan.mockReset().mockImplementation(async (company, input) => ({ input, plan: await mocks.plan(company, input) }));
});
const snapshot = {
  id: "snapshot",
  plan: { items: [], mains: [] },
} as unknown as DeliverySnapshot;
const plan = (): DeliveryAutomaticPlan => ({
  digest: "a".repeat(64),
  ready: true,
  template: {
    id: "template",
    revision: 1,
    scope: "project",
    definition: structuredClone(DEFAULT_DELIVERY_TEMPLATE),
  },
  parents: ["MAIN-1"],
  parentKey: "MAIN-1",
  nodes: [
    {
      stage: "coding",
      jiraKey: "DEV-1",
      title: "开发",
      dependsOn: [],
      mode: "seat",
      seatId: "seat",
      executor: "研发席位",
      seatChoices: [],
      startMode: "automatic",
      completionReview: false,
    },
  ],
  excluded: [],
  blockers: [],
});
function mount(s = snapshot, workflow?: DeliveryWorkflow, readOnly = false) {
  const node = document.createElement("div");
  document.body.append(node);
  const root = createRoot(node);
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  function render(current?: DeliveryWorkflow) {
    flushSync(() => root.render(
      <QueryClientProvider client={client}>
        <AutomaticDeliveryStart companyId="company" snapshot={s} workflow={current} readOnly={readOnly} />
      </QueryClientProvider>,
    ));
  }
  render(workflow);
  cleanup = () => {
    flushSync(() => root.unmount());
    client.clear();
    node.remove();
  };
  return Object.assign(node, { updateWorkflow: render, client });
}
const button = (node: HTMLElement, text: string) =>
  [...node.querySelectorAll("button")].find((b) =>
    b.textContent?.includes(text),
  )!;
const checkbox = (node: HTMLElement, label: string) =>
  [...node.querySelectorAll("label")].find(element => element.textContent?.includes(label))
    ?.querySelector<HTMLInputElement>('input[type="checkbox"]');
it("automatically previews on entry and requires explicit plan authorization before starting", async () => {
  mocks.plan.mockResolvedValue(plan());
  mocks.start.mockResolvedValue({ id: "workflow" });
  const node = mount();
  await vi.waitFor(() => expect(node.textContent).toContain("DEV-1"));
  expect(mocks.plan).toHaveBeenCalledWith("company", {
    snapshotId: "snapshot",
    entryScope: true,
    environmentReference: "",
  });
  expect(node.client.getQueryData(deliveryPlanPreviewQuery("company", snapshot.id).queryKey)).toMatchObject({
    input: { snapshotId: snapshot.id },
    plan: { digest: "a".repeat(64) },
  });
  expect(mocks.start).not.toHaveBeenCalled();
  expect(button(node, "授权并启动").disabled).toBe(true);
  flushSync(() =>
    (node.querySelector('input[type="checkbox"]') as HTMLInputElement).click(),
  );
  await vi.waitFor(() =>
    expect(button(node, "授权并启动").disabled).toBe(false),
  );
  flushSync(() => button(node, "授权并启动").click());
  await vi.waitFor(() =>
    expect(mocks.start).toHaveBeenCalledWith(
      "company",
      expect.objectContaining({
        authorized: true,
        expectedDigest: "a".repeat(64),
        plan: { snapshotId: "snapshot", entryScope: true, environmentReference: "" },
      }),
    ),
  );
  expect(mocks.plan).toHaveBeenCalledTimes(1);
});

it("reopens the saved plan and its choices without regenerating until requested", async () => {
  const saved = plan();
  saved.generatedAt = "2026-11-20T06:42:00.000Z";
  saved.parents = ["MAIN-1", "MAIN-2"];
  saved.branches = [{
    parentKey: "MAIN-1", state: "ready", canSkipTestCases: true, skipTestCases: true,
    nodes: saved.nodes, blockers: [], excluded: [],
  }, { parentKey: "MAIN-2", state: "ready", nodes: [], blockers: [], excluded: [] }];
  const input = {
    snapshotId: snapshot.id, entryScope: true, environmentReference: "",
    selectedParentKeys: ["MAIN-1"], skipTestCasesParentKeys: ["MAIN-1"],
  };
  mocks.savedPlan.mockResolvedValue({ input, plan: saved });
  mocks.plan.mockResolvedValue(saved);
  const node = mount();
  await vi.waitFor(() => expect(node.textContent).toContain("计划已保存"));
  expect(node.querySelector<HTMLInputElement>('input[aria-label="忽略 MAIN-1 测试用例编写及评审"]')?.checked).toBe(true);
  expect(checkbox(node, "本次启动 MAIN-2")?.checked).toBe(false);
  expect(mocks.initialPlan).not.toHaveBeenCalled();
  expect(mocks.plan).not.toHaveBeenCalled();
  flushSync(() => button(node, "重新生成计划").click());
  await vi.waitFor(() => expect(mocks.plan).toHaveBeenCalledOnce());
  expect(mocks.plan).toHaveBeenLastCalledWith("company", input);
});

it("keeps the previous preview visible when a new source requires explicit regeneration", async () => {
  const saved = plan();
  const input = { snapshotId: "old-snapshot", environmentReference: "", ignoredParentKeys: ["REMOVED-1"] };
  mocks.savedPlan.mockResolvedValue({ input, plan: saved });
  mocks.plan.mockResolvedValue(saved);
  const node = mount();
  await vi.waitFor(() => expect(node.textContent).toContain("条目来源已更新"));
  expect(mocks.plan).not.toHaveBeenCalled();
  expect(button(node, "授权并启动").disabled).toBe(true);
  flushSync(() => button(node, "重新生成计划").click());
  await vi.waitFor(() => expect(mocks.plan).toHaveBeenLastCalledWith("company", expect.objectContaining({
    snapshotId: snapshot.id,
    ignoredParentKeys: [],
  })));
});
it("keeps blocked plans unstartable and shows the concrete missing evidence", async () => {
  const blocked = plan();
  blocked.ready = false;
  blocked.blockers = [
    { code: "prior_evidence", jiraKey: "DEV-1", message: "DEV-1 缺少交付附件" },
  ];
  mocks.plan.mockResolvedValue(blocked);
  const node = mount();
  await vi.waitFor(() => expect(node.textContent).toContain("缺少交付附件"));
  expect(button(node, "授权并启动").disabled).toBe(true);
  expect(node.textContent).not.toContain("我已查看");
});
it("invalidates authorization after a material edit and requires a fresh preview", async () => {
  const p = plan();p.nodes.push({...p.nodes[0],stage:"functional-test",jiraKey:"TEST-1"});
  mocks.plan.mockResolvedValue(p);
  const node = mount();
  await vi.waitFor(() => expect(node.textContent).toContain("DEV-1"));
  flushSync(() =>
    (node.querySelector('input[type="checkbox"]') as HTMLInputElement).click(),
  );
  const input = node.querySelector('input[type="url"]') as HTMLInputElement;
  flushSync(() => {
    Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      "value",
    )!.set!.call(input, "https://env.example/build");
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  expect(button(node, "授权并启动").disabled).toBe(true);
  expect(node.textContent).toContain("请重新生成计划后授权");
  flushSync(() => button(node, "重新生成计划").click());
  await vi.waitFor(() =>
    expect(mocks.plan).toHaveBeenLastCalledWith("company", {
      snapshotId: "snapshot",
      entryScope: true,
      environmentReference: "https://env.example/build",
    }),
  );
  expect(button(node, "授权并启动").disabled).toBe(true);
});
it("surfaces preview and startup errors without executing another plan", async () => {
  mocks.plan.mockRejectedValue(new Error("Jira 连接失败"));
  const node = mount();
  await vi.waitFor(() => expect(node.textContent).toContain("Jira 连接失败"));
  expect(mocks.start).not.toHaveBeenCalled();
});

it("does not ask for a test environment when all tests reuse existing delivery",async()=>{
 const p=plan();p.nodes=[{...p.nodes[0],stage:"functional-test",jiraKey:"TEST-1",mode:"reuse"}];
 mocks.plan.mockResolvedValue(p);const node=mount();
 await vi.waitFor(()=>expect(node.textContent).toContain("TEST-1"));
 expect(node.querySelector('input[type="url"]')).toBeNull();
 expect(node.textContent).not.toContain('的被审工单');
});

it("explains a required environment link and hides it when its only branch is ignored", async () => {
  const preview = plan();
  const test = { ...preview.nodes[0], stage: "functional-test" as const, jiraKey: "TEST-1" };
  preview.parents = ["MAIN-1", "MAIN-2"];
  preview.nodes = [test];
  preview.branches = [
    { parentKey: "MAIN-1", state: "ready", nodes: [], blockers: [], excluded: [] },
    { parentKey: "MAIN-2", state: "blocked", canIgnore: true, nodes: [test], excluded: [],
      blockers: [{ code: "environment", message: "请提供功能测试的环境发布记录链接" }] },
  ];
  mocks.plan.mockResolvedValue(preview);
  const node = mount();
  const environmentInput = () => node.querySelector('input[aria-label="测试环境发布记录链接"]');
  await vi.waitFor(() => expect(environmentInput()).not.toBeNull());
  expect(node.textContent).toContain("TEST-1 需要执行功能测试");
  expect(node.textContent).toContain("已部署构建版本");
  flushSync(() => checkbox(node, "忽略 MAIN-2")!.click());
  expect(environmentInput()).toBeNull();
});

it("shows each main and only authorizes ready branches", async () => {
  const p = plan();
  p.parents = ["MAIN-1", "MAIN-2"];
  p.branches = [
    { parentKey: "MAIN-1", state: "ready", nodes: p.nodes, blockers: [], excluded: [] },
    { parentKey: "MAIN-2", state: "blocked", nodes: [], blockers: [{ code: "missing_review", message: "缺少评审子单" }], excluded: [] },
  ];
  mocks.plan.mockResolvedValue(p);
  mocks.start.mockResolvedValue({ id: "workflow" });
  const node = mount();
  await vi.waitFor(() => expect(node.querySelector('[aria-label="MAIN-2"]')?.textContent).toContain("缺少评审子单"));
  flushSync(() => checkbox(node, "我已核对工单范围")!.click());
  await vi.waitFor(() => expect(button(node, "授权并启动").disabled).toBe(false));
  flushSync(() => button(node, "授权并启动").click());
  await vi.waitFor(() => expect(mocks.start).toHaveBeenCalledWith("company", expect.objectContaining({ parentKeys: ["MAIN-1"] })));
});

it("shows the Jira assignee for unmatched seats, including unassigned issues", async () => {
  const preview = plan();
  const [node] = preview.nodes;
  preview.nodes = [
    { ...node, seatId: "", executor: "待匹配", jiraAssignee: "张三" },
    { ...node, jiraKey: "DEV-2", seatId: "", executor: "待匹配", jiraAssignee: "" },
  ];
  mocks.plan.mockResolvedValue(preview);
  const container = mount();
  await vi.waitFor(() => expect(container.textContent).toContain("Jira 经办人 · 张三"));
  expect(container.textContent).toContain("Jira 经办人 · 未分配");
});

it("draws plan dependencies with parallel columns and dates from the source snapshot", async () => {
  const preview = plan();
  const [node] = preview.nodes;
  preview.nodes = [
    { ...node, jiraKey: "DES-1", stage: "design", title: "系统设计" },
    { ...node, jiraKey: "DEV-1", title: "开发一", dependsOn: ["DES-1"] },
    { ...node, jiraKey: "DEV-2", title: "开发二", dependsOn: ["DES-1"] },
    { ...node, jiraKey: "REV-1", title: "代码评审", dependsOn: ["DEV-1", "DEV-2"], mode: "reuse", verificationNote: "等待前置核验" },
  ];
  mocks.plan.mockResolvedValue(preview);
  const date = { dueDate: "2026-11-20", deadlineSource: "child" as const, account: "", done: false, cancelled: false };
  const root = mount({ ...snapshot, plan: {
    ...snapshot.plan,
    items: ["已完成", "编码中", "待受理", "已完成"].map((status, index) => ({
      key: preview.nodes[index].jiraKey!, title: preview.nodes[index].title, type: "", status,
      parentKey: "MAIN-1", assignee: "", scheduled: true,
    })),
    monthlyChildIssues: { issues: { "DEV-1": date, "REV-1": { ...date, deadlineSource: "main" } } },
  } });
  await vi.waitFor(() => expect(root.querySelector("figure")).not.toBeNull());
  const chart = root.querySelector("figure")!;
  const card = (title: string) => chart.querySelector<HTMLButtonElement>(`button[title="${title}"]`)!;
  expect(card("开发一").style.gridColumn).toBe(card("开发二").style.gridColumn);
  expect(Number(card("代码评审").style.gridColumn)).toBeGreaterThan(Number(card("开发二").style.gridColumn));
  expect(chart.querySelectorAll("path[marker-end]")).toHaveLength(4);
  expect(card("开发一").textContent).toContain("期望结束 2026-11-20");
  expect(card("开发二").textContent).toContain("结束日期待定");
  expect(card("代码评审").textContent).toContain("主单排期 2026-11-20");
  expect(card("系统设计").textContent).toContain("已完成");
  expect(card("开发一").textContent).toContain("进行中");
  expect(card("开发二").textContent).toContain("未开始");
  expect(card("代码评审").textContent).toContain("Jira 已完成 · 待核验");
  flushSync(() => card("开发一").click());
  expect(chart.querySelector('[role="status"]')?.textContent).toContain("DEV-1 · 前置 DES-1 · 后续 REV-1");
});

it("authorizes selected mains and explicit exclusions separately", async () => {
  const p = plan();
  p.parents = ["MAIN-1", "MAIN-2", "MAIN-3", "MAIN-4"];
  const branches = p.parents.map(parentKey => ({
    parentKey, state: "ready" as const, canIgnore: true, nodes: [], blockers: [], excluded: [],
  }));
  mocks.plan.mockImplementation(async (_company, input) => ({
    ...p,
    branches: branches.map(branch => input.ignoredParentKeys?.includes(branch.parentKey)
      ? { ...branch, state: "ignored" }
      : branch),
  }));
  mocks.start.mockResolvedValue({ id: "workflow" });
  const node = mount();
  await vi.waitFor(() => expect(checkbox(node, "本次启动 MAIN-4")).toBeDefined());
  flushSync(() => checkbox(node, "本次启动 MAIN-2")!.click());
  flushSync(() => checkbox(node, "忽略 MAIN-3")!.click());
  flushSync(() => button(node, "重新生成计划").click());
  await vi.waitFor(() => expect(checkbox(node, "我已核对工单范围")).toBeDefined());
  flushSync(() => checkbox(node, "我已核对工单范围")!.click());
  flushSync(() => button(node, "启动所选主工单").click());
  await vi.waitFor(() => expect(mocks.start).toHaveBeenCalledWith("company", expect.objectContaining({
    parentKeys: ["MAIN-1", "MAIN-4"],
    plan: expect.objectContaining({ ignoredParentKeys: ["MAIN-3"] }),
  })));
});

it("previews and authorizes skipping test cases for the selected main only", async () => {
  const preview = plan();
  preview.parents = ["MAIN-1", "MAIN-2"];
  mocks.plan.mockImplementation(async (_company, input) => ({
    ...preview,
    branches: preview.parents.map(parentKey => ({
      parentKey, state: "ready", canSkipTestCases: true, nodes: [], blockers: [], excluded: [],
      skipTestCases: input.skipTestCasesParentKeys?.includes(parentKey) || undefined,
    })),
  }));
  mocks.start.mockResolvedValue({ id: "workflow" });
  const view = mount();
  const skip = (key: string) => view.querySelector<HTMLInputElement>(`input[aria-label="忽略 ${key} 测试用例编写及评审"]`)!;
  await vi.waitFor(() => expect(skip("MAIN-1")).not.toBeNull());
  flushSync(() => skip("MAIN-1").click());
  expect(skip("MAIN-2").checked).toBe(false);
  flushSync(() => button(view, "重新生成计划").click());
  await vi.waitFor(() => expect(checkbox(view, "我已核对工单范围")).toBeDefined());
  flushSync(() => checkbox(view, "我已核对工单范围")!.click());
  flushSync(() => button(view, "启动所选主工单").click());
  await vi.waitFor(() => expect(mocks.start).toHaveBeenCalledWith("company", expect.objectContaining({
    parentKeys: ["MAIN-1", "MAIN-2"],
    plan: expect.objectContaining({ skipTestCasesParentKeys: ["MAIN-1"] }),
  })));
});

it("keeps the saved branch chart and updates colors from workflow state without regenerating the plan", async () => {
  const preview = plan();
  preview.nodes = [];
  preview.branches = [{ parentKey: "MAIN-1", state: "started", nodes: [], blockers: [], excluded: [] }];
  mocks.plan.mockResolvedValue(preview);
  const stages = [
    { stage: "design", taskId: "design", jiraKey: "DES-1", state: "done", dependsOn: [] },
    { stage: "coding", taskId: "coding", jiraKey: "DEV-1", state: "running", dependsOn: ["design"] },
    { stage: "functional-test", taskId: "test", jiraKey: "TEST-1", state: "pending", dependsOn: ["coding"] },
  ].map(stage => ({ ...stage, parentKey: "MAIN-1", seatId: "assigned" }));
  const workflow = { state: "active", stages } as DeliveryWorkflow;
  const source = { ...snapshot, plan: { ...snapshot.plan, items: stages.map(stage => ({
    key: stage.jiraKey, title: stage.jiraKey, type: "", assignee: "", parentKey: "MAIN-1", scheduled: true,
    status: "已完成",
  })) } };
  const node = mount(source, workflow);
  await vi.waitFor(() => expect(node.textContent).toContain("MAIN-1 · 已启动"));
  const card = (key: string) => node.querySelector<HTMLButtonElement>(`figure button[title="${key}"]`)!;
  expect(card("DES-1").textContent).toContain("已完成");
  expect(card("DEV-1").textContent).toContain("进行中");
  expect(card("TEST-1").textContent).toContain("未开始");
  expect(card("DEV-1").style.borderInlineStartColor).not.toBe(card("TEST-1").style.borderInlineStartColor);
  expect(card("DES-1").style.borderInlineStartColor).not.toBe(card("DEV-1").style.borderInlineStartColor);
  expect(node.querySelectorAll("figure path[marker-end]")).toHaveLength(2);

  node.updateWorkflow({ ...workflow, stages: workflow.stages.map(stage => stage.taskId === "coding" ? { ...stage, state: "done" } : stage) });
  expect(card("DEV-1").textContent).toContain("已完成");
  expect(mocks.plan).toHaveBeenCalledTimes(1);
});

it("renders the archived execution chart without asking Jira to regenerate the plan", () => {
  const workflow = { state: "completed", stages: [
    { stage: "coding", taskId: "coding", jiraKey: "DEV-1", parentKey: "MAIN-1", state: "done", dependsOn: [] },
  ] } as unknown as DeliveryWorkflow;
  const node = mount(snapshot, workflow, true);
  expect(node.querySelector('figure button[title="DEV-1"]')?.textContent).toContain("已完成");
  expect(mocks.plan).not.toHaveBeenCalled();
});
