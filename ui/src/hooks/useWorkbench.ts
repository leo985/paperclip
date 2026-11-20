import { deliveryWorkflowApi } from "@/api/delivery-workflows";
import { useQuery } from "@tanstack/react-query";
import { analysisApi } from "@/api/analysis-executions";
import { attentionApi } from "@/api/attention";
import { useSearchParams } from "@/lib/router";
import { workbenchActions, workbenchTab } from "@/lib/workbench";
import { useManagementAccess } from "./useManagementAccess";
import { useManagementOverview } from "./useManagementOverview";

export function useWorkbench(companyId: string) {
  const [params] = useSearchParams();
  const access = useManagementAccess();
  const tab = workbenchTab(params, access.canManage);
  const scope = tab === "organization" || tab === "diagnostics" ? "company" : "mine";
  const work = useManagementOverview(companyId, scope);
  const analysis = useQuery({ queryKey: ["workbench-analysis-actions", companyId], queryFn: () => analysisApi.pendingActions(companyId), refetchInterval: 10000, retry: false });
  const platform = useQuery({ queryKey: ["workbench-platform-actions", companyId], queryFn: () => attentionApi.list(companyId, { all: true, includeDismissed: true, includeArchived: true }), enabled: !!work.userId, refetchInterval: 10000, retry: false });
  const delivery = useQuery({queryKey:["workbench-delivery-actions",companyId,scope],queryFn:()=>deliveryWorkflowApi.pendingActions(companyId,scope),refetchInterval:5000,retry:false});
  const evidenceReady = work.seats.isSuccess && work.live.isSuccess;
  const actions = workbenchActions({ rows: work.rows, seats: work.seats.data ?? [], analysis: analysis.data ?? [], platform: platform.data?.items ?? [], delivery: delivery.data,
    scope, userId: work.userId, projectId: params.get("projectId"), executionEvidenceReady: evidenceReady });
  const complete = !access.loading && work.complete && evidenceReady && analysis.isSuccess && delivery.isSuccess && (!work.userId || platform.isSuccess);
  const isError = access.error || work.collection.isError || work.seats.isError || work.live.isError || analysis.isError || platform.isError || delivery.isError;
  const refresh = () => { void work.collection.refetch(); void work.seats.refetch(); void work.live.refetch(); void analysis.refetch(); void delivery.refetch(); if (work.userId) void platform.refetch(); };
  return { ...work, tab, actions, complete, isError, refresh, access };
}
