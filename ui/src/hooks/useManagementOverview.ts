import { useQuery } from "@tanstack/react-query";
import { authApi } from "@/api/auth";
import { accessApi } from "@/api/access";
import { dsp7SeatsApi } from "@/api/dsp7-seats";
import { heartbeatsApi } from "@/api/heartbeats";
import { queryKeys } from "@/lib/queryKeys";
import { useSearchParams } from "@/lib/router";
import { filterManagementRows, managementRows } from "@/lib/management-work";
import { useManagementIssues } from "./useManagementIssues";
import { useManagementScope, type ManagementScope } from "./useManagementScope";

export function useManagementOverview(companyId: string, fixedScope?: ManagementScope) {
  const [params] = useSearchParams();
  const { scope, setScope } = useManagementScope(companyId, fixedScope);
  const session = useQuery({ queryKey: queryKeys.auth.session, queryFn: authApi.getSession });
  const collection = useManagementIssues(companyId);
  const seats = useQuery({ queryKey: ["dsp7-registered-seats", companyId], queryFn: () => dsp7SeatsApi.list(companyId), enabled: !!companyId, refetchInterval: 10000, retry: false });
  const live = useQuery({ queryKey: queryKeys.liveRuns(companyId), queryFn: () => heartbeatsApi.liveRunsForCompany(companyId), enabled: !!companyId, refetchInterval: 10000, retry: false });
  const users = useQuery({ queryKey: queryKeys.access.companyUserDirectory(companyId), queryFn: () => accessApi.listUserDirectory(companyId), enabled: !!companyId });
  const issues = [...new Map((collection.data?.pages.flat() ?? []).map(i => [i.id, i])).values()];
  const liveIds = new Set((live.data ?? []).filter(r => r.status === "running" && r.issueId).map(r => r.issueId!));
  const allRows = managementRows(issues, seats.data ?? [], liveIds, seats.isError || live.isError ? true : seats.isPending || live.isPending ? "loading" : false);
  const rows = filterManagementRows(allRows, scope, params.get("projectId"), session.data?.user.id);
  const userNames = new Map((users.data?.users ?? []).flatMap(u => [[u.principalId, u.user?.name ?? u.user?.email ?? "成员"], ...(u.user ? [[u.user.id, u.user.name ?? u.user.email ?? "成员"]] : [])] as Array<[string, string]>));
  const complete = collection.isSuccess && !collection.hasNextPage && !collection.isFetching && !collection.isError;
  return { rows, allRows, seats, live, collection, complete, scope, userNames, userId: session.data?.user.id, setScope };
}
