import { useEffect } from "react";
import { useInfiniteQuery } from "@tanstack/react-query";
import { issuesApi } from "@/api/issues";
import { queryKeys } from "@/lib/queryKeys";

/** Shared compact metadata only; never reads managed conversation bodies. */
export function useManagementIssues(companyId: string, participant?: string, workspace: string[] = []) {
  const query = useInfiniteQuery({
    queryKey: [...queryKeys.issues.list(companyId), "management-compact", participant, workspace.join(",")],
    queryFn: ({ pageParam, signal }) => issuesApi.listCompact(companyId, {
      includeRoutineExecutions: true, limit: 200, afterId: pageParam || undefined,
      participantAgentId: participant, workspaceId: workspace.length === 1 ? workspace[0] : undefined,
      sortField: "id", sortDir: "asc",
    }, { signal }),
    initialPageParam: "",
    getNextPageParam: last => last.length === 200 ? last[last.length - 1].id : undefined,
    enabled: !!companyId,
    refetchInterval: 30000,
  });
  useEffect(() => {
    if (query.hasNextPage && !query.isFetching && !query.isError) void query.fetchNextPage();
  }, [query.hasNextPage, query.isFetching, query.isError, query.dataUpdatedAt]);
  return query;
}
