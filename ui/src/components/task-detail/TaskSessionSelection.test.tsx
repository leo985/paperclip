// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, expect, it, vi } from "vitest";
import type { ManagedSession, ManagedSessionDetail } from "@paperclipai/shared";
import { managedSessionsApi } from "@/api/managed-sessions";
import { ManagedSessionPanel } from "@/components/ManagedSessionPanel";
import { TaskDetailLayout } from "./TaskDetailLayout";
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
const sessions: ManagedSession[] = ["new", "old"].map((id) => ({
  id,
  companyId: "company",
  taskId: "task",
  seatId: "seat",
  runId: "run-" + id,
  nativeSessionId: id,
  ownerUserId: "owner",
  startedAt: "2026-11-11T01:00:00Z",
  lastReceivedAt: "2026-11-11T02:00:00Z",
  endedAt: "2026-11-11T02:00:00Z",
  coverage: "from_start",
  syncState: "collecting",
  collectionPaused: false,
  uploadPaused: false,
  deletedAt: null,
  finalizedAt: null,
  lastObservation: {},
}));
let cleanup: (() => Promise<void>) | undefined;
afterEach(async () => {
  await cleanup?.();
  cleanup = undefined;
  vi.restoreAllMocks();
});
async function mount(split = true) {
  vi.spyOn(managedSessionsApi, "list").mockResolvedValue(sessions);
  vi.spyOn(managedSessionsApi, "detail").mockImplementation(
    async (_c, id): Promise<ManagedSessionDetail> => ({
      session: sessions.find((s) => s.id === id)!,
      health: "normal",
      streams: [],
      quality: null,
      timing: {
        elapsedMs: 60000,
        executingMs: 20000,
        waitingMs: 10000,
        unknownMs: 30000,
        coverage: 0.5,
        state: "ended",
        since: null,
      },
      phases: [
        {
          id: "phase-" + id,
          eventType: "phase",
          occurredAt: "2026-11-11T01:00:00Z",
          observedAt: "2026-11-11T02:00:00Z",
          payload: {
            phase: "实际阶段-" + id,
            status: "observed",
            flowVersion: "native-v2",
          },
        },
      ],
    }),
  );
  vi.spyOn(managedSessionsApi, "messages").mockResolvedValue({
    items: [],
    next: null,
  });
  const control = vi
    .spyOn(managedSessionsApi, "control")
    .mockResolvedValue({ ok: true });
  const node = document.createElement("div");
  document.body.append(node);
  const root = createRoot(node),
    cache = new QueryClient({
      defaultOptions: { queries: { retry: false, staleTime: Infinity } },
    });
  await act(async () =>
    root.render(
      <QueryClientProvider client={cache}>
        {split ? (
          <TaskDetailLayout
            overview="任务"
            actions="操作"
            progress={
              <ManagedSessionPanel
                companyId="company"
                taskId="task"
                view="progress"
              />
            }
            deliverables="成果"
            records={
              <ManagedSessionPanel
                companyId="company"
                taskId="task"
                view="records"
              />
            }
          />
        ) : (
          <ManagedSessionPanel companyId="company" taskId="task" />
        )}
      </QueryClientProvider>,
    ),
  );
  for (let i = 0; i < 3; i++)
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 15));
    });
  cleanup = async () => {
    await act(async () => root.unmount());
    cache.clear();
    node.remove();
  };
  return { node, control };
}
it("keeps progress and records on the same selected session, with actual reported phases", async () => {
  const { node, control } = await mount();
  const progress = node.querySelector('[aria-label="执行进度与门禁"]')!;
  const records = node.querySelector('[aria-label="会话与执行记录"]')!;
  expect(progress.textContent).toContain("实际阶段-new");
  expect(progress.textContent).toContain("已观察");
  expect(records.querySelector('[aria-label="会话记录范围"]')).not.toBeNull();
  expect(managedSessionsApi.messages).toHaveBeenCalledWith("company", "new", 0);
  const selector = records.querySelector(
    'select[aria-label="选择受管会话"]',
  ) as HTMLSelectElement;
  await act(async () => {
    selector.value = "old";
    selector.dispatchEvent(new Event("change", { bubbles: true }));
  });
  for (let i = 0; i < 2; i++)
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 15));
    });
  expect(
    (
      progress.querySelector(
        'select[aria-label="选择执行进度会话"]',
      ) as HTMLSelectElement
    ).value,
  ).toBe("old");
  expect(progress.textContent).toContain("实际阶段-old");
  expect(progress.textContent).not.toContain("实际阶段-new");
  expect(managedSessionsApi.messages).toHaveBeenCalledWith("company", "old", 0);
  expect(progress.textContent).not.toContain("采集控制与数据管理");
  expect(records.textContent).toContain("采集控制与数据管理");
  expect(control).not.toHaveBeenCalled();
});
it("preserves the original combined panel and phase-first behavior outside unified details", async () => {
  const { node } = await mount(false);
  expect(node.textContent).toContain("本机会话与 Harness 进度");
  expect(node.textContent).toContain("实际阶段-new");
  expect(node.querySelector('button[aria-pressed="true"]')?.textContent).toBe(
    "执行流程",
  );
  expect(managedSessionsApi.messages).not.toHaveBeenCalled();
});
