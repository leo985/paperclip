// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { Project, ProjectWorkspace } from "@paperclipai/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { projectsApi } from "../api/projects";
import { ProjectRepositoryInput } from "./ProjectRepositoryInput";
import { ProjectRepositories } from "./ProjectRepositories";
import { repositoryOptionsKey } from "./ProjectRepositoryInput";

vi.mock("../api/projects", () => ({ projectsApi: {
  repositoryOptions: vi.fn(), createWorkspace: vi.fn(), updateWorkspace: vi.fn(), removeWorkspace: vi.fn(), setRepositories: vi.fn(),
} }));
vi.mock("@/features/connections/ConnectionSetupFlow", () => ({ ConnectionSetupFlow: () => null }));
vi.mock("@/i18n/interface", () => ({ uiText: (text: string) => text, uiTextFormat: (text: string, values: string[]) => text.replace("__PCVAR0__", values[0]) }));

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root;
let container: HTMLDivElement;
let client: QueryClient;
const workspace = {
  id: "workspace-1", projectId: "project-1", companyId: "company-1", name: "DSP7",
  repoUrl: "http://gitlab.fingard.cn/QJ/ATSSAAS/dsp7.1_git.git", repoRef: "master", defaultRef: "master", cwd: null, metadata: null,
} as ProjectWorkspace;

beforeEach(() => {
  vi.resetAllMocks();
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
  Element.prototype.scrollIntoView = vi.fn();
  container = document.createElement("div"); document.body.appendChild(container); root = createRoot(container);
  client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  client.setQueryData(repositoryOptionsKey("company-1"), { repositories: [], connectionCount: 0, failedConnectionCount: 0 });
  vi.mocked(projectsApi.createWorkspace).mockResolvedValue(workspace);
  vi.mocked(projectsApi.updateWorkspace).mockResolvedValue(workspace);
});
afterEach(async () => { await act(async () => root.unmount()); client.clear(); container.remove(); vi.unstubAllGlobals(); });

