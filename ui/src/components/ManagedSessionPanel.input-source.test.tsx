// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, expect, it, vi } from "vitest";
import type { ManagedContent, ManagedSessionDetail } from "@paperclipai/shared";
import { managedSessionsApi } from "@/api/managed-sessions";
import { ManagedSessionPanel } from "./ManagedSessionPanel";
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
const session: ManagedSessionDetail["session"] = {
  id: "session", companyId: "company", taskId: "task", seatId: "seat", runId: "run", nativeSessionId: "native",
  ownerUserId: "owner", startedAt: "2026-11-12T01:00:00Z", lastReceivedAt: "2026-11-12T01:00:00Z",
  endedAt: null, coverage: "from_start", syncState: "collecting", collectionPaused: false, uploadPaused: false,
  deletedAt: null, finalizedAt: null, lastObservation: {},
};
let dispose: (() => Promise<void>) | undefined;
afterEach(async () => { await dispose?.(); vi.restoreAllMocks(); });
it("shows historical injection, manual prompts and selected answers in dialogue view", async () => {
  const entries: Array<{ id: string; kind: ManagedContent["manifest"]["kind"]; name?: string; inputSource?: "manual"; text: string }> = [
    { id: "skill", kind: "user", text: "Base directory for this skill: /repo/.claude/skills/analysis\n# 分析技能" },
    { id: "human", kind: "user", inputSource: "manual", text: "请分析银行接口" },
    { id: "question", kind: "tool_call", name: "AskUserQuestion", text: '{"questions":[{"question":"选择处理方式","options":[{"label":"先下载附件"},{"label":"暂停"}]}]}' },
    { id: "answer", kind: "tool_result", name: "AskUserQuestion", inputSource: "manual", text: '{"answers":{"选择处理方式":"先下载附件"}}' },
    { id: "bash", kind: "tool_call", name: "Bash", text: "hidden tool" },
  ];
  const items: ManagedContent[] = entries.map((entry, sequence) => ({
    id: entry.id, streamId: "main", contentId: entry.id, revision: "r1", occurredAt: session.startedAt, sequence, complete: true,
    manifest: { contentId: entry.id, revision: "r1", kind: entry.kind, inputSource: entry.inputSource,
      parentStreamId: null, messageId: entry.id, toolCallId: null, name: entry.name ?? null, mime: null,
      parts: 1, bytes: entry.text.length, sha256: "a".repeat(64), redacted: false, sourceTruncated: false, unavailableReason: null },
  }));
  vi.spyOn(managedSessionsApi, "list").mockResolvedValue([session]);
  vi.spyOn(managedSessionsApi, "detail").mockResolvedValue({ session, health: "normal", streams: [], quality: null, phases: [],
    timing: { state: "executing", since: null, elapsedMs: 0, executingMs: 0, waitingMs: 0, unknownMs: 0, coverage: 1 } });
  vi.spyOn(managedSessionsApi, "messages").mockResolvedValue({ items, next: null });
  vi.spyOn(managedSessionsApi, "body").mockImplementation(async (_c, _s, id) => ({
    parts: [{ partIndex: 0, data: entries.find(e => e.id === id)!.text, encoding: "utf8" }], next: null, revision: "r1",
  }));
  const node = document.createElement("div"); document.body.append(node);
  const root = createRoot(node), cache = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  dispose = async () => { await act(async () => root.unmount()); cache.clear(); node.remove(); };
  await act(async () => { root.render(<QueryClientProvider client={cache}><ManagedSessionPanel companyId="company" taskId="task" view="records" /></QueryClientProvider>); });
  for (let n = 0; n < 40 && !node.textContent?.includes('"选择处理方式":"先下载附件"'); n++) await act(async () => { await new Promise(resolve => setTimeout(resolve, 10)); });
  expect(node.textContent).toContain("Harness 注入");
  expect(node.textContent).toContain("手动输入 · 选项答复");
  expect(node.textContent).toContain('"选择处理方式":"先下载附件"');
  const scope = node.querySelector<HTMLSelectElement>('select[aria-label="会话记录范围"]')!;
  await act(async () => { scope.value = "dialogue"; scope.dispatchEvent(new Event("change", { bubbles: true })); });
  expect(node.textContent).toContain("Claude 提问");
  expect(node.textContent).toContain("手动输入 · 选项答复");
  expect(node.textContent).not.toContain("Bash");
});
