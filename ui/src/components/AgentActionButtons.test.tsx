// @vitest-environment jsdom

import type { ComponentProps, ReactNode } from "react";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { Agent } from "@paperclipai/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentActionButtons } from "./AgentActionButtons";
import { i18n } from "../i18n";

const mockSeatList = vi.hoisted(() => vi.fn(async () => [] as Array<{ agentId: string }>));
vi.mock("../api/dsp7-seats", () => ({ dsp7SeatsApi: { list: mockSeatList } }));

const mockNavigate = vi.hoisted(() => vi.fn());
const mockOpenNewIssue = vi.hoisted(() => vi.fn());
const mockPushToast = vi.hoisted(() => vi.fn());
const mockAgentsApi = vi.hoisted(() => ({
  invoke: vi.fn(),
  pause: vi.fn(),
  resume: vi.fn(),
  clearError: vi.fn(),
  approve: vi.fn(),
  terminate: vi.fn(),
  resetSession: vi.fn(),
  instructionsBundle: vi.fn(),
  instructionsFile: vi.fn(),
  create: vi.fn(),
  hire: vi.fn(),
}));

vi.mock("@/lib/router", () => ({
  Link: ({ children, to, ...props }: { children: ReactNode; to: string }) => (
    <a href={to} {...props}>{children}</a>
  ),
  useNavigate: () => mockNavigate,
}));

vi.mock("../context/DialogContext", () => ({
  useDialogActions: () => ({ openNewIssue: mockOpenNewIssue }),
}));

vi.mock("../context/ToastContext", () => ({
  useToastActions: () => ({ pushToast: mockPushToast }),
}));

