import { Link, useSearchParams } from "@/lib/router";
import { useCompany } from "@/context/CompanyContext";
import { useManagementOverview } from "@/hooks/useManagementOverview";
import { Button } from "./ui/button";
import { ManagementWorkItem } from "./ManagementWorkItem";
import { Inbox } from "@/pages/Inbox";

export function FocusedInbox() {
  const { selectedCompanyId } = useCompany();
  return selectedCompanyId ? <ManagementInbox key={selectedCompanyId} companyId={selectedCompanyId} /> : <p>请先选择组织。</p>;
}
function ManagementInbox({ companyId }: { companyId: string }) {
  const work = useManagementOverview(companyId);
  const [params, setParams] = useSearchParams();
  const kind = params.get("attention") ?? "all";
  const rows = work.rows.filter(r => ["attention", "unknown"].includes(r.conclusion.group));
  const visible = rows.filter(r => kind === "all" || (kind === "unassigned" ? !r.seat?.owner && !r.issue.assigneeUserId : r.execution.kind === kind));
  const seatAlerts = (work.seats.data ?? []).filter(s => work.scope === "company" || s.isMine).flatMap(seat => (seat.presence?.alerts ?? []).filter(a => !a.taskId).map(a => ({ ...a, seat })));
  return <div className="space-y-5">
    <header className="space-y-3"><h1 className="text-2xl font-semibold">待处理中心</h1><p className="text-sm text-muted-foreground">按工单合并阻塞与席位提醒，先明确处理负责人和下一步。问题是否解决以原工单和最新证据为准。</p><div className="flex flex-wrap items-center gap-2"><Button variant={work.scope === "mine" ? "secondary" : "ghost"} aria-pressed={work.scope === "mine"} onClick={() => work.setScope("mine")}>我的工作</Button><Button variant={work.scope === "company" ? "secondary" : "ghost"} aria-pressed={work.scope === "company"} onClick={() => work.setScope("company")}>组织概览</Button><label className="text-sm">事项类型 <select aria-label="待处理事项类型" className="rounded-md border border-border bg-background p-2" value={kind} onChange={e => setParams(previous => { const next = new URLSearchParams(previous); next.set("attention", e.target.value); return next; }, { replace: true })}><option value="all">全部待处理</option><option value="waiting">等待人工决定</option><option value="local">等待本机确认</option><option value="error">执行异常</option><option value="offline">席位离线</option><option value="unknown">执行待核实</option><option value="unassigned">处理负责人缺失</option></select></label><Button variant="outline" onClick={() => { void work.collection.refetch(); void work.seats.refetch(); void work.live.refetch(); }}>刷新事项</Button></div>
      {params.get("projectId") && <p className="text-sm">已保留所选项目范围。<Button variant="ghost" size="sm" onClick={() => setParams(previous => { const next = new URLSearchParams(previous); next.delete("projectId"); return next; })}>查看全部项目</Button></p>}
    </header>
    {!work.complete && <p role="status" className="text-sm text-muted-foreground">{work.collection.isError ? "工单读取失败，待处理清单不完整，请刷新重试。" : "正在核对完整工单范围，以下为已加载事项。"}</p>}
    {(work.seats.isError || work.live.isError) && <p role="alert" className="text-sm text-destructive">执行证据读取失败，不能据此判断运行或等待，请刷新或进入工单核对。</p>}
    <section className="space-y-3" aria-label="工单待处理清单"><h2 className="font-semibold">{work.complete ? "" : "已加载 "}{rows.length} 个工单需要处理或核实 · 当前显示 {visible.length} 个</h2><div className="grid gap-3 lg:grid-cols-2">{visible.map(row => <ManagementWorkItem key={row.issue.id} row={row} userNames={work.userNames} />)}</div>{!visible.length && <p className="text-sm text-muted-foreground">{work.collection.isPending ? "正在加载…" : "当前范围没有匹配的已记录事项，可调整范围或事项类型。"}</p>}</section>
    {seatAlerts.length > 0 && <section className="space-y-3 rounded-lg border border-border p-4"><h2 className="font-semibold">席位级提醒（独立于项目工单筛选）</h2>{seatAlerts.map(alert => <article key={`${alert.seat.agentId}:${alert.id}`} className="space-y-2 text-sm"><p>{alert.seat.name} · 处理负责人：{alert.seat.owner?.name ?? "待管理员指定"}</p><p>{alert.message}</p><p className="text-xs text-muted-foreground">{alert.seat.online ? "最近上报" : "离线前上报，需重新核实"} · {alert.elapsedMinutes} 分钟</p><Link className="underline" to={`/seats?seat=${alert.seat.agentId}`}>检查设备与接单条件</Link></article>)}</section>}
    <details className="space-y-3 rounded-xl border border-border p-4"><summary className="cursor-pointer font-semibold">平台审批与运行通知</summary><p className="py-3 text-sm text-muted-foreground">下方保留独立审批与历史运行通知。同一工单可能有多次运行；通知归档或已读不会解决工单。正式需求决定在 Jira/Harness 处理，Claude 工具权限在本机处理。</p><Inbox /></details>
  </div>;
}
