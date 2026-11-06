import type { Meta, StoryObj } from "@storybook/react-vite";
import { useEffect, useState } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ProjectWorkspace } from "@paperclipai/shared";
import { ProjectRepositoryUrlEditor } from "@/components/ProjectRepositoryUrlEditor";

const projectId = "project-gitlab-story";
const companyId = "company-storybook";
const initialWorkspace = {
  id: "gitlab-story-workspace", projectId, companyId, name: "group/platform",
  repoUrl: "https://gitlab.example.com/group/platform.git", repoRef: "develop", defaultRef: "develop",
  cwd: null, metadata: null,
} as ProjectWorkspace;

function ManualRepositoryStory({ existing = false }: { existing?: boolean }) {
  const [client] = useState(() => new QueryClient());
  const [workspace, setWorkspace] = useState<ProjectWorkspace | undefined>(existing ? initialWorkspace : undefined);
  useEffect(() => {
    const original = window.fetch;
    window.fetch = async (input, init) => {
      const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url, window.location.origin);
      if (url.pathname.startsWith(`/api/projects/${projectId}/workspaces`)) {
        const saved = { ...initialWorkspace, ...JSON.parse(String(init?.body ?? "{}")) };
        setWorkspace(saved);
        return Response.json(saved);
      }
      return original(input, init);
    };
    return () => { window.fetch = original; client.clear(); };
  }, [client]);
  return <QueryClientProvider client={client}>
    <div className="mx-auto max-w-2xl p-6">
      <ProjectRepositoryUrlEditor key={workspace?.id ?? "new"} workspace={workspace} projectId={projectId} companyId={companyId} projectRef={projectId} />
    </div>
  </QueryClientProvider>;
}

const meta = {
  title: "Projects/Repositories/Manual URL",
  component: ManualRepositoryStory,
  parameters: { layout: "fullscreen", docs: { description: { component: "Production repository editor for GitLab and other Git servers. Workspace writes use in-memory Storybook fixtures." } } },
} satisfies Meta<typeof ManualRepositoryStory>;
export default meta;
type Story = StoryObj<typeof meta>;
export const AddGitLab: Story = {};
export const ExistingGitLab: Story = { args: { existing: true } };
export const Mobile: Story = { globals: { viewport: { value: "mobile", isRotated: false } } };
