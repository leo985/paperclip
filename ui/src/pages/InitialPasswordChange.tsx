import { useQuery } from "@tanstack/react-query";
import { authApi } from "@/api/auth";
import { ChangePasswordForm } from "@/components/ChangePasswordForm";
import { queryKeys } from "@/lib/queryKeys";
import { Navigate } from "@/lib/router";

export function InitialPasswordChange() {
  const session = useQuery({ queryKey: queryKeys.auth.session, queryFn: () => authApi.getSession(), retry: false });
  const status = useQuery({ queryKey: queryKeys.auth.passwordStatus, queryFn: () => authApi.passwordStatus(), enabled: !!session.data, retry: false });
  if (session.isLoading || !!session.data && status.isLoading) return <p className="p-6 text-sm">正在检查账号…</p>;
  if (!session.data) return <Navigate to="/auth" replace />;
  if (status.error) return <p role="alert" className="p-6 text-sm text-destructive">无法检查账号状态，请刷新重试。</p>;
  if (status.data && !status.data.required) return <Navigate to="/" replace />;
  return <main className="mx-auto max-w-2xl space-y-4 p-6"><h1 className="text-xl font-semibold">首次登录，请修改初始密码</h1><p className="text-sm text-muted-foreground">你的账号已自动启用。设置个人密码后即可进入工作台。</p><ChangePasswordForm requiredChange /></main>;
}
