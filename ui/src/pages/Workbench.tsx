import { lazy, Suspense, useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { projectsApi } from "@/api/projects";
import { useCompany } from "@/context/CompanyContext";
import { useBreadcrumbs } from "@/context/BreadcrumbContext";
import { useWorkbench } from "@/hooks/useWorkbench";
import { Link, useLocation, useSearchParams } from "@/lib/router";
import { queryKeys } from "@/lib/queryKeys";
import { timeAgo } from "@/lib/timeAgo";
import { createIssueDetailLocationState } from "@/lib/issueDetailBreadcrumb";
import type { WorkbenchAction, WorkbenchActionKind, WorkbenchTab } from "@/lib/workbench";
import { ManagementWorkItem } from "@/components/ManagementWorkItem";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

const Notifications = lazy(() => import("./Inbox").then(m => ({ default: m.Inbox })));
const Diagnostics = lazy(() => import("./Dashboard").then(m => ({ default: m.Dashboard })));
const actionLabels: Record<WorkbenchActionKind, string> = { work: "待人工办理", question: "待回答", review: "待评审", approval: "待审批", recovery: "待恢复与核实", local: "待本机确认", assignment: "待安排负责人" };

export function Workbench() {
  const { selectedCompanyId } = useCompany();
  return selectedCompanyId ? <CompanyWorkbench key={selectedCompanyId} companyId={selectedCompanyId} /> : <p className="p-4 text-sm text-muted-foreground">请先选择组织。</p>;
}

export function WorkbenchActionCard({ action, userNames, returnHref }: { action: WorkbenchAction; userNames: Map<string, string>; returnHref: string }) {
  const owner = action.ownerUserId ? userNames.get(action.ownerUserId) ?? "人员信息待同步" : "待组织管理员安排";
  const state = action.taskId ? createIssueDetailLocationState("工作台", returnHref, "issues") : undefined;
  return <article className="flex flex-col gap-3 rounded-lg border border-border bg-card p-4">
    <p className="text-xs font-medium text-primary">{actionLabels[action.kind]}{action.row?.issue.identifier ? ` · ${action.row.issue.identifier}` : ""}</p>
    <h3 className="text-sm font-semibold"><Link state={state} to={action.href}>{action.title}</Link></h3>
    <p className="line-clamp-3 whitespace-pre-wrap break-words text-sm text-muted-foreground">{action.reason}</p>
    <p className="text-xs text-muted-foreground">处理负责人：{owner} · {timeAgo(action.createdAt)}{action.row?.seat ? ` · ${action.row.seat.name}${action.row.seat.online ? "" : "（离线）"}` : ""}</p>
    {action.affectedTasks && <details className="text-sm"><summary className="cursor-pointer">受影响任务（{action.affectedTasks.length}）</summary><ul className="space-y-2 pt-2">{action.affectedTasks.map(row => <li key={row.issue.id}><Link state={createIssueDetailLocationState("工作台", returnHref, "issues")} className="underline" to={`/issues/${row.issue.identifier ?? row.issue.id}`}>{row.issue.identifier} · {row.issue.title}</Link></li>)}</ul></details>}
    <Button className="mt-auto self-start" variant="outline" size="sm" asChild><Link state={state} to={action.href}>{action.actionLabel}</Link></Button>
  </article>;
}

function CompanyWorkbench({ companyId }: { companyId: string }) {
  const work = useWorkbench(companyId);
  const [params, setParams] = useSearchParams();
  const location = useLocation();
  const { setBreadcrumbs } = useBreadcrumbs();
  const projects = useQuery({ queryKey: queryKeys.projects.list(companyId, { includeArchived: true }), queryFn: () => projectsApi.list(companyId, { includeArchived: true }) });
  useEffect(() => { setBreadcrumbs([{ label: "工作台" }]); }, [setBreadcrumbs]);
  const projectId = params.get("projectId") || "all";
  const kind = params.get("action") ?? "all";
  const selected = projects.data?.find(project => project.id === projectId);
  const returnHref = `${location.pathname}${location.search}${location.hash}`;
  const taskHref = (view: string) => `/issues?${new URLSearchParams({ scope: work.scope, ...(projectId !== "all" ? { projectId } : {}), view })}`;
  const deliveryHref = (extra: Record<string, string>) => `/delivery?${new URLSearchParams({ ...(projectId !== "all" ? { projectId } : {}), ...extra })}`;
  function patch(values: Record<string, string>) { setParams(previous => { const next = new URLSearchParams(previous); for (const [key, value] of Object.entries(values)) value ? next.set(key, value) : next.delete(key); return next; }, { replace: true }); }
  function changeTab(tab: WorkbenchTab) { patch({ tab, scope: tab === "organization" || tab === "diagnostics" ? "company" : "mine", action: "", attention: "" }); }
  const tabs: Array<[WorkbenchTab, string]> = [["pending", "待我处理"], ["following", "我的关注"], ...(work.access.canManage ? [["organization", "组织概览"] as [WorkbenchTab, string]] : []), ["notifications", "通知与历史"]];
  const visible = work.actions.filter(action => kind === "all" || action.kind === kind);
  const watchRows = work.rows.filter(row => ["attention", "unknown"].includes(row.conclusion.group) && !work.actions.some(action => action.taskId === row.issue.id || action.affectedTasks?.some(task => task.issue.id === row.issue.id)));
  const seatAlerts = (work.seats.data ?? []).filter(seat => work.scope === "company" || seat.isMine).filter(seat => seat.presence?.alerts.some(alert => !alert.taskId));

  return <div className="space-y-5">
    <header className="flex flex-wrap items-center justify-between gap-4">
      <div className="space-y-2"><h1 className="text-2xl font-semibold">工作台</h1><p className="text-sm text-muted-foreground">处理需要你操作的事项，查看任务进展与组织风险。</p></div>
      <div className="flex flex-wrap items-center gap-2"><Button variant="outline" size="sm" onClick={work.refresh}>刷新</Button><Button variant="outline" size="sm" asChild><Link to={taskHref("all")}>查看 AI 任务</Link></Button></div>
    </header>
    <nav aria-label="工作台视图" className="flex flex-wrap gap-2">{tabs.map(([tab, label]) => <Button key={tab} variant={work.tab === tab ? "secondary" : "ghost"} aria-pressed={work.tab === tab} onClick={() => changeTab(tab)}>{label}{tab === work.tab && (tab === "pending" || tab === "organization") ? ` · ${work.complete ? "" : "≥"}${work.actions.length}` : ""}</Button>)}</nav>
    {work.tab !== "notifications" && work.tab !== "diagnostics" && <div className="flex flex-wrap items-center gap-3"><label htmlFor="workbench-project" className="text-sm">项目</label><Select value={projectId} onValueChange={value => patch({ projectId: value === "all" ? "" : value })}><SelectTrigger id="workbench-project" className="w-56"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="all">全部项目</SelectItem><SelectItem value="__none__">未关联项目</SelectItem>{projectId !== "all" && projectId !== "__none__" && !selected && <SelectItem value={projectId}>所选项目暂不可用</SelectItem>}{projects.data?.map(project => <SelectItem key={project.id} value={project.id}>{project.name}{project.archivedAt ? "（已归档）" : ""}</SelectItem>)}</SelectContent></Select><p className="text-xs text-muted-foreground">{work.scope === "company" ? "组织范围；组织待办不等于你的个人待办" : "个人范围；直接指派给你或由你负责的席位任务"}</p></div>}
    {projects.isError && <p role="alert" className="text-sm text-destructive">项目列表读取失败，请刷新重试。已保留当前筛选。</p>}
    {work.tab !== "notifications" && !work.complete && <p role={work.isError ? "alert" : "status"} className="text-sm text-muted-foreground">{work.isError ? "部分待办或执行数据读取失败，当前清单不完整，请刷新重试。" : "正在核对待办和执行证据，数量仅反映已加载事项。"}</p>}

    {(work.tab === "pending" || work.tab === "organization") && <>
      {work.tab === "organization" && <div className="grid gap-3 sm:grid-cols-3">{([["running", "正在执行", work.rows.filter(row => row.conclusion.group === "running").length], ["pending", "待安排与调度", work.rows.filter(row => row.conclusion.group === "queued").length], ["attention", "需要关注与核实", work.rows.filter(row => ["attention", "unknown"].includes(row.conclusion.group)).length]] as const).map(([view, label, count]) => <Link key={view} className="space-y-2 rounded-lg border border-border p-4" to={taskHref(view)}><p className="text-sm">{label}</p><p className="text-xl font-semibold">{work.complete ? "" : "≥"}{count} 个任务</p></Link>)}</div>}
      <section className="space-y-4" aria-label={work.tab === "pending" ? "待我处理清单" : "组织待处理清单"}>
        <div className="flex flex-wrap items-center justify-between gap-3"><h2 className="font-semibold">{work.tab === "pending" ? "待我处理" : "组织待处理"} · {work.complete ? "" : "已加载 "}{work.actions.length} 项</h2><label className="text-sm">事项类型 <select aria-label="待办事项类型" className="rounded-md border border-border bg-background p-2" value={kind} onChange={event => patch({ action: event.target.value })}><option value="all">全部事项</option>{Object.entries(actionLabels).map(([value, label]) => <option key={value} value={value}>{label}（{work.actions.filter(action => action.kind === value).length}）</option>)}</select></label></div>
        <p className="text-xs text-muted-foreground">按待办事项计数；一个任务可以有多个问题。处理后以原任务、问题或审批的最新状态关闭，已读通知不会关闭待办。</p>
        <div className="grid gap-3 lg:grid-cols-2">{visible.map(action => <WorkbenchActionCard key={action.id} action={action} userNames={work.userNames} returnHref={returnHref} />)}</div>
        {!visible.length && <p className="py-4 text-sm text-muted-foreground">{work.complete ? "当前范围没有匹配的待办事项。" : "已加载范围内暂无匹配事项，完整结果仍待核对。"}</p>}
      </section>
      {(watchRows.length > 0 || seatAlerts.length > 0) && <details className="space-y-3 rounded-lg border border-border p-4"><summary className="cursor-pointer font-medium">需要关注的执行与设备信息（不计入待办）</summary><p className="text-xs text-muted-foreground">执行证据缺失或设备提醒需要核实，不直接认定任务已停止或需要审批。</p>{watchRows.map(row => <ManagementWorkItem key={row.issue.id} row={row} userNames={work.userNames} />)}{seatAlerts.map(seat => <div key={seat.agentId} className="space-y-2 text-sm"><Link className="underline" to={`/seats?seat=${seat.agentId}`}>{seat.name} · 核对设备提醒</Link>{seat.presence?.alerts.filter(alert => !alert.taskId).map(alert => <p key={alert.id}>{alert.message}</p>)}</div>)}</details>}
      {work.tab === "organization" && <div className="flex flex-wrap gap-3 text-sm"><Link className="underline" to={deliveryHref({ mRisk: "past_plan", mSort: "risk" })}>计划已过待核实</Link><Link className="underline" to={deliveryHref({ mRisk: "due_week" })}>本周到期条目</Link><Link className="underline" to={deliveryHref({ mRisk: "missing_owner" })}>条目责任人缺失</Link><Link className="underline" to="/delivery-workbench?view=acceptance">核对交付材料</Link><Link className="underline" to="/setup">检查研发接入配置</Link><Button variant="link" size="sm" onClick={() => changeTab("diagnostics")}>运行诊断与历史统计</Button></div>}
    </>}
    {work.tab === "following" && <section className="space-y-4"><h2 className="font-semibold">我的任务进展 · {work.complete ? "" : "已加载 "}{work.rows.length} 个任务</h2><p className="text-sm text-muted-foreground">查看我负责的任务及席位进展；需要操作的事项集中在“待我处理”。完整搜索和历史筛选请进入 AI 任务。</p><div className="grid gap-3 lg:grid-cols-2">{work.rows.slice(0, 12).map(row => <ManagementWorkItem key={row.issue.id} row={row} userNames={work.userNames} />)}</div>{!work.rows.length && <p className="text-sm text-muted-foreground">{work.complete ? "当前范围没有你负责的任务。" : "正在核对个人任务范围…"}</p>}<Button asChild variant="outline"><Link to={taskHref("all")}>在 AI 任务查看完整列表</Link></Button></section>}
    {work.tab === "notifications" && <section className="space-y-4"><h2 className="font-semibold">通知与历史收件记录</h2><p className="text-sm text-muted-foreground">保留运行通知、已读与归档记录。此处的已读、归档操作不代表任务完成；当前待办请到“待我处理”查看。</p><Suspense fallback={<p>正在加载通知…</p>}><Notifications embedded /></Suspense></section>}
    {work.tab === "diagnostics" && work.access.canManage && <Suspense fallback={<p>正在加载组织诊断…</p>}><Diagnostics /></Suspense>}
  </div>;
}
