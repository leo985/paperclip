// @vitest-environment jsdom
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, expect, it, vi } from "vitest";
import { JiraSeatDispatch } from "./JiraSeatDispatch";

const mocks = vi.hoisted(() => ({ save: vi.fn(async (_companyId: string, _agentId: string, _data: unknown) => ({})) }));
vi.mock("@/api/dsp7-seats", () => ({ dsp7SeatsApi: {
  dispatch: async () => ({ enabled: true, jiraBaseUrl: "http://jira.test", jiraAssignee: "dev",
    jiraProjectKey: "TEST", projectId: "project", readyStatuses: ["编码中"],
    issueTypes: ["编码"], jiraPatConfigured: true, revision: 1 }),
  saveDispatch: mocks.save,
} }));
vi.mock("@/api/projects", () => ({ projectsApi: {
  list: async () => [{ id: "project", name: "无平台仓库的项目", workspaces: [] }],
} }));

let cleanup = () => {};
afterEach(() => { cleanup(); mocks.save.mockClear(); });

it("saves project-scoped dispatch rules without selecting or configuring a repository", async () => {
  const host = document.createElement("div"); document.body.append(host);
  const root = createRoot(host);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  cleanup = () => { flushSync(() => root.unmount()); client.clear(); host.remove(); };
  flushSync(() => root.render(<QueryClientProvider client={client}><JiraSeatDispatch companyId="company" agentId="seat" /></QueryClientProvider>));
  await vi.waitFor(() => expect(host.querySelector("select")?.value).toBe("project"));
  const pat = host.querySelector<HTMLInputElement>('input[aria-label="Jira PAT"]')!;
  expect(pat.type).toBe("password");
  expect(pat.value).toBe("••••••••");
  flushSync(() => pat.dispatchEvent(new FocusEvent("focusin", { bubbles: true })));
  expect(pat.value).toBe("");
  flushSync(() => pat.dispatchEvent(new FocusEvent("focusout", { bubbles: true })));
  expect(pat.value).toBe("••••••••");
  expect(host.textContent).not.toContain("请选择共享仓库");
  expect(host.textContent).toContain("Git 工作树由本机 Harness 套件管理");
  const save = Array.from(host.querySelectorAll("button")).find(button => button.textContent === "保存 Jira 自动执行规则")!;
  expect(save.disabled).toBe(false);
  flushSync(() => save.click());
  await vi.waitFor(() => expect(mocks.save).toHaveBeenCalledOnce());
  expect(mocks.save.mock.calls[0]).toEqual(["company", "seat", expect.objectContaining({ projectId: "project" })]);
  expect(mocks.save.mock.calls[0]?.[2]).not.toHaveProperty("workspaceId");
  expect(mocks.save.mock.calls[0]?.[2]).not.toHaveProperty("credentials");
});
