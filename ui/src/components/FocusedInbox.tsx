import { useQuery } from "@tanstack/react-query";
import { Link } from "@/lib/router";
import { useCompany } from "@/context/CompanyContext";
import { dsp7SeatsApi } from "@/api/dsp7-seats";
import { Inbox } from "@/pages/Inbox";
export function FocusedInbox() {
  const { selectedCompanyId } = useCompany();
  const seats = useQuery({ queryKey: ["dsp7-registered-seats", selectedCompanyId], queryFn: () => dsp7SeatsApi.list(selectedCompanyId!), enabled: !!selectedCompanyId, refetchInterval: 10000, retry: false });
  const alerts = (seats.data ?? []).flatMap(seat => (seat.presence?.alerts ?? []).map(alert => ({ ...alert, seatId: seat.agentId, name: seat.name, online: seat.online })));
  return <div className="space-y-5"><section className="space-y-3 rounded-xl border border-border bg-card p-4"><h2 className="font-semibold">席位阻塞与人工决策</h2><p className="text-xs text-muted-foreground">正式需求决策在 Jira/Harness 处理，平台审批使用下方审批操作，Claude 工具权限在本机处理。</p>{seats.isError ? <p className="text-sm text-destructive">席位提醒加载失败，请到席位页检查。</p> : !alerts.length ? <p className="text-sm text-muted-foreground">{seats.isPending ? "正在加载提醒…" : "当前没有已上报的席位提醒。"}</p> : alerts.map(alert => <Link key={`${alert.seatId}:${alert.id}`} to={alert.taskId ? `/issues/${alert.taskId}` : "/seats"} className="block rounded-lg border border-amber-500/30 bg-amber-500/5 p-3"><p className="text-sm font-medium">{alert.jiraKey} · {alert.name}{!alert.online ? "（离线，最后上报状态）" : ""}</p><p className="mt-1 text-sm">{alert.message}</p></Link>)}<Link to="/seats" className="text-sm text-primary underline">查看席位与提醒配置</Link></section><Inbox /></div>;
}
