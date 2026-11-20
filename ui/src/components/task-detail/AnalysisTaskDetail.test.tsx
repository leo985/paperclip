// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AnalysisTaskDetail as Detail } from "@paperclipai/shared";
import { analysisApi } from "@/api/analysis-executions";
import { AnalysisTaskDetail } from "./AnalysisTaskDetail";

const access = vi.hoisted(() => ({ canManage: true }));
vi.mock("@/hooks/useManagementAccess", () => ({
  useManagementAccess: () => access,
}));
vi.mock("@/lib/router", () => ({
  Link: ({ to, children }: { to: string; children: React.ReactNode }) => (
    <a href={to}>{children}</a>
  ),
}));
vi.mock("./TaskIdentitySummary", () => ({
  TaskIdentitySummary: () => <p>执行席位与负责人</p>,
}));
vi.mock("@/components/ManagedSessionPanel", () => ({
  ManagedSessionPanel: ({ taskId }: { taskId: string }) => (
    <p>会话记录 {taskId}</p>
  ),
}));
vi.mock("@/components/AnalysisQingzhouWriteback", () => ({
  AnalysisQingzhouWriteback: () => <p>轻舟回写（独立核验）</p>,
}));
vi.mock("@/components/MarkdownBody", () => ({ MarkdownBody: ({children}: {children: React.ReactNode}) => <div>{children}</div> }));
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
Object.assign(URL, { createObjectURL: vi.fn(() => "blob:analysis-report"), revokeObjectURL: vi.fn() });
const digest = "a".repeat(64);
function fixture(): Detail {
  return {
    execution: {
      id: "analysis",
      companyId: "company",
      projectId: "project",
      seatId: "seat",
      ownerUserId: "owner",
      revision: 2,
      title: "条目分析",
      brief: "业务场景与开发内容",
      state: "interrupted",
      activeRunId: "old-run",
      dispatchId: "dispatch-token",
      demandNo: "TWGF-00919",
      supersedesId: null,
      capabilityId: null,
      registryRevision: null,
      snapshot: {
        phase: "P2",
        completedPhases: ["P0", "P1"],
        gateErrors: ["P2: 需求列表不能为空"],
      },
      delivery: null,
      publication: null,
    } as Detail["execution"],
    decisions: [
      {
        id: "question",
        executionId: "analysis",
        runId: "old-run",
        key: "Q1",
        kind: "question",
        text: "请提供需求原文",
        inputDigest: digest,
        contentDigest: "question-digest",
        status: "open",
        answer: null,
        answeredBy: null,
        answeredAt: null,
        ackedAt: null,
        createdAt: "2026-11-11T01:00:00Z",
      },
    ],
    run: {
      id: "old-run",
      status: "cancelled",
      error: "Analysis stopped by owner",
    },
  };
}
function delivery(): NonNullable<Detail["execution"]["delivery"]> {
  return {
    protocolVersion: 1,
    binding: {
      protocolVersion: 1,
      companyId: "company",
      taskId: "analysis",
      revision: 2,
      nativeId: "pc-analysis-r2",
      profile: "analysis",
      repository: "analysis-harness",
    },
    phase: "P4",
    nativeStatus: "completed",
    completedPhases: ["P0", "P1", "P2", "P3", "P4"],
    gateErrors: [],
    localCompleted: true,
    formalPublication: "unverified",
    inputDigest: digest,
    handoffDigest: "b".repeat(64),
    artifacts: (
      [
        "intake.md",
        "evidence.json",
        "requirements.json",
        "analysis.md",
        "review.json",
        "handoff.md",
        "state.json",
      ] as const
    ).map((path) => ({ path, sha256: "c".repeat(64) })),
  };
}
let cleanup: (() => Promise<void>) | undefined;
afterEach(async () => {
  await cleanup?.();
  cleanup = undefined;
  vi.restoreAllMocks();
  access.canManage = true;
});
async function mount(detail = fixture()) {
  const node = document.createElement("div");
  document.body.append(node);
  const root = createRoot(node),
    cache = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const render = async (value = detail) =>
    act(async () =>
      root.render(
        <QueryClientProvider client={cache}>
          <AnalysisTaskDetail
            detail={value}
            listHref="/DSP/analysis-executions?projectId=project&page=2"
            platformDeliverables={<p>平台附件与成果</p>}
          />
        </QueryClientProvider>,
      ),
    );
  await render();
  cleanup = async () => {
    await act(async () => root.unmount());
    cache.clear();
    node.remove();
  };
  const button = (text: string) =>
    [...node.querySelectorAll("button")].find(
      (item) => item.textContent === text,
    )!;
  return { node, render, button };
}
function type(node: Element, value: string) {
  const proto =
    node instanceof HTMLTextAreaElement
      ? HTMLTextAreaElement.prototype
      : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto, "value")!.set!.call(node, value);
  node.dispatchEvent(new Event("input", { bubbles: true }));
}
describe("analysis in the unified task detail", () => {
  it("preserves snapshot, errors, questions, revision and records within the shared sections", async () => {
    const dispatch = vi.spyOn(analysisApi, "dispatch");
    const { node } = await mount();
    expect(
      [...node.querySelectorAll("nav a")].map((a) => a.textContent),
    ).toEqual([
      "任务概况",
      "待处理事项与执行操作",
      "执行进度与门禁",
      "交付成果",
      "会话与执行记录",
    ]);
    for (const text of [
      "修订 2",
      "P2",
      "已完成 P0、P1",
      "需求列表不能为空",
      "请提供需求原文",
      "Analysis stopped by owner",
      "会话记录 analysis",
      "平台附件与成果",
    ])
      expect(node.textContent).toContain(text);
    expect(node.querySelector('a[href*="page=2"]')?.textContent).toBe(
      "返回分析列表",
    );
    expect(dispatch).not.toHaveBeenCalled();
    expect(node.querySelector("textarea")).toBeNull(); // Ended run cannot accept new answers.
  });
  it("reuses an authorized pending dispatch identifier, and does not enable manager actions for members", async () => {
    const dispatch = vi
      .spyOn(analysisApi, "dispatch")
      .mockResolvedValue({ runId: null });
    const detail = fixture();
    detail.execution.state = "queued";
    detail.execution.activeRunId = null;
    detail.run = null;
    const { node, button, render } = await mount(detail);
    await act(async () => button("授权并派发分析").click());
    expect(dispatch).toHaveBeenCalledWith(
      "company",
      "analysis",
      "dispatch-token",
    );
    access.canManage = false;
    await render(detail);
    expect(node.textContent).not.toContain("授权并派发分析");
    expect(node.textContent).not.toContain("核验并恢复分析");
  });
  it("sends answers with their exact content digest to the same execution", async () => {
    const answer = vi.spyOn(analysisApi, "answer").mockResolvedValue({});
    const detail = fixture();
    detail.run!.status = "running";
    const { node, button, render } = await mount(detail);
    await act(async () =>
      type(node.querySelector("textarea")!, "需求原文已补充"),
    );
    await act(async () => button("保存并发送给同一会话").click());
    expect(answer).toHaveBeenCalledWith(
      "company",
      "analysis",
      detail.decisions[0],
      "需求原文已补充",
    );
    const changed = {
      ...detail,
      decisions: [{ ...detail.decisions[0], contentDigest: "new-content" }],
    };
    await render(changed);
    expect((node.querySelector("textarea") as HTMLTextAreaElement).value).toBe(
      "",
    );
    expect(button("保存并发送给同一会话").disabled).toBe(true);
  });
  it("allows the existing owner stop flow and surfaces failures inline", async () => {
    access.canManage = false;
    const stop = vi
      .spyOn(analysisApi, "stop")
      .mockRejectedValue(new Error("运行仍在核验"));
    const detail = fixture();
    detail.run!.status = "running";
    const { node, button } = await mount(detail);
    await act(async () => button("停止本次运行").click());
    expect(stop).toHaveBeenCalledWith("company", "analysis");
    expect(node.querySelector('[role="alert"]')?.textContent).toBe(
      "运行仍在核验",
    );
  });
  it("retains artifact digests and pins manual publication to the verified delivery", async () => {
    const publish = vi.spyOn(analysisApi, "publication").mockResolvedValue({});
    const detail = fixture();
    detail.execution.delivery = delivery();
    const { node, button, render } = await mount(detail);
    expect(node.textContent).toContain("analysis.md");
    expect(node.textContent).toContain("c".repeat(64));
    expect(
      node.querySelector('a[href*="supersedesId=analysis"]')?.textContent,
    ).toBe("建立新修订");
    await act(async () => {
      type(
        node.querySelector('[aria-label="正式发布链接"]')!,
        "https://example.com/review",
      );
      type(
        node.querySelector('[aria-label="发布核验说明"]')!,
        "已核验当前输入对应的正式发布记录",
      );
      (
        node.querySelector('input[type="checkbox"]') as HTMLInputElement
      ).click();
    });
    expect(button("登记已核验发布").disabled).toBe(false);
    await act(async () =>
      node
        .querySelector("form")!
        .dispatchEvent(
          new Event("submit", { bubbles: true, cancelable: true }),
        ),
    );
    expect(publish).toHaveBeenCalledWith("company", "analysis", {
      inputDigest: digest,
      handoffDigest: "b".repeat(64),
      url: "https://example.com/review",
      note: "已核验当前输入对应的正式发布记录",
      attest: true,
    });
    await render({
      ...detail,
      execution: {
        ...detail.execution,
        delivery: {
          ...detail.execution.delivery!,
          inputDigest: "d".repeat(64),
        },
      },
    });
    expect(button("登记已核验发布").disabled).toBe(true);
    expect(
      (node.querySelector('input[type="checkbox"]') as HTMLInputElement)
        .checked,
    ).toBe(false);
  });
  it("keeps formal publication distinct from native completion and makes it read-only for members", async () => {
    const detail = fixture();
    detail.execution.delivery = delivery();
    detail.execution.publication = {
      url: "https://example.com/published",
      note: "正式记录",
      verifiedBy: "reviewer",
      verifiedAt: "2026-11-11T02:00:00Z",
      method: "manual-attestation",
      inputDigest: digest,
      handoffDigest: digest,
    };
    access.canManage = false;
    const { node } = await mount(detail);
    expect(
      node.querySelector('a[href="https://example.com/published"]')
        ?.textContent,
    ).toBe("查看正式发布记录");
    expect(node.textContent).toContain("此记录为人工核验");
    expect(node.querySelector("form")).toBeNull();
  });
});
it("shows a rejected startup as interrupted, keeps the pending request identity and reports a failed retry", async () => {
  const detail=fixture();detail.execution.activeRunId=null;detail.run=null;
  detail.dispatchProblem="分析尚未启动：旧运行存在执行保护。";
  const dispatch=vi.spyOn(analysisApi,"dispatch").mockRejectedValue(new Error("旧运行尚未提供进程树退出回执"));
  const {node,button}=await mount(detail);
  expect(node.querySelector('[role="alert"]')?.textContent).toContain("分析尚未启动");
  expect(node.textContent).not.toContain("已授权排队");
  await act(async()=>button("核验并恢复分析").click());
  expect(dispatch).toHaveBeenCalledWith("company","analysis","dispatch-token");
  expect(node.textContent).toContain("旧运行尚未提供进程树退出回执");
  expect(node.textContent).not.toContain("派发请求已受理");
});

