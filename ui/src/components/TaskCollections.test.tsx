// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { afterEach, expect, it, vi } from "vitest";
import { TaskCollections } from "./TaskCollections";
vi.mock("@/lib/router", async () => import("react-router-dom"));
vi.mock("@/pages/AnalysisExecutions", () => ({ AnalysisExecutions: () => <p>分析专用列表与创建</p> }));
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
let cleanup: () => Promise<void>;
afterEach(async () => cleanup?.());
function Destination() { const location = useLocation(); return <output>{JSON.stringify(location)}</output>; }
async function mount(url: string) {
  const node = document.createElement("div"); document.body.append(node);
  const root = createRoot(node);
  await act(async () => { root.render(<MemoryRouter initialEntries={[url]}><Routes><Route path="/issues" element={<TaskCollections><p>全部任务列表</p></TaskCollections>} /><Route path="/issues/:id" element={<Destination />} /></Routes></MemoryRouter>); });
  cleanup = async () => { await act(async () => root.unmount()); node.remove(); };
  return node;
}
it("opens analysis under tasks and preserves project alongside independent status filters", async () => {
  const node = await mount("/issues?projectId=project&status=blocked&page=4");
  const link = [...node.querySelectorAll("a")].find(a => a.textContent === "需求分析")!;
  expect(link.getAttribute("href")).toBe("/issues?projectId=project&status=blocked&taskType=analysis");
  expect(node.textContent).toContain("全部任务列表");
  await act(async () => link.click());
  expect(node.textContent).not.toContain("分析专用列表与创建");
  expect(node.textContent).toContain("全部任务列表");
  expect(node.querySelector('a[aria-current="page"]')?.textContent).toBe("需求分析");
  expect([...node.querySelectorAll("a")].find(a => a.textContent === "全部任务")?.getAttribute("href")).toBe("/issues?projectId=project&status=blocked");
});
it("defaults unknown task types to the existing collection", async () => {
  const node = await mount("/issues?taskType=unknown");
  expect(node.textContent).toContain("全部任务列表");
  expect(node.querySelector('a[aria-current="page"]')?.textContent).toBe("全部任务");
});

it("uses the same ordered stages as the delivery chain and renders creation only on request", async () => {
  const node = await mount("/issues?taskType=analysis&createAnalysis=1&projectId=project");
  expect([...node.querySelectorAll('nav a')].map(a => a.textContent)).toEqual(["全部任务", "需求分析", "研发设计", "编码与代码评审", "测试用例", "功能测试", "其他任务"]);
  expect(node.textContent).toContain("分析专用列表与创建");
  expect(node.textContent).not.toContain("全部任务列表");
});

it("keeps old execution links targeting unified detail and preserves list context", async () => {
  const node = await mount("/issues?taskType=analysis&projectId=project&executionId=task&page=3&snapshotId=snapshot");
  const location = JSON.parse(node.querySelector("output")!.textContent!);
  expect(location.pathname).toBe("/issues/task");
  expect(location.state.issueDetailBreadcrumb.href).toBe("/issues?taskType=analysis&projectId=project&page=3&snapshotId=snapshot");
});