async function render(workspaces: ProjectWorkspace[] = []) {
  const project = { id: "project-1", companyId: "company-1", urlKey: "base-platform", workspaces } as Project;
  await act(async () => root.render(<QueryClientProvider client={client}><ProjectRepositories project={project} /></QueryClientProvider>));
}
async function click(text: string) {
  const button = [...container.querySelectorAll("button")].find(b => b.textContent === text);
  expect(button).toBeDefined();
  await act(async () => button!.click());
}
async function fill(label: string, value: string) {
  const field = [...container.querySelectorAll("label")].find(l => l.textContent === label);
  const input = document.getElementById(field!.htmlFor) as HTMLInputElement;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

describe("manual project repositories", () => {
  it("offers existing seat repositories without requiring a GitHub connection", async () => {
    const repo = { id: "harness:" + "a".repeat(64), source: "harness", fullName: "team/app", url: "https://git.example/team/app", repoRef: "dev", connections: ["QA seat"] };
    client.setQueryData(repositoryOptionsKey("company-1"), { repositories: [repo], connectionCount: 0, failedConnectionCount: 0 });
    await render();
    expect(container.textContent).toContain("项目仓库可选");
    expect(container.textContent).toContain("选择席位已有仓库");
    expect(container.textContent).not.toContain("Add GitHub repo");
  });

  it("passes a selected Harness repository to the project form without a GitHub connection", async () => {
    const repo = { id: "harness:" + "b".repeat(64), source: "harness" as const, fullName: "team/app", url: "https://git.example/team/app", repoRef: "dev", connections: ["Seat"] };
    client.setQueryData(repositoryOptionsKey("company-1"), { repositories: [repo], connectionCount: 0, failedConnectionCount: 0 });
    const onChange = vi.fn();
    await act(async () => root.render(<QueryClientProvider client={client}><ProjectRepositoryInput companyId="company-1" selected={[]} onChange={onChange} onConnect={vi.fn()} /></QueryClientProvider>));
    await click("选择席位已有仓库");
    const combobox = container.querySelector('[role="combobox"]') as HTMLButtonElement;
    if (combobox.getAttribute("aria-expanded") !== "true") await act(async () => combobox.click());
    const option = [...document.querySelectorAll('[role="option"]')].find(node => node.textContent?.includes("team/app")) as HTMLElement;
    expect(option).toBeDefined();
    await act(async () => option.click());
    expect(onChange).toHaveBeenCalledWith([repo]);
  });

  it("retains an imported offline repository and its actual baseline", async () => {
    await render([{ ...workspace, name: "team/app", metadata: { harnessRepositoryId: "harness:" + "a".repeat(64) }, repoRef: "release" }]);
    expect(container.textContent).toContain("team/app");
    expect(container.textContent).toContain("基线：release");
    expect(container.textContent).toContain("项目仓库可选");
    expect(projectsApi.createWorkspace).not.toHaveBeenCalled();
  });

  it("adds a nested GitLab HTTP URL and baseline without a GitHub connection", async () => {
    await render();
    await click("Add GitLab / other Git repository");
    await fill("Repository URL", workspace.repoUrl!);
    await fill("Baseline branch or tag", " develop ");
    await click("Save URL");
    await vi.waitFor(() => expect(projectsApi.createWorkspace).toHaveBeenCalledWith("project-1", {
      repoUrl: workspace.repoUrl, repoRef: "develop", defaultRef: "develop", sourceType: "git_repo", isPrimary: true,
    }, "company-1"));
    expect(projectsApi.setRepositories).not.toHaveBeenCalled();
  });

  it("retains existing GitLab repositories and edits SSH clone syntax and the baseline", async () => {
    await render([workspace]);
    expect(container.textContent).toContain(workspace.repoUrl);
    expect(container.textContent).toContain("Baseline branch or tag: master");
    await click("Edit");
    await fill("Repository URL", "git@gitlab.fingard.cn:QJ/ATSSAAS/other.git");
    await fill("Baseline branch or tag", "release/7.1");
    await click("Save URL");
    await vi.waitFor(() => expect(projectsApi.updateWorkspace).toHaveBeenCalledWith("project-1", "workspace-1", {
      repoUrl: "ssh://git@gitlab.fingard.cn/QJ/ATSSAAS/other.git", repoRef: "release/7.1", defaultRef: "release/7.1", sourceType: "git_repo",
    }, "company-1"));
    expect(projectsApi.createWorkspace).not.toHaveBeenCalled();
  });

  it("keeps a local workspace when clearing its repository", async () => {
    await render([{ ...workspace, cwd: "/work/dsp7" }]);
    await click("Edit"); await fill("Repository URL", ""); await click("Save URL");
    await vi.waitFor(() => expect(projectsApi.updateWorkspace).toHaveBeenCalledWith("project-1", "workspace-1", {
      repoUrl: null, repoRef: null, defaultRef: null, sourceType: "local_path",
    }, "company-1"));
    expect(projectsApi.removeWorkspace).not.toHaveBeenCalled();
  });

  it("keeps the draft and shows save failures inline", async () => {
    vi.mocked(projectsApi.createWorkspace).mockRejectedValue(new Error("Access denied"));
    await render(); await click("Add GitLab / other Git repository");
    await fill("Repository URL", workspace.repoUrl!); await click("Save URL");
    await vi.waitFor(() => expect(container.querySelector('[role="alert"]')?.textContent).toBe("Access denied"));
    expect(container.querySelector("input")?.value).toBe(workspace.repoUrl);
  });

  it.each(["javascript:alert(1)", "https://user:secret@gitlab.example.com/group/repo.git", "https://gitlab.example.com/group/repo.git?token=secret"])("rejects unsafe repository URL %s", async (url) => {
    await render(); await click("Add GitLab / other Git repository");
    await fill("Repository URL", url); await click("Save URL");
    await vi.waitFor(() => expect(container.querySelector('[role="alert"]')).not.toBeNull());
    expect(projectsApi.createWorkspace).not.toHaveBeenCalled();
  });

  it("cancels adding a repository without saving", async () => {
    await render(); await click("Add GitLab / other Git repository"); await click("Cancel");
    expect(container.querySelector("form")).toBeNull();
    expect(projectsApi.createWorkspace).not.toHaveBeenCalled();
  });
});
