import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { AlertTriangle, ArrowRight, CirclePlay, ListChecks, Network } from "lucide-react";
import type { Issue } from "@paperclipai/shared";
import { Link } from "@/lib/router";
import { authApi } from "@/api/auth";
import { dsp7SeatsApi } from "@/api/dsp7-seats";
import { queryKeys } from "@/lib/queryKeys";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { timeAgo } from "@/lib/timeAgo";

export function CollaborationWorkbench({ companyId, issues, pendingApprovals, issuesError }: {
  companyId: string; issues?: Issue[]; pendingApprovals?: number; issuesError?: boolean;
}) {
  const [scope, setScope] = useState<"mine" | "company">("mine");
  const session = useQuery({ queryKey: queryKeys.auth.session, queryFn: authApi.getSession });
  const seats = useQuery({ queryKey: ["dsp7-registered-seats", companyId], queryFn: () => dsp7SeatsApi.list(companyId), refetchInterval: 10000, retry: false });
  const visibleSeats = (seats.data ?? []).filter(seat => scope === "company" || seat.isMine);
  const myAgents = new Set((seats.data ?? []).filter(seat => seat.isMine).map(seat => seat.agentId));
  const visibleIssues = (issues ?? []).filter(issue => scope === "company"
    || (session.data?.user.id && issue.assigneeUserId === session.data.user.id)
    || (issue.assigneeAgentId && myAgents.has(issue.assigneeAgentId)));
  const alerts = visibleSeats.flatMap(seat => (seat.presence?.alerts ?? []).map(alert => ({ ...alert, seatName: seat.name, seatId: seat.agentId, online: seat.online }))).sort((a, b) => ({ urgent: 2, warning: 1, info: 0 }[b.level] - { urgent: 2, warning: 1, info: 0 }[a.level]) || b.elapsedMinutes - a.elapsedMinutes);
  const sorted = [...visibleIssues].sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());
  const blocked = sorted.filter(issue => issue.status === "blocked");
  const running = sorted.filter(issue => issue.status === "in_progress");
  const queued = sorted.filter(issue => issue.status === "todo" || issue.status === "backlog");
  const lists = [
    { title: "需要你处理", subtitle: "阻塞工单与人工决策", icon: AlertTriangle, items: blocked, tone: "text-amber-700 dark:text-amber-300", empty: "没有已记录的阻塞工单", to: "/inbox" },
    { title: "正在执行", subtitle: "已进入执行阶段的工单", icon: CirclePlay, items: running, tone: "text-primary", empty: "当前没有执行中的工单", to: "/issues" },
    { title: "待执行任务", subtitle: "待办与待排期工单", icon: ListChecks, items: queued, tone: "text-muted-foreground", empty: "当前没有待执行工单", to: "/issues" },
  ];
  return <section className="space-y-4" aria-label="协同工作台">
    <header className="workbench-heading flex flex-wrap items-center justify-between gap-4 rounded-xl border border-border bg-card px-5 py-5 sm:px-6">
      <div><p className="mb-1 text-xs font-medium text-primary">智研协同平台</p><h1 className="text-2xl font-semibold tracking-tight">协同工作台</h1><p className="mt-2 text-sm text-muted-foreground">查看研发任务、智能体执行与待处理决策</p></div>
      <div className="flex flex-wrap items-center gap-2">
        <div className="flex rounded-lg border border-border p-1" aria-label="工作台展示范围">
          <Button size="sm" variant={scope === "mine" ? "secondary" : "ghost"} aria-pressed={scope === "mine"} onClick={() => setScope("mine")}>我的工作</Button>
          <Button size="sm" variant={scope === "company" ? "secondary" : "ghost"} aria-pressed={scope === "company"} onClick={() => setScope("company")}>组织概览</Button>
        </div>
        <Button size="sm" asChild><Link to="/seats"><Network className="size-4" />查看席位</Link></Button>
      </div>
    </header>
    <p className="text-xs text-muted-foreground">{scope === "mine" ? "我的工作包含直接指派给你的工单，以及你负责的席位智能体工单。" : "展示当前组织内你有权限查看的工单与席位。"} 工单阶段不代表本机实时进程状态，实时状态请查看席位。</p>
    {seats.isError && <p role="status" className="text-sm text-amber-700 dark:text-amber-300">席位状态暂时无法加载，请到席位页检查。工单信息仍可查看。</p>}
    <div className="grid gap-4 xl:grid-cols-3">
      {lists.map(({ title, subtitle, icon: Icon, items, tone, empty, to }, index) => <Card key={title} className="flex min-w-0 flex-col rounded-xl p-4">
        <div className="flex items-center justify-between gap-2"><h2 className={`flex items-center gap-2 text-sm font-semibold ${tone}`}><Icon className="size-4" />{title}</h2><span className="rounded-md bg-muted px-2 py-0.5 text-xs tabular-nums">{issues ? items.length : "—"}</span></div>
        <p className="mt-1 mb-3 text-xs text-muted-foreground">{subtitle}</p>
        {index === 0 && alerts.slice(0, 3).map(alert => <Link key={`${alert.seatId}:${alert.id}`} to={alert.taskId ? `/issues/${alert.taskId}` : "/seats"} className="mb-2 rounded-lg border border-amber-500/20 bg-amber-500/5 p-3 hover:bg-amber-500/10">
          <p className="text-xs font-medium text-amber-700 dark:text-amber-300">{alert.jiraKey} · {alert.level === "urgent" ? "阻塞超时升级" : "席位提醒"}</p><p className="mt-1 line-clamp-2 text-sm">{alert.message}</p><p className="mt-1 text-xs text-muted-foreground">{alert.seatName}{!alert.online ? " · 席位离线，最后上报的提醒" : ""}</p>
        </Link>)}
        {!issues ? <p className="py-4 text-sm text-muted-foreground">{issuesError ? "工单暂时无法加载，请刷新后重试。" : "正在加载工单…"}</p> : items.length === 0 ? <p className="py-4 text-sm text-muted-foreground">{empty}</p> : <ul className="divide-y divide-border">{items.slice(0, 4).map(issue => <li key={issue.id}><Link to={`/issues/${issue.identifier ?? issue.id}`} className="block rounded-md px-1 py-3 hover:bg-accent/50"><span className="text-xs text-muted-foreground">{issue.identifier ?? "工单"}</span><p className="mt-1 line-clamp-2 text-sm font-medium">{issue.title}</p><p className="mt-1 text-xs text-muted-foreground">更新于 {timeAgo(issue.updatedAt)}</p></Link></li>)}</ul>}
        {index === 0 && pendingApprovals !== undefined && pendingApprovals > 0 && <Link to="/approvals" className="mt-2 rounded-lg border border-border p-3 text-sm hover:bg-accent/50">组织待审批：{pendingApprovals} 项<span className="block mt-1 text-xs text-muted-foreground">按审批权限处理，不包含在个人工单数量中</span></Link>}
        <Link to={to} className="mt-auto pt-3 inline-flex items-center gap-1 text-xs font-medium text-primary">{index === 0 ? "打开待处理中心" : "打开工单列表"}<ArrowRight className="size-3" /></Link>
      </Card>)}
    </div>
  </section>;
}
