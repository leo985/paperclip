// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, it, expect, vi } from "vitest";
import { BUILTIN_DELIVERY_TEMPLATE } from "@paperclipai/shared";
import { api } from "@/api/client";
import { DeliveryTemplates } from "./DeliveryTemplates";
vi.mock("@/context/CompanyContext", () => ({
  useCompany: () => ({ selectedCompanyId: "company" }),
}));
vi.mock("@/hooks/useManagementAccess", () => ({
  useManagementAccess: () => ({ canManage: true }),
}));
vi.mock("@/api/client", () => ({ api: { get: vi.fn(), post: vi.fn() } }));
(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root, container: HTMLDivElement, cache: QueryClient;
async function flush() {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });
}
async function render() {
  vi.mocked(api.get).mockImplementation(async (path) => {
    if (path.includes("delivery-templates"))
      return {
        effective: structuredClone(BUILTIN_DELIVERY_TEMPLATE),
        own: null,
        history: [],
      };
    if (path.includes("user-directory"))
      return {
        users: [
          {
            principalId: "reviewer",
            status: "active",
            user: { id: "reviewer", name: "审核员" },
          },
        ],
      };
    if (path.endsWith("/projects")) return [{ id: "project", name: "项目甲" }];
    return [];
  });
  cache = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () =>
    root.render(
      <QueryClientProvider client={cache}>
        <DeliveryTemplates />
      </QueryClientProvider>,
    ),
  );
  await flush();
}
function button(text: string) {
  return [...container.querySelectorAll("button")].find(
    (b) => b.textContent === text,
  )!;
}
afterEach(async () => {
  await act(async () => root?.unmount());
  container?.remove();
  cache?.clear();
  vi.clearAllMocks();
});
describe("delivery template settings", () => {
  it("selects entry requirements for the first enabled stage and publishes the choices",async()=>{
    await render();
    const fieldset=[...container.querySelectorAll("fieldset")].find(f=>f.querySelector("legend")?.textContent?.includes("交付链准入"))!;
    expect(fieldset.textContent).toContain("开始节点：研发设计");
    const owner=[...fieldset.querySelectorAll("label")].find(label=>label.textContent==="需求拆分人员已指定")!.querySelector<HTMLInputElement>("input")!;
    const title=[...fieldset.querySelectorAll("label")].find(label=>label.textContent==="条目标题已填写")!.querySelector<HTMLInputElement>("input")!;
    await act(async()=>title.click());
    await act(async()=>owner.click());
    vi.mocked(api.post).mockResolvedValue({});
    await act(async()=>button("发布新版本").click());
    expect(api.post).toHaveBeenCalledWith("/companies/company/delivery-templates",expect.objectContaining({definition:expect.objectContaining({stages:expect.objectContaining({design:expect.objectContaining({entryChecks:["title","owner"]})})})}));
  });
  it("shows the default and publishes a reviewed organization version with concurrency guard", async () => {
    await render();
    expect(container.textContent).toContain("内置模板");
    expect(container.textContent).toContain("负责人评审");
    const execution = [...container.querySelectorAll("select")].find((s) =>
      [...s.options].some((o) => o.value === "parallel"),
    )!;
    await act(async () => {
      execution.value = "serial";
      execution.dispatchEvent(new Event("change", { bubbles: true }));
    });
    vi.mocked(api.post).mockResolvedValue({
      ...BUILTIN_DELIVERY_TEMPLATE,
      revision: 1,
      scope: "organization",
    });
    await act(async () => button("发布新版本").click());
    await flush();
    expect(api.post).toHaveBeenCalledWith(
      "/companies/company/delivery-templates",
      expect.objectContaining({
        expectedRevision: 0,
        definition: expect.objectContaining({ codingExecution: "serial" }),
      }),
    );
    expect(container.textContent).toContain("新建交付将自动接入");
  });
  it("configures stage-internal order and shows the exact human or seat review sequence",async()=>{
    await render();
    expect(container.querySelector('[aria-label="交付链预览"]')?.textContent).toContain("设计单 → 设计评审单（负责人评审）");
    expect(container.querySelector('[aria-label="交付链预览"]')?.textContent).toContain("编码单 → 代码评审单（独立席位执行）");
    const sequence=container.querySelector<HTMLSelectElement>('[aria-label="研发设计工单顺序"]')!;
    await act(async()=>{sequence.value="work_only";sequence.dispatchEvent(new Event("change",{bubbles:true}));});
    expect(container.querySelector('[aria-label="交付链预览"]')?.textContent).not.toContain("设计评审单");
    vi.mocked(api.post).mockResolvedValue({});
    await act(async()=>button("发布新版本").click());
    expect(api.post).toHaveBeenCalledWith("/companies/company/delivery-templates",expect.objectContaining({definition:expect.objectContaining({stages:expect.objectContaining({design:expect.objectContaining({taskSequence:"work_only"})})})}));
  });
  it("publishes independent human and Agent execution choices for work, review and tests",async()=>{
    await render();
    async function choose(label:string,value:string){const select=container.querySelector<HTMLSelectElement>(`[aria-label="${label}"]`)!;await act(async()=>{select.value=value;select.dispatchEvent(new Event("change",{bubbles:true}));});}
    await choose("研发设计执行方式","human");await choose("研发设计人工负责人","reviewer");
    await choose("设计评审单执行方式","agent");await choose("代码评审单执行方式","human");await choose("代码评审单人工负责人","reviewer");
    await choose("功能测试执行方式","human");await choose("功能测试人工负责人","reviewer");
    expect(container.querySelector('[aria-label="交付链预览"]')?.textContent).toContain("设计单（人工） → 设计评审单（独立席位执行）");
    vi.mocked(api.post).mockResolvedValue({});await act(async()=>button("发布新版本").click());
    expect(api.post).toHaveBeenCalledWith("/companies/company/delivery-templates",expect.objectContaining({definition:expect.objectContaining({stages:expect.objectContaining({design:expect.objectContaining({workExecution:"human",workExecutorUserId:"reviewer",reviewExecution:"agent"}),coding:expect.objectContaining({reviewExecution:"human",reviewExecutorUserId:"reviewer"}),"functional-test":expect.objectContaining({workExecution:"human",workExecutorUserId:"reviewer"})})})}));
  });
  it("publishes the per-stage rejection policy and previews the return loop",async()=>{
    await render();
    const select=container.querySelector<HTMLSelectElement>('[aria-label="研发设计退回处理方式"]')!;
    expect(select.value).toBe("automatic_rework");
    expect(container.querySelector('[aria-label="交付链预览"]')?.textContent).toContain("退回自动返工并重审");
    await act(async()=>{select.value="pause";select.dispatchEvent(new Event("change",{bubbles:true}));});
    vi.mocked(api.post).mockResolvedValue({});await act(async()=>button("发布新版本").click());
    expect(api.post).toHaveBeenCalledWith("/companies/company/delivery-templates",expect.objectContaining({definition:expect.objectContaining({stages:expect.objectContaining({design:expect.objectContaining({rejectionHandling:"pause"})})})}));
  });
  it("restores project inheritance explicitly and surfaces publish errors", async () => {
    await render();
    const scope = container.querySelector("select")!;
    await act(async () => {
      scope.value = "project";
      scope.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await flush();
    expect(container.textContent).toContain("继承组织配置");
    await act(async () => button("恢复继承组织配置（发布后生效）").click());
    vi.mocked(api.post).mockRejectedValue(new Error("模板已被其他人更新"));
    await act(async () => button("发布新版本").click());
    await flush();
    expect(api.post).toHaveBeenCalledWith(
      "/companies/company/delivery-templates",
      expect.objectContaining({
        projectId: "project",
        definition: expect.objectContaining({ inheritOrganization: true }),
      }),
    );
    expect(container.querySelector('[role="alert"]')?.textContent).toContain(
      "模板已被其他人更新",
    );
  });
});

it("configures an opt-in bounded automatic repair policy without changing the standard stages",async()=>{
 await render();const checkbox=container.querySelector('input[aria-label="启用测试失败自动修复"]') as HTMLInputElement;
 expect(checkbox.checked).toBe(false);await act(async()=>checkbox.click());
 expect(container.querySelector('input[aria-label="测试环境构建回读地址"]')?.hasAttribute('required')).toBe(true);
 expect((container.querySelector('input[aria-label="最多自动修复轮数"]') as HTMLInputElement).value).toBe("3");
 const add=[...container.querySelectorAll('button')].find(b=>b.textContent==="添加自动修复模块路由")!;
 await act(async()=>add.click());expect(container.querySelector('input[aria-label="自动修复模块 1"]')).toBeTruthy();
 expect(container.textContent).toContain("最终验收仍由人工完成");
 await act(async()=>checkbox.click());expect(container.querySelector('input[aria-label="测试环境构建回读地址"]')).toBeNull();
});

it("configures reuse of original nodes without invented Jira ticket types",async()=>{
 await render();const toggle=container.querySelector<HTMLInputElement>('input[aria-label="启用测试失败自动修复"]')!;
 await act(async()=>toggle.click());
 expect(container.textContent).toContain("复用原编码、代码评审和功能测试任务");
 for(const label of ["缺陷主单类型 ID","修复子单类型 ID","独立代码评审子单类型 ID","重测执行子单类型 ID"])
  expect(container.querySelector(`[aria-label="${label}"]`)).toBeNull();
});
