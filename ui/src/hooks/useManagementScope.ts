import { useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { authApi } from "@/api/auth";
import { queryKeys } from "@/lib/queryKeys";
import { useSearchParams } from "@/lib/router";
import { useManagementAccess } from "./useManagementAccess";

export type ManagementScope = "mine" | "company";

export function resolveManagementScope(canManage: boolean, requested: string | null, remembered: string | null, fallback: ManagementScope = "company"): ManagementScope {
  if (!canManage) return "mine";
  if (requested === "mine" || requested === "company") return requested;
  if (remembered === "mine" || remembered === "company") return remembered;
  return fallback;
}

/** Shared by workbench and task collection; preferences are per user and company. */
export function useManagementScope(companyId: string, fixedScope?: ManagementScope) {
  const { canManage, loading } = useManagementAccess();
  const [params, setParams] = useSearchParams();
  const session = useQuery({ queryKey: queryKeys.auth.session, queryFn: authApi.getSession });
  const storageKey = session.data?.user.id ? `zhiyan:management-scope:${session.data.user.id}:${companyId}` : null;
  let remembered: string | null = null;
  try { remembered = storageKey ? localStorage.getItem(storageKey) : null; } catch { /* Optional preference. */ }
  const scope = resolveManagementScope(canManage, fixedScope ?? params.get("scope"), remembered);
  useEffect(() => {
    if (!storageKey || loading) return;
    try { localStorage.setItem(storageKey, scope); } catch { /* URL remains authoritative. */ }
  }, [storageKey, scope, loading]);
  return { scope, userId: session.data?.user.id, setScope: (value: ManagementScope) => setParams(previous => {
    const next = new URLSearchParams(previous);
    next.set("scope", canManage ? value : "mine");
    return next;
  }, { replace: true }) };
}
