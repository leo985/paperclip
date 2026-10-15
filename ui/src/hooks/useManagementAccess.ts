import { useQuery } from "@tanstack/react-query";
import { accessApi } from "@/api/access";
import { queryKeys } from "@/lib/queryKeys";
import { useCompany } from "@/context/CompanyContext";
import { authApi } from "@/api/auth";
import { healthApi } from "@/api/health";

export function useManagementAccess() {
  const { selectedCompanyId } = useCompany();
  const session = useQuery({ queryKey: queryKeys.auth.session, queryFn: authApi.getSession });
  const health = useQuery({ queryKey: queryKeys.health, queryFn: healthApi.get, enabled: false });
  const local = health.data?.deploymentMode === "local_trusted";
  const query = useQuery({ queryKey: queryKeys.access.currentBoardAccess, queryFn: accessApi.getCurrentBoardAccess, enabled: !!session.data && !local, retry: false });
  const access = query.data;
  const membership = access?.memberships?.find(m => m.companyId === selectedCompanyId && m.status === "active");
  const canManage = local || (!!session.data && !!access && (access.isInstanceAdmin || access.source === "local_implicit" || ["owner", "admin"].includes(membership?.membershipRole ?? "")));
  return { canOperate: canManage || (!!session.data && ["operator", "member"].includes(membership?.membershipRole ?? "")), isViewer: membership?.membershipRole === "viewer" && !canManage, canManage, isInstanceAdmin: local || (!!session.data && (!!access?.isInstanceAdmin || access?.source === "local_implicit")), loading: !local && (session.isPending || (!!session.data && query.isPending)), error: query.isError };
}
