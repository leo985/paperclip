import type { Issue, Project } from "@paperclipai/shared";
import { AlertTriangle, ArrowRight, CirclePlay, ListChecks, Network } from "lucide-react";
import { Link, useSearchParams } from "@/lib/router";
import { useManagementAccess } from "@/hooks/useManagementAccess";
import { useManagementOverview } from "@/hooks/useManagementOverview";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { ManagementWorkItem } from "./ManagementWorkItem";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

export function CollaborationWorkbench({ companyId, projects, projectsError, pendingApprovals }: {
  companyId: string; issues?: Issue[]; projects?: Project[]; projectsError?: boolean; pendingApprovals?: number; issuesError?: boolean;
}) {
  const { canManage } = useManagementAccess();
  const work = useManagementOverview(companyId);
  const [params, setParams] = useSearchParams();
  const projectFilter = params.get("projectId") || "all";
  const options = [...(projects ?? [])].sort((a, b) => a.name.localeCompare(b.name, "zh-CN"));
  const selectedProject = options.find(p => p.id === projectFilter);
  const href = (path: string, extra: Record<string, string> = {}) => path + "?" + new URLSearchParams({ scope: work.scope, ...(projectFilter !== "all" ? { projectId: projectFilter } : {}), ...extra });
  const groups = [
    { title: "需要处理与核实", subtitle: "阻塞、执行异常、人工决定及证据缺失", icon: AlertTriangle, rows: work.rows.filter(r => ["attention", "unknown"].includes(r.conclusion.group)), view: "attention", empty: "当前已采集范围内暂无待处理工单" },
    { title: "正在执行", subtitle: "具有当前执行证据，且无待处理提醒的工单", icon: CirclePlay, rows: work.rows.filter(r => r.conclusion.group === "running"), view: "running", empty: "当前没有已确认正在执行的工单" },
    { title: "待安排与调度", subtitle: "待办、登记与等待调度，启动仍需通过门禁", icon: ListChecks, rows: work.rows.filter(r => r.conclusion.group === "queued"), view: "pending", empty: "当前没有待安排工单" },
  ];
  const unlinkedAlerts = (work.seats.data ?? []).filter(s => work.scope === "company" || s.isMine).flatMap(s => (s.presence?.alerts ?? []).filter(a => !a.taskId).map(a => ({ ...a, seat: s })));
  return <section className="space-y-4" aria-label="协同工作台">
    <header className="workbench-heading flex flex-wrap items-center justify-between gap-4 rounded-xl border border-border bg-card p-5">
      <div className="space-y-2"><p className="text-xs font-medium text-primary">智研协同平台</p><h1 className="text-2xl font-semibold">{work.scope === "company" ? "组织管理概览" : "我的工作台"}</h1><p className="text-sm text-muted-foreground">先看风险与待办，再查看执行、交付和资源。</p></div>
      <div className="flex flex-wrap items-center gap-2">
        <div className="flex rounded-lg border border-border p-1" aria-label="工作台展示范围"><Button size="sm" variant={work.scope === "mine" ? "secondary" : "ghost"} aria-pressed={work.scope === "mine"} onClick={() => work.setScope("mine")}>我的工作</Button><Button size="sm" variant={work.scope === "company" ? "secondary" : "ghost"} aria-pressed={work.scope === "company"} onClick={() => work.setScope("company")}>组织概览</Button></div>
        <label htmlFor="workbench-project" className="text-sm text-muted-foreground">项目</label>
        <Select value={projectFilter} onValueChange={value => setParams(previous => { const next = new URLSearchParams(previous); value === "all" ? next.delete("projectId") : next.set("projectId", value); return next; }, { replace: true })}>
          <SelectTrigger id="workbench-project" className="w-56" aria-label="筛选项目"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="all">全部项目</SelectItem><SelectItem value="__none__">未关联项目</SelectItem>{projectFilter !== "all" && projectFilter !== "__none__" && !selectedProject && <SelectItem value={projectFilter}>{projectsError ? "项目暂时无法加载" : projects ? "项目不可用" : "正在加载项目…"}</SelectItem>}{options.map(project => <SelectItem key={project.id} value={project.id}>{project.name}{project.archivedAt ? "（已归档）" : ""}</SelectItem>)}</SelectContent>
        </Select>
        <Button size="sm" variant="outline" asChild><Link to={href("/delivery-workbench", { view: "reports" })}>交付报表</Link></Button><Button size="sm" variant="outline" asChild><Link to={`/seats?scope=${work.scope === "company" ? "all" : "mine"}`}><Network className="size-4" />查看席位</Link></Button>
      </div>
    </header>
    <div className="flex flex-wrap gap-2" aria-label="交付管理入口"><Button asChild variant="outline"><Link to={href("/delivery", { mRisk: "past_plan", mSort: "risk" })}>计划已过待核实</Link></Button><Button asChild variant="outline"><Link to={href("/delivery", { mRisk: "due_week", mSort: "deadline" })}>本周到期条目</Link></Button><Button asChild variant="outline"><Link to={href("/delivery", { mRisk: "missing_owner" })}>条目责任人缺失</Link></Button><Button asChild variant="outline"><Link to={href("/delivery-workbench", { view: "acceptance" })}>核对交付材料</Link></Button>{canManage && <Button asChild variant="ghost"><Link to="/setup">检查研发接入配置</Link></Button>}</div>
    <p className="text-xs text-muted-foreground">{work.scope === "company" ? "当前组织可见工单" : "直接指派给你及你负责的席位工单"} · {selectedProject?.name ?? (projectFilter === "__none__" ? "未关联项目" : projectFilter === "all" ? "全部项目" : "所选项目")} · {work.complete ? "已核对完整工单范围" : "工单范围正在核对或读取不完整，数量仅反映已加载数据"}。月度排期入口按组织和项目查看，非个人工单统计。</p>
    {(projectsError || work.collection.isError || work.seats.isError || work.live.isError) && <div role="alert" className="space-y-2 rounded-lg border border-border p-3 text-sm"><p>部分数据读取失败，不能据此认定没有风险或正在执行。已加载信息保留供核对。</p><Button size="sm" variant="outline" onClick={() => { void work.collection.refetch(); void work.seats.refetch(); void work.live.refetch(); }}>重新检查执行数据</Button>{projectsError && <p>项目列表读取失败，请刷新页面重试。</p>}</div>}
    <div className="grid gap-4 xl:grid-cols-3">{groups.map(({ title, subtitle, icon: Icon, rows, view, empty }) => <Card key={view} className="flex min-w-0 flex-col gap-3 rounded-xl p-4">
      <div className="flex items-center justify-between gap-2"><h2 className="flex items-center gap-2 text-sm font-semibold"><Icon className="size-4" />{title}</h2><Link className="rounded-md bg-muted px-2 py-1 text-xs tabular-nums" aria-label={`${title} ${rows.length} 项`} to={href("/issues", { view })}>{work.collection.isPending ? "—" : `${work.complete ? "" : "≥"}${rows.length}`}</Link></div><p className="text-xs text-muted-foreground">{subtitle}</p>
      {rows.slice(0, 3).map(row => <ManagementWorkItem key={row.issue.id} row={row} userNames={work.userNames} />)}{!rows.length && <p className="py-4 text-sm text-muted-foreground">{work.collection.isPending ? "正在核对工单…" : empty}</p>}
      <Link className="mt-auto inline-flex items-center gap-1 pt-3 text-xs font-medium text-primary" to={href("/issues", { view })}>查看对应工单<ArrowRight className="size-3" /></Link>
    </Card>)}</div>
    <div className="flex flex-wrap gap-4 text-sm"><Link className="underline" to={href("/inbox")}>打开待处理中心</Link>{unlinkedAlerts.length > 0 && <Link className="underline" to={`/seats?scope=${work.scope === "company" ? "all" : "mine"}`}>另有 {unlinkedAlerts.length} 条席位级提醒（不计入项目工单数量）</Link>}{pendingApprovals !== undefined && pendingApprovals > 0 && <Link className="underline" to="/approvals">组织待审批：{pendingApprovals} 项（独立于当前工单范围）</Link>}</div>
  </section>;
}