it("shows reviewable documents and disables approval when their version is missing or stale", async () => {
  const detail=fixture();detail.run={id:"old-run",status:"running"} as Detail["run"];
  const decision=detail.decisions[0];decision.kind="review";decision.key="P3-review";
  const {node,button,render}=await mount(detail);
  expect(button("批准此输入版本").disabled).toBe(true);
  detail.execution.snapshot!.reviewMaterials={runId:"old-run",inputDigest:digest,capturedAt:"2026-11-12T10:00:00Z",documents:[
    {path:"analysis.md",sha256:digest,content:"德国单笔付款分析正文"},
    {path:"intake.md",sha256:digest,content:"需求背景"},
    {path:"requirements.json",sha256:digest,content:JSON.stringify({items:[{id:"R1",statement:"单笔付款",acceptance:"校验支付状态"}],questions:[{id:"Q2",answer:"本期不包含"}]})},
  ],evidenceSha256:digest,evidence:[{id:"E1",kind:"file",source:"轻舟",locator:"需求附件",path:"sources/test.pdf",sha256:digest}]};
  await render({...detail});
  expect(node.textContent).toContain("TWGF-00919-需求分析.md");
  await act(async()=>button("预览").click());
  expect(document.body.textContent).toContain("德国单笔付款分析正文");expect(node.textContent).toContain("校验支付状态");expect(node.textContent).toContain("本期不包含");expect(node.textContent).toContain("sources/test.pdf");
  expect(button("批准此输入版本").disabled).toBe(false);
  detail.execution.snapshot!.reviewMaterials!.inputDigest="b".repeat(64);await render({...detail});
  expect(button("批准此输入版本").disabled).toBe(true);
});
