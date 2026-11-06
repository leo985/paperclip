import type { ManagementRow } from "@/lib/management-work";
import { Link } from "@/lib/router";
import { timeAgo } from "@/lib/timeAgo";
import { IssueStatusBadge } from "./StatusBadge";
import { ManagementFollowUpControls } from "./ManagementFollowUpControls";

/** One task card merges its seat reminders without hiding the underlying evidence. */
export function ManagementWorkItem({ row, userNames }: { row: ManagementRow; userNames: Map<string, string> }) {
  const { issue, seat, alerts, conclusion, execution } = row;
  const owner = issue.assigneeUserId ? userNames.get(issue.assigneeUserId) ?? "人员信息待同步" : seat?.owner?.name ?? (issue.assigneeAgentId ? "执行负责人待核实" : "未指定负责人");
  const messages = [...new Set(alerts.map(a => a.message).filter(Boolean))];
  return <article className="space-y-3 rounded-lg border border-border p-3">
    <div className="flex flex-wrap items-center justify-between gap-2"><span className="font-mono text-xs text-muted-foreground">{issue.identifier}</span><span className={conclusion.group === "attention" ? "text-sm font-medium text-destructive" : "text-sm font-medium"}>{conclusion.label}</span></div>
    <Link className="block text-sm font-semibold hover:underline" to={`/issues/${issue.identifier ?? issue.id}`}>{issue.title}</Link>
    <p className="text-xs text-muted-foreground">处理负责人：{owner}{seat ? ` · 席位：${seat.name}` : ""}</p>
    {messages.length ? messages.map(message => <p key={message} className="text-sm">{message}</p>) : <p className="text-sm text-muted-foreground">{execution.reason}</p>}
    {alerts.length > 0 && <p className="text-xs text-muted-foreground">{seat?.online ? "最近上报" : "离线前上报，等待时长仅供参考"} · 已等待 {Math.max(...alerts.map(a => a.elapsedMinutes))} 分钟</p>}
    <p className="text-sm">下一步：{conclusion.nextAction}</p>
    <ManagementFollowUpControls companyId={issue.companyId} issueId={issue.id} />
    <div className="flex flex-wrap items-center justify-between gap-2 text-xs"><Link className="font-medium text-primary underline" to={`/issues/${issue.identifier ?? issue.id}`}>{conclusion.actionLabel}</Link>{seat && <Link className="underline" to={`/seats?seat=${seat.agentId}`}>查看席位</Link>}</div>
    <details className="text-xs text-muted-foreground"><summary className="cursor-pointer">状态依据与更新时间</summary><div className="space-y-2 pt-2"><p className="flex items-center gap-2">业务状态 <IssueStatusBadge status={issue.status} /></p><p>执行证据：{execution.label} · {execution.reason}</p><p>工单更新于 {timeAgo(issue.updatedAt)}</p><p>{seat?.presence ? `席位心跳：${new Date(seat.presence.lastSeenAt).toLocaleString("zh-CN")}${seat.online ? "" : "（已离线）"}` : "尚无席位心跳证据"}</p></div></details>
  </article>;
}
