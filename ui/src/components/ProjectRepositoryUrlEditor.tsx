import { uiText } from "@/i18n/interface";
import { useId, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { ProjectWorkspace } from "@paperclipai/shared";
import { Link } from "lucide-react";
import { projectsApi } from "@/api/projects";
import { queryKeys } from "@/lib/queryKeys";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { Label } from "./ui/label";

/** Manual Git URLs use ordinary project workspaces, independent of GitHub connections. */
export function ProjectRepositoryUrlEditor({ workspace, projectId, companyId, projectRef, onClose, isPrimary }: {
  workspace?: ProjectWorkspace;
  projectId: string;
  companyId: string;
  projectRef: string;
  onClose?: () => void;
  isPrimary?: boolean;
}) {
  const client = useQueryClient();
  const id = useId();
  const [editing, setEditing] = useState(!workspace);
  const [url, setUrl] = useState(workspace?.repoUrl ?? "");
  const [ref, setRef] = useState(workspace?.repoRef ?? workspace?.defaultRef ?? "");
  const save = useMutation({
    mutationFn: async () => {
      let repoUrl = url.trim() || null;
      if (repoUrl) {
        // GitLab's SSH clone button uses scp syntax; the workspace API stores URLs.
        const scp = /^([\w.-]+)@([\w.-]+):([^\s]+)$/.exec(repoUrl);
        if (scp) repoUrl = `ssh://${scp[1]}@${scp[2]}/${scp[3]}`;
        let parsed: URL;
        try { parsed = new URL(repoUrl); } catch { throw new Error(uiText("Enter an HTTP, HTTPS, or SSH repository URL.")); }
        if (!["http:", "https:", "ssh:"].includes(parsed.protocol) || !parsed.hostname || !parsed.pathname.replace(/\//g, "") || parsed.password || (parsed.protocol !== "ssh:" && parsed.username) || parsed.search || parsed.hash || /[\r\n\0]/.test(repoUrl)) {
          throw new Error(uiText("Enter a repository URL without passwords, tokens, query parameters, or fragments."));
        }
      }
      if (!repoUrl && !workspace) throw new Error(uiText("Enter an HTTP, HTTPS, or SSH repository URL."));
      if (repoUrl && /[\r\n\0]/.test(ref)) throw new Error(uiText("Enter a branch or tag on a single line."));
      const data = { repoUrl, repoRef: repoUrl ? ref.trim() || null : null, defaultRef: repoUrl ? ref.trim() || null : null };
      if (workspace) {
        if (!repoUrl && !workspace.cwd && !workspace.remoteWorkspaceRef) return projectsApi.removeWorkspace(projectId, workspace.id, companyId);
        return projectsApi.updateWorkspace(projectId, workspace.id, { ...data, sourceType: repoUrl ? "git_repo" : workspace.cwd ? "local_path" : "remote_managed" }, companyId);
      }
      return projectsApi.createWorkspace(projectId, { ...data, sourceType: "git_repo", isPrimary }, companyId);
    },
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: queryKeys.projects.all(companyId) });
      void client.invalidateQueries({ queryKey: queryKeys.projects.detail(projectId) });
      void client.invalidateQueries({ queryKey: queryKeys.projects.detail(projectRef) });
      setEditing(false);
      onClose?.();
    },
  });
  return <div className="flex min-w-0 flex-col gap-2">
    {!editing ? <div className="flex min-w-0 items-center gap-3 rounded-md border border-border px-3 py-2">
      <Link className="size-4 shrink-0 text-muted-foreground" />
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <span className="break-all text-sm">{workspace?.repoUrl}</span>
        {(workspace?.repoRef || workspace?.defaultRef) && <span className="text-xs text-muted-foreground">{uiText("Baseline branch or tag")}: {workspace.repoRef || workspace.defaultRef}</span>}
      </div>
      <Button type="button" variant="ghost" size="sm" onClick={() => { setUrl(workspace?.repoUrl ?? ""); setRef(workspace?.repoRef ?? workspace?.defaultRef ?? ""); save.reset(); setEditing(true); }}>{uiText("Edit")}</Button>
    </div> : <form className="flex flex-col gap-2" onSubmit={(event) => { event.preventDefault(); if (!save.isPending) save.mutate(); }}>
      <Label htmlFor={`${id}-url`}>{uiText("Repository URL")}</Label>
      <Input id={`${id}-url`} value={url} disabled={save.isPending} placeholder="https://gitlab.example.com/group/project.git" autoCapitalize="none" autoCorrect="off" spellCheck={false} onChange={(event) => { setUrl(event.target.value); save.reset(); }} />
      <p className="text-xs text-muted-foreground">{uiText("Supports GitLab and other Git servers over HTTP, HTTPS, or SSH. Repository access uses Git credentials on the execution computer.")}</p>
      <Label htmlFor={`${id}-ref`}>{uiText("Baseline branch or tag")}</Label>
      <Input id={`${id}-ref`} value={ref} disabled={save.isPending} placeholder={uiText("For example: main or develop (optional)")} autoCapitalize="none" autoCorrect="off" spellCheck={false} onChange={(event) => { setRef(event.target.value); save.reset(); }} />
      {save.isError && <p role="alert" className="text-sm text-destructive">{save.error.message}</p>}
      <div className="flex items-center justify-between gap-2"><Button type="button" variant="ghost" disabled={save.isPending} onClick={() => { setEditing(false); onClose?.(); }}>{uiText("Cancel")}</Button><Button type="submit" disabled={save.isPending}>{save.isPending ? uiText("Saving…") : uiText("Save URL")}</Button></div>
    </form>}
  </div>;
}
