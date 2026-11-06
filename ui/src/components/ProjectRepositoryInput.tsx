import { uiText } from "@/i18n/interface";
import { useQuery } from "@tanstack/react-query";
import type { ProjectRepository } from "@paperclipai/shared";
import { projectsApi } from "@/api/projects";
import { RepositoryEditor } from "./RepositoryEditor";
import { Button } from "./ui/button";

export const repositoryOptionsKey = (companyId: string) => ["project-repositories", companyId] as const;

export function ProjectRepositoryInput({ companyId, selected, onChange, onConnect, disabled }: {
  companyId: string;
  selected: ProjectRepository[];
  onChange: (repos: ProjectRepository[]) => void;
  onConnect: () => void;
  disabled?: boolean;
}) {
  const query = useQuery({ queryKey: repositoryOptionsKey(companyId), queryFn: () => projectsApi.repositoryOptions(companyId), staleTime: 30_000 });
  const state = query.isPending ? "loading" : query.isError ? "error"
    : !query.data.connectionCount && !query.data.repositories.length ? "disconnected"
    : query.data.failedConnectionCount && !query.data.repositories.length ? "error"
    : !query.data.repositories.length ? "empty" : "ready";
  return <div className="flex min-w-0 flex-col gap-3">
    <p className="text-xs text-muted-foreground">项目仓库可选。测试可直接使用已登记的测试 Harness 和目标环境；需要业务源码时，优先选择席位已有仓库，也可手工添加。已有仓库来自在线席位的源码白名单，未发现时请检查本机配置或刷新。</p>
    <RepositoryEditor selected={selected.map((repo) => {
      const current = query.data?.repositories.find((available) => available.id === repo.id);
      return current ? { ...current, ...(repo.source === "harness" && repo.repoRef ? { repoRef: repo.repoRef } : {}) } : repo;
    })} onChange={onChange} available={query.data?.repositories} state={state}
      onRetry={() => void query.refetch()} onConnect={onConnect} disabled={disabled} />
    <Button type="button" variant="ghost" size="sm" className="self-start" disabled={disabled || query.isFetching} onClick={() => void query.refetch()}>刷新已有仓库</Button>
    {!!query.data?.failedConnectionCount && query.data.repositories.length > 0 && <div role="alert" className="flex flex-wrap items-center gap-2 text-xs text-destructive">{uiText("Some GitHub connections could not load. Reconnect them in Apps or try again.")}{" "}<Button type="button" variant="ghost" size="sm" disabled={query.isFetching} onClick={() => void query.refetch()}>{uiText("Try again")}</Button>
    </div>}
  </div>;
}
