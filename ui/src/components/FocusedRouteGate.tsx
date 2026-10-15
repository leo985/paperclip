import type { ReactNode } from "react";
import { useLocation, Link, useParams, Navigate } from "@/lib/router";
import { useManagementAccess } from "@/hooks/useManagementAccess";

const administration = new Set(["management", "apps", "tools", "skills", "agents", "org", "costs", "activity", "audit", "timeline", "routines", "pipelines", "goals", "cases", "status", "board-chat", "workspaces", "artifacts", "companies", "onboarding", "plugins"]);
export function FocusedRouteGate({ children }: { children: ReactNode }) {
  const location = useLocation();
  const { companyPrefix } = useParams<{ companyPrefix: string }>();
  const { canManage, loading, isInstanceAdmin } = useManagementAccess();
  const segments = location.pathname.split("/").filter(Boolean);
  if (companyPrefix && segments[0]?.toUpperCase() === companyPrefix.toUpperCase()) segments.shift();
  const personal = segments.join("/") === "company/settings/instance/profile";
  const settings = segments[0] === "company" && ["settings", "export", "import"].includes(segments[1] ?? "") && !personal;
  const restricted = settings || administration.has(segments[0] ?? "");
  const instanceOnly = settings && (segments[2] === "personnel" || segments[2] === "instance");
  if (segments[0] === "agents" && !loading && !canManage) return <Navigate to={segments[2] === "runs" && segments[3] ? `/runs?run=${encodeURIComponent(segments[3])}` : `/runs?agent=${encodeURIComponent(segments[1] ?? "")}`} replace />;
  const projectSettings = segments[0] === "projects" && (["configuration", "budget", "workspaces", "plugin-operations", "overview"].includes(segments[2] ?? "") || ["configuration", "budget", "workspaces", "plugin-operations"].includes(new URLSearchParams(location.search).get("tab") ?? ""));
  if (projectSettings && !loading && !canManage) return <Navigate to={`/projects/${segments[1]}/issues`} replace />;
  if (!restricted && !projectSettings) return children;
  if (loading) return <p className="p-6 text-sm text-muted-foreground">正在核对管理权限…</p>;
  if (!canManage || (instanceOnly && !isInstanceAdmin)) return <section className="space-y-3 rounded-xl border border-border p-6"><h1 className="text-lg font-semibold">此页面需要管理员权限</h1><p className="text-sm text-muted-foreground">日常研发请使用工单、席位和待处理中心。个人设置与修改密码仍可使用。</p><Link to="/dashboard" className="text-primary underline">返回协同工作台</Link></section>;
  return children;
}
