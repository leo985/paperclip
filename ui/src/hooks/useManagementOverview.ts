import { useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { authApi } from "@/api/auth";
import { accessApi } from "@/api/access";
import { dsp7SeatsApi } from "@/api/dsp7-seats";
import { heartbeatsApi } from "@/api/heartbeats";
import { queryKeys } from "@/lib/queryKeys";
import { useSearchParams } from "@/lib/router";
import { filterManagementRows, managementRows } from "@/lib/management-work";
import { useManagementAccess } from "./useManagementAccess";
import { useManagementIssues } from "./useManagementIssues";

export function useManagementOverview(companyId: string) {
  const { canManage, loading: accessLoading } = useManagementAccess();
  const [params, setParams] = useSearchParams();
  const session = useQuery({ queryKey: queryKeys.auth.session, queryFn: authApi.getSession });
  const collection = useManagementIssues(companyId);
  const seats = useQuery({ queryKey: ["dsp7-registered-seats", companyId], queryFn: () => dsp7SeatsApi.list(companyId), enabled: !!companyId, refetchInterval: 10000, retry: false });
  const live = useQuery({ queryKey: queryKeys.liveRuns(companyId), queryFn: () => heartbeatsApi.liveRunsForCompany(companyId), enabled: !!companyId, refetchInterval: 10000, retry: false });
  const users = useQuery({ queryKey: queryKeys.access.companyUserDirectory(companyId), queryFn: () => accessApi.listUserDirectory(companyId), enabled: !!companyId });
  const storageKey = session.data?.user.id ? `zhiyan:management-scope:${session.data.user.id}:${companyId}` : null;
  let remembered: string | null = null;
  try { remembered = storageKey ? localStorage.getItem(storageKey) : null; } catch { /* URL state still works. */ }
  const requested = params.get("scope");
  const scope = requested === "mine" || requested === "company" ? requested : remembered === "mine" || remembered === "company" ? remembered : canManage ? "company" : "mine";
  useEffect(() => {
    if (!storageKey || accessLoading) return;
    try { localStorage.setItem(storageKey, scope); } catch { /* Optional browser preference. */ }
  }, [storageKey, scope, accessLoading]);
  const issues = [...new Map((collection.data?.pages.flat() ?? []).map(i => [i.id, i])).values()];
  const liveIds = new Set((live.data ?? []).filter(r => r.status === "running" && r.issueId).map(r => r.issueId!));
  const rows = filterManagementRows(managementRows(issues, seats.data ?? [], liveIds, seats.isError || live.isError ? true : seats.isPending || live.isPending ? "loading" : false), scope, params.get("projectId"), session.data?.user.id);
  const userNames = new Map((users.data?.users ?? []).flatMap(u => [[u.principalId, u.user?.name ?? u.user?.email ?? "成员"], ...(u.user ? [[u.user.id, u.user.name ?? u.user.email ?? "成员"]] : [])] as Array<[string, string]>));
  const complete = collection.isSuccess && !collection.hasNextPage && !collection.isFetching && !collection.isError;
  return { rows, seats, live, collection, complete, scope, userNames, setScope: (value: string) => setParams(previous => { const next = new URLSearchParams(previous); next.set("scope", value); return next; }, { replace: true }) };
}