vi.mock("../api/agents", () => ({
  agentsApi: mockAgentsApi,
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

async function act(callback: () => void | Promise<void>) {
  let result: void | Promise<void> = undefined;
  flushSync(() => {
    result = callback();
  });
  await result;
}

async function flushReact() {
  await act(async () => {
    await Promise.resolve();
    await new Promise((resolve) => window.setTimeout(resolve, 0));
  });
}

function makeAgent(overrides: Partial<Agent> = {}): Agent {
  return {
    id: "agent-1",
    companyId: "company-1",
    name: "Alpha Agent",
    urlKey: "alpha",
    role: "engineer",
    title: null,
    icon: null,
    status: "active",
    reportsTo: null,
    capabilities: null,
    adapterType: "codex_local",
    adapterConfig: { command: "claude" },
    runtimeConfig: {},
    budgetMonthlyCents: 0,
    spentMonthlyCents: 0,
    pauseReason: null,
    pausedAt: null,
    permissions: { canCreateAgents: false },
    lastHeartbeatAt: null,
    metadata: null,
    createdAt: new Date("2026-01-01T00:00:00Z"),
    updatedAt: new Date("2026-01-01T00:00:00Z"),
    ...overrides,
  };
}

describe("AgentActionButtons", () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot> | null;
  let queryClient: QueryClient;
  let invalidateQueries: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    await i18n.changeLanguage("en");
    mockSeatList.mockResolvedValue([]);
    container = document.createElement("div");
    document.body.appendChild(container);
    root = null;
    queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    invalidateQueries = vi.spyOn(queryClient, "invalidateQueries") as unknown as ReturnType<typeof vi.fn>;
    mockAgentsApi.clearError.mockResolvedValue(makeAgent({ status: "idle" }));
    mockAgentsApi.pause.mockResolvedValue(makeAgent({ status: "paused" }));
    mockAgentsApi.resume.mockResolvedValue(makeAgent({ status: "idle" }));
    mockAgentsApi.terminate.mockResolvedValue(makeAgent({ status: "terminated" }));
    mockAgentsApi.invoke.mockResolvedValue({ id: "run-1" });
    mockAgentsApi.resetSession.mockResolvedValue(undefined);
  });

  afterEach(async () => {
    const currentRoot = root;
    if (currentRoot) {
      await act(async () => {
        currentRoot.unmount();
      });
    }
    queryClient.clear();
    container.remove();
    document.body.innerHTML = "";
    vi.clearAllMocks();
  });

  function render(agent: Agent, props: Partial<ComponentProps<typeof AgentActionButtons>> = {}) {
    root ??= createRoot(container);
    root.render(
      <QueryClientProvider client={queryClient}>
        <AgentActionButtons agent={agent} companyId="company-1" runLabel="Run Heartbeat" {...props} />
      </QueryClientProvider>,
    );
  }

  it("uses the seat registry when restricted responses hide configuration", async () => {
    mockSeatList.mockResolvedValue([{ agentId: "agent-1" }]);
    render(makeAgent({ adapterConfig: {} }));
    await vi.waitFor(async () => {
      await flushReact();
      expect(container.textContent).toContain("派发 Jira 工单");
    });
    expect(container.textContent).not.toContain("Run Heartbeat");
    expect(mockAgentsApi.invoke).not.toHaveBeenCalled();
  });

  it("does not expose generic actions while execution identity is unknown", async () => {
    mockSeatList.mockImplementationOnce(() => new Promise(() => {}));
    render(makeAgent({ adapterConfig: {} }));
    await flushReact();
    expect(container.textContent).toContain("正在核对执行身份");
    expect(container.textContent).not.toContain("Assign Task");
    expect(container.textContent).not.toContain("Run Heartbeat");
  });

  it("routes registered seats through Jira dispatch instead of generic mutations", async () => {
    render(makeAgent({ adapterConfig: { dsp7Seat: { name: "My Mac" } } }), { canRunWithProviderTrace: true });
    await flushReact();
    const buttons = Array.from(container.querySelectorAll("button"));
    expect(buttons.map(button => button.textContent)).toEqual(["派发 Jira 工单", "查看关联席位"]);
    await act(async () => buttons[0].click());
    expect(mockNavigate).toHaveBeenLastCalledWith("/jira-intake?seat=agent-1");
    await act(async () => buttons[1].click());
    expect(mockNavigate).toHaveBeenLastCalledWith("/seats?scope=all&view=work&seat=agent-1");
    expect(mockOpenNewIssue).not.toHaveBeenCalled();
    for (const api of Object.values(mockAgentsApi)) expect(api).not.toHaveBeenCalled();
  });

  it("honors the unsaved-config navigation guard for outbound seats", async () => {
    const guard = vi.fn(() => false);
    render(makeAgent({ adapterConfig: { dsp7Transport: "outbound" } }), {
      hasPendingNavigationChanges: true, onBeforeNavigate: guard,
    });
    await flushReact();
    await act(async () => container.querySelector<HTMLButtonElement>("button")?.click());
    expect(guard).toHaveBeenCalledOnce();
    expect(mockNavigate).not.toHaveBeenCalled();
  });

  it("retains direct task assignment and invocation for independent server agents", async () => {
    mockAgentsApi.invoke.mockResolvedValue({ id: "run-1" });
    render(makeAgent({ adapterConfig: { command: "claude" } }));
    await flushReact();
    const buttons = Array.from(container.querySelectorAll("button"));
    await act(async () => buttons.find(button => button.textContent?.includes("Assign Task"))?.click());
    expect(mockOpenNewIssue).toHaveBeenCalledWith({ assigneeAgentId: "agent-1" });
    await act(async () => buttons.find(button => button.textContent?.includes("Run Heartbeat"))?.click());
    await flushReact();
    expect(mockAgentsApi.invoke).toHaveBeenCalledOnce();
    expect(container.textContent).not.toContain("查看关联席位");
  });

  it("replaces the pause slot with Clear error for error agents", async () => {
    render(makeAgent({ status: "error" }));
    await flushReact();

    expect(container.textContent).toContain("Clear error");
    expect(container.textContent).not.toContain("Pause");
    expect(container.textContent).toContain("Run Heartbeat");

    await act(async () => {
      container.querySelector<HTMLButtonElement>('[aria-label="Open actions for Alpha Agent"]')?.click();
    });
    await flushReact();

    expect(document.body.textContent).toContain("Reset Sessions");
  });

  it("calls clearError and refreshes agent-related queries", async () => {
    render(makeAgent({ status: "error" }));
    await flushReact();

    await act(async () => {
      container.querySelector<HTMLButtonElement>('[aria-label="Clear error and return agent to idle"]')?.click();
    });
    await flushReact();

    expect(mockAgentsApi.clearError).toHaveBeenCalledWith("agent-1", "company-1");
    expect(invalidateQueries).toHaveBeenCalledWith({ queryKey: ["agents", "detail", "agent-1"] });
    expect(invalidateQueries).toHaveBeenCalledWith({ queryKey: ["agents", "detail", "alpha"] });
    expect(invalidateQueries).toHaveBeenCalledWith({ queryKey: ["agents", "runtime-state", "agent-1"] });
    expect(invalidateQueries).toHaveBeenCalledWith({ queryKey: ["agents", "task-sessions", "agent-1"] });
    expect(invalidateQueries).toHaveBeenCalledWith({ queryKey: ["agents", "company-1"] });
    expect(invalidateQueries).toHaveBeenCalledWith({ queryKey: ["live-runs", "company-1"] });
    expect(invalidateQueries).toHaveBeenCalledWith({ queryKey: ["heartbeats", "company-1", "agent-1"] });
  });

  it("keeps the normal pause action for non-error agents", async () => {
    render(makeAgent({ status: "active" }));
    await flushReact();

    expect(container.textContent).toContain("Pause");
    expect(container.textContent).not.toContain("Clear error");
  });

  it("starts an administrator-selected run with raw provider tracing", async () => {
    render(makeAgent(), { canRunWithProviderTrace: true });
    await flushReact();

    const traceButton = Array.from(container.querySelectorAll("button")).find(
      (button) => button.textContent?.includes("Run with provider trace"),
    );
    expect(traceButton).toBeTruthy();

    await act(async () => {
      traceButton?.click();
    });
    await flushReact();

    expect(mockAgentsApi.invoke).toHaveBeenCalledWith("agent-1", "company-1", {
      debug: { providerTrace: "raw" },
    });
    expect(mockNavigate).toHaveBeenCalledWith("/agents/alpha/runs/run-1");
  });

  it("calls the terminate success handler after terminating an agent", async () => {
    const onTerminateSuccess = vi.fn();
    render(makeAgent(), { onTerminateSuccess });
    await flushReact();

    await act(async () => {
      container.querySelector<HTMLButtonElement>('[aria-label="Open actions for Alpha Agent"]')?.click();
    });
    await flushReact();

    const terminateButton = Array.from(document.body.querySelectorAll("button"))
      .find((button) => button.textContent?.includes("Terminate"));
    expect(terminateButton).toBeTruthy();

    await act(async () => {
      terminateButton?.click();
    });
    await flushReact();

    expect(mockAgentsApi.terminate).toHaveBeenCalledWith("agent-1", "company-1");
    expect(onTerminateSuccess).toHaveBeenCalledWith(expect.objectContaining({
      id: "agent-1",
      status: "terminated",
    }));
    expect(invalidateQueries).toHaveBeenCalledWith({ queryKey: ["agents", "detail", "agent-1"] });
    expect(invalidateQueries).toHaveBeenCalledWith({ queryKey: ["agents", "detail", "alpha"] });
    expect(invalidateQueries).toHaveBeenCalledWith({ queryKey: ["agents", "company-1"] });
  });

  it("does not terminate when navigation away from a dirty detail page is rejected", async () => {
    const onBeforeNavigate = vi.fn().mockReturnValue(false);
    render(makeAgent(), { onBeforeNavigate, onTerminateSuccess: vi.fn() });
    await flushReact();

    await act(async () => {
      container.querySelector<HTMLButtonElement>('[aria-label="Open actions for Alpha Agent"]')?.click();
    });
    await flushReact();

    const terminateButton = Array.from(document.body.querySelectorAll("button"))
      .find((button) => button.textContent?.includes("Terminate"));
    await act(async () => {
      terminateButton?.click();
    });
    await flushReact();

    expect(onBeforeNavigate).toHaveBeenCalledOnce();
    expect(mockAgentsApi.terminate).not.toHaveBeenCalled();
  });

  it("rechecks navigation when the form becomes dirty while termination is pending", async () => {
    let resolveTermination!: (agent: Agent) => void;
    mockAgentsApi.terminate.mockReturnValue(new Promise((resolve) => {
      resolveTermination = resolve;
    }));
    const onBeforeNavigate = vi.fn().mockReturnValueOnce(true).mockReturnValue(false);
    const onTerminateSuccess = vi.fn();
    const agent = makeAgent();
    render(agent, {
      hasPendingNavigationChanges: false,
      onBeforeNavigate,
      onTerminateSuccess,
    });
    await flushReact();

    await act(async () => {
      container.querySelector<HTMLButtonElement>('[aria-label="Open actions for Alpha Agent"]')?.click();
    });
    await flushReact();
    const terminateButton = Array.from(document.body.querySelectorAll("button"))
      .find((button) => button.textContent?.includes("Terminate"));
    await act(async () => {
      terminateButton?.click();
    });
    await flushReact();

    render(agent, {
      hasPendingNavigationChanges: true,
      onBeforeNavigate,
      onTerminateSuccess,
    });
    await flushReact();
    resolveTermination(makeAgent({ status: "terminated" }));
    await flushReact();

    expect(onBeforeNavigate).toHaveBeenCalledTimes(2);
    expect(onTerminateSuccess).not.toHaveBeenCalled();
  });
});
