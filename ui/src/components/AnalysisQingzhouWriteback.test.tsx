// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vitest";
import type { AnalysisExecution } from "@paperclipai/shared";
import { AnalysisQingzhouWriteback } from "./AnalysisQingzhouWriteback";
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
describe("Qingzhou submission result", () => {
  it("keeps saved content distinct from submission failure and offers a retry", async () => {
    const node = document.createElement("div"), root = createRoot(node), retry = vi.fn();
    document.body.append(node);
    const execution = { demandNo: "TWGF-00919", delivery: {}, qingzhouWriteback: { status: "saved", reviewStatus: "failed", reviewError: "评审人未配置" } } as AnalysisExecution;
    await act(async () => root.render(<AnalysisQingzhouWriteback execution={execution} canManage busy={false} onRetry={retry} />));
    expect(node.textContent).toContain("正文已保存 · 提交轻舟评审未完成");
    expect(node.querySelector('[role="alert"]')?.textContent).toBe("评审人未配置");
    expect(node.querySelector("fieldset")).toBeNull();
    await act(async () => node.querySelector("button")!.click()); expect(retry).toHaveBeenCalledOnce();
    execution.qingzhouWriteback = { status: "saved", reviewStatus: "submitted", sourceState: "5" };
    await act(async () => root.render(<AnalysisQingzhouWriteback execution={execution} canManage busy={false} onRetry={retry} />));
    expect(node.textContent).toContain("已提交轻舟评审 · 分析完成待评审"); expect(node.querySelector("button")).toBeNull();
    await act(async () => root.unmount()); node.remove();
  });
});
