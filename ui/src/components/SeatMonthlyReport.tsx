import { useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ArrowDown, ArrowRight, CalendarClock, ChevronDown, ChevronLeft, ChevronRight, CircleAlert, Clock3, RefreshCw, Users } from "lucide-react";
import { managedSessionsApi } from "@/api/managed-sessions";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { DeliveryProgressBar, deliveryProgressSegments } from "@/components/DeliveryProgressBar";
import { Link, useSearchParams } from "@/lib/router";
import {
  compareDeliveryPriority, deliveryCounts, groupDeliveryEmployees, groupDeliveryMainIssues, matchesDeliveryFilter, needsDeliveryAttention, UNASSIGNED,
  type DashboardFilter, type DashboardIssue,
} from "@/lib/delivery-dashboard";

const labels: Record<DashboardFilter, string> = {
  all: "本月全部", attention: "全部风险", remaining: "剩余", done: "已完成",
  overdue: "已逾期", due_soon: "7 天内到期", interrupted: "交付链中断",
  on_track: "其他待交付", unscheduled: "缺截止日", unassigned: "未分配负责人",
};
const filters: DashboardFilter[] = ["all", "attention", "remaining", "overdue", "due_soon", "interrupted", "done", "unscheduled", "unassigned"];
const deadlineLabels = { child: "子工单排期", main: "沿用主工单排期", demand: "条目期望交付日" };
const dateTime = new Intl.DateTimeFormat("zh-CN", { timeZone: "Asia/Shanghai", dateStyle: "short", timeStyle: "short" });
const monthPattern = /^(?:20[2-9]\d|2100)-(?:0[1-9]|1[0-2])$/;
const todayInShanghai = (time = Date.now()) => new Date(time + 8 * 3_600_000).toISOString().slice(0, 10);
const num = "font-mono tabular-nums";
const surface = "min-w-0 rounded-xl border border-border bg-card";
const field = "min-w-0 max-w-full rounded-md border border-input bg-background p-2 text-sm";
const pageSize = 20;
const noExpandedGroups: ReadonlySet<string> = new Set();

function issueHref(issue: DashboardIssue) {
  return "/delivery?" + new URLSearchParams({ projectId: issue.projectId, snapshotId: issue.snapshotId, tab: "work" });
}

function dueLabel(dueDate: string | null, today: string) {
  if (!dueDate) return "缺截止日";
  const days = Math.round((Date.parse(dueDate) - Date.parse(today)) / 86_400_000);
  if (!days) return "今天到期";
  return days < 0 ? `逾期 ${-days} 天` : `${days} 天后到期`;
}

function ProgressLegend() {
  return <div className="flex flex-wrap gap-x-4 gap-y-2 text-xs text-muted-foreground">
    {deliveryProgressSegments.map(({ state, color }) => <span key={state} className="flex items-center gap-2">
      <span aria-hidden="true" className={`size-2 rounded-full ${color}`} />{state === "waiting_for_deadline" ? "待补截止日" : labels[state]}
    </span>)}
  </div>;
}

function IssueStatus({ issue }: { issue: DashboardIssue }) {
  const tone = issue.risk === "overdue" ? "border-destructive/30 bg-destructive/10 text-destructive"
    : issue.risk === "due_soon" ? "border-delivery-soon/40 bg-delivery-soon/15"
    : issue.risk === "done" ? "border-delivery-done/35 bg-delivery-done/10"
    : "border-border bg-muted";
  return <div className="flex flex-wrap gap-1">
    <span className={`rounded-full border px-2 py-0.5 text-xs font-medium ${tone}`}>{labels[issue.risk]}</span>
    {issue.risk === "unscheduled" && issue.completed && <span className="rounded-full border border-delivery-done/35 bg-delivery-done/10 px-2 py-0.5 text-xs font-medium">已完成</span>}
    {issue.interrupted && <span className="rounded-full border border-destructive/30 bg-destructive/10 px-2 py-0.5 text-xs font-medium text-destructive">交付链中断</span>}
  </div>;
}

function MainIssueGroup({ group, ownersByIssue, expanded, onToggle }: {
  group: ReturnType<typeof groupDeliveryMainIssues>[number];
  ownersByIssue: ReadonlyMap<string, string[]>;
  expanded: boolean;
  onToggle: () => void;
}) {
  const Chevron = expanded ? ChevronDown : ChevronRight;

  return <tbody className="divide-y divide-border border-t border-border">
    <tr className="bg-muted/50">
      <th scope="rowgroup" colSpan={5} className="p-0 font-medium">
        <button type="button" aria-expanded={expanded} onClick={onToggle}
          className="flex w-full cursor-pointer items-center gap-2 rounded-sm p-3 text-left hover:bg-muted focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring">
          <Chevron aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" />
          <span className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <span>{group.parentKey ? <>主工单 <span className={num}>{group.parentKey}</span></> : "未关联主工单"}</span>
            <span className="text-xs text-muted-foreground">{group.projectName} · 当前筛选 {group.issues.length} 个子工单</span>
          </span>
        </button>
      </th>
    </tr>
    {expanded && group.issues.map(issue => <tr key={issue.id}>
      <th scope="row" className="min-w-44 p-3 align-top font-medium">
        <Link className="block break-words underline underline-offset-4" to={issueHref(issue)}>{issue.title || issue.key}</Link>
        <p className="text-xs text-muted-foreground"><span className={num}>{issue.key}</span> · {[issue.issueType, issue.projectName].filter(Boolean).join(" · ")}</p>
      </th>
      <td className="min-w-24 p-3 align-top">
        {ownersByIssue.get(issue.id)?.join("、") ?? "未匹配席位"}
        {issue.jiraAssignee && <p className="text-xs text-muted-foreground">Jira：{issue.jiraAssignee}</p>}
      </td>
      <td className="whitespace-nowrap p-3 align-top"><span className={num}>{issue.dueDate ?? "—"}</span>
        <p className="text-xs text-muted-foreground">{issue.deadlineSource ? deadlineLabels[issue.deadlineSource] : "待核对"}</p>
      </td>
      <td className="min-w-28 p-3 align-top"><IssueStatus issue={issue} />
        {issue.status && <p className="mt-1 text-xs text-muted-foreground">{issue.status}</p>}
      </td>
      <td className={`whitespace-nowrap p-3 align-top text-xs text-muted-foreground ${num}`}>{dateTime.format(new Date(issue.collectedAt))}</td>
    </tr>)}
  </tbody>;
}

export function SeatMonthlyReport({ companyId }: { companyId: string }) {
  const [params, setParams] = useSearchParams();
  const [employee, setEmployee] = useState("");
  const [employeeSearch, setEmployeeSearch] = useState("");
  const [riskOnly, setRiskOnly] = useState(false);
  const [detailFilter, setDetailFilter] = useState<DashboardFilter | null>(null);
  const [page, setPage] = useState(1);
  const [expansion, setExpansion] = useState<{ scope: string; ids: ReadonlySet<string> }>();
  const detailHeading = useRef<HTMLHeadingElement>(null);
  const requestedMonth = params.get("month") ?? "";
  const month = monthPattern.test(requestedMonth) ? requestedMonth : todayInShanghai().slice(0, 7);
  const project = params.get("projectId") ?? "";
  const report = useQuery({
    queryKey: ["seat-monthly-delivery", companyId, month],
    queryFn: () => managedSessionsApi.monthlyDelivery(companyId, month),
    retry: false,
  });

  function changeScope(key: "month" | "projectId", value: string) {
    setParams(previous => {
      const next = new URLSearchParams(previous);
      if (value) next.set(key, value); else next.delete(key);
      return next;
    });
    setEmployee("");
    setDetailFilter(null);
    setPage(1);
    setExpansion(undefined);
  }
  function shiftMonth(direction: number) {
    const next = new Date(`${month}-01T00:00:00Z`);
    next.setUTCMonth(next.getUTCMonth() + direction);
    changeScope("month", next.toISOString().slice(0, 7));
  }
  function showDetails(filter: DashboardFilter, employeeId = "") {
    if (detailFilter !== filter || employee !== employeeId) setExpansion(undefined);
    setDetailFilter(filter);
    setEmployee(employeeId);
    setPage(1);
    detailHeading.current?.focus();
  }

  const data = report.data;
  const projectOptions = new Map(data?.issues.map(issue => [issue.projectId, issue.projectName]));
  const issues = (data?.issues ?? []).filter(issue => !project || issue.projectId === project);
  const counts = deliveryCounts(issues);
  const { employees, unassigned } = groupDeliveryEmployees(data?.seats ?? [], issues);
  const byEmployee = new Map([...employees, unassigned].map(person => [person.id, person]));
  const currentEmployee = byEmployee.get(employee);
  const unassignedIds = new Set(unassigned.issues.map(issue => issue.id));
  const attention = issues.filter(needsDeliveryAttention).sort(compareDeliveryPriority);
  const filter = detailFilter ?? (attention.length ? "attention" : "all");
  const details = (currentEmployee?.issues ?? issues).filter(issue => matchesDeliveryFilter(issue, filter, unassignedIds))
    .sort(compareDeliveryPriority);
  const mainGroups = groupDeliveryMainIssues(details);
  const expansionScope = JSON.stringify([companyId, month, project, employee, filter]);
  const expandedGroups = expansion?.scope === expansionScope ? expansion.ids : noExpandedGroups;
  const allExpanded = mainGroups.length > 0 && mainGroups.every(group => expandedGroups.has(group.id));
  function toggleGroup(id: string) {
    setExpansion(previous => {
      const ids = new Set(previous?.scope === expansionScope ? previous.ids : noExpandedGroups);
      if (ids.has(id)) ids.delete(id); else ids.add(id);
      return { scope: expansionScope, ids };
    });
  }
  const pages = Math.max(1, Math.ceil(mainGroups.length / pageSize));
  const currentPage = Math.min(page, pages);
  const remaining = counts.total - counts.done;
  const today = todayInShanghai(data ? Date.parse(data.asOf) : Date.now());
  const percent = counts.total ? Math.round(100 * counts.done / counts.total) : null;
  const search = employeeSearch.trim().toLocaleLowerCase();
  const employeeRows = [...employees, ...(unassigned.issues.length ? [unassigned] : [])]
    .filter(person => !search || [person.name, ...person.seats].some(value => value.toLocaleLowerCase().includes(search)))
    .map(person => ({ ...person, stats: deliveryCounts(person.issues), riskCount: person.issues.filter(needsDeliveryAttention).length }))
    .filter(person => !riskOnly || person.riskCount > 0)
    .sort((a, b) => b.stats.overdue - a.stats.overdue || b.riskCount - a.riskCount || b.stats.total - a.stats.total || a.name.localeCompare(b.name, "zh-CN"));
  const ownersByIssue = new Map<string, string[]>();
  for (const person of employees) {
    for (const issue of person.issues) {
      const names = ownersByIssue.get(issue.id) ?? [];
      names.push(person.name);
      ownersByIssue.set(issue.id, names);
    }
  }

  return <section className="space-y-5" aria-label="席位看板">
    <header className="flex flex-wrap items-end justify-between gap-4">
      <div className="space-y-1">
        <h1 className="text-3xl font-semibold tracking-tight">席位看板</h1>
        <p className="text-sm text-muted-foreground">查看月度交付进度，优先跟进临期、逾期和中断的子工单。</p>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <div className="flex items-center gap-1 rounded-lg border border-border bg-card p-1">
          <Button size="icon-sm" variant="ghost" aria-label="上个月" disabled={month === "2020-01"} onClick={() => shiftMonth(-1)}><ChevronLeft /></Button>
          <Input className="w-auto border-0 bg-transparent shadow-none" type="month" min="2020-01" max="2100-12" aria-label="交付月份" value={month}
            onChange={event => { if (monthPattern.test(event.target.value)) changeScope("month", event.target.value); }} />
          <Button size="icon-sm" variant="ghost" aria-label="下个月" disabled={month === "2100-12"} onClick={() => shiftMonth(1)}><ChevronRight /></Button>
        </div>
        <select className={field} aria-label="项目范围" value={project} onChange={event => changeScope("projectId", event.target.value)}>
          <option value="">全部项目</option>
          {project && !projectOptions.has(project) && <option value={project}>所选项目</option>}
          {[...projectOptions].sort((a, b) => a[1].localeCompare(b[1], "zh-CN")).map(([id, name]) => <option key={id} value={id}>{name}</option>)}
        </select>
        <Button variant="outline" size="sm" disabled={report.isFetching} onClick={() => void report.refetch()}><RefreshCw /> 刷新数据</Button>
      </div>
    </header>

    {report.isPending && <p role="status" className="rounded-xl border border-border p-5 text-sm text-muted-foreground">正在汇总子工单和员工进度…</p>}
    {report.isError && <p role="alert" className="rounded-xl border border-destructive/30 bg-destructive/5 p-4 text-sm text-destructive">
      {data ? "刷新失败，当前显示上次读取的数据。" : "交付数据读取失败。"} {report.error.message}
    </p>}

    {data && <>
      <div className="grid gap-4 lg:grid-cols-2">
        <section className={`${surface} flex flex-col gap-5 p-5 md:p-6`} aria-labelledby="delivery-month-overview">
          <div className="flex items-start justify-between gap-3">
            <div className="space-y-1">
              <h2 id="delivery-month-overview" className="text-lg font-semibold">月度交付进度</h2>
              <p className="text-xs text-muted-foreground">统计轻舟当月条目下的 Jira 子工单</p>
            </div>
            <span className={`whitespace-nowrap rounded-full bg-muted px-3 py-1 text-xs text-muted-foreground ${num}`}>{month}</span>
          </div>
          <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
            <strong className={`text-5xl font-semibold tracking-tight ${num}`}>{percent === null ? "—" : `${percent}%`}</strong>
            <span className="text-sm text-muted-foreground">{percent === null ? "本月暂无可统计排期" : "本月完成率"}</span>
          </div>
          <div className="space-y-3">
            <DeliveryProgressBar emptyLabel="本月无已排期子工单" counts={counts} label="总体月度完成进度" large />
            <ProgressLegend />
          </div>
          <dl className="mt-auto grid grid-cols-3 divide-x divide-border border-t border-border pt-4">
            {([
              { label: "应完成", value: counts.total, filter: "all" },
              { label: "已完成", value: counts.done, filter: "done" },
              { label: "剩余", value: remaining, filter: "remaining" },
            ] as const).map(metric => <div key={metric.filter} className="px-3 first:pl-0">
              <dt><button type="button" className="cursor-pointer text-sm text-muted-foreground underline-offset-4 hover:underline" onClick={() => showDetails(metric.filter)}>{metric.label}</button></dt>
              <dd className={`text-2xl font-semibold ${num}`}>{metric.value}</dd>
            </div>)}
          </dl>
        </section>

        <section className={`${surface} space-y-4 p-5 md:p-6`} aria-labelledby="delivery-risk-queue">
          <div className="flex flex-wrap items-start justify-between gap-2">
            <div className="space-y-1">
              <h2 id="delivery-risk-queue" className="text-lg font-semibold">优先处理</h2>
              <p className="text-xs text-muted-foreground">已逾期优先，其次为中断、临期。</p>
            </div>
            <Button variant="ghost" size="sm" onClick={() => showDetails("attention")}>查看全部风险 <ArrowDown /></Button>
          </div>
          <div className="grid grid-cols-3 gap-2">
            {([
              ["overdue", counts.overdue, CircleAlert, "bg-destructive/10 text-destructive hover:bg-destructive/15"],
              ["due_soon", counts.due_soon, CalendarClock, "bg-delivery-soon/15 hover:bg-delivery-soon/25"],
              ["interrupted", counts.interrupted, Clock3, "bg-muted hover:bg-accent"],
            ] as const).map(([key, count, Icon, tone]) => <button key={key} type="button" onClick={() => showDetails(key)}
              className={`flex min-w-0 cursor-pointer flex-col items-start gap-1 rounded-lg p-3 text-left ${tone}`}>
              <span className="flex flex-wrap items-center gap-1 text-xs font-medium"><Icon className="size-3.5 shrink-0" aria-hidden="true" />{labels[key]}</span>
              <strong className={`text-xl font-semibold ${num}`}>{count}</strong>
            </button>)}
          </div>
          {attention.length ? <ul className="divide-y divide-border">
            {attention.slice(0, 3).map(issue => <li key={issue.id} className="flex items-start justify-between gap-3 py-2">
              <div className="min-w-0 space-y-0.5">
                <Link className="block truncate text-sm font-medium underline-offset-4 hover:underline" to={issueHref(issue)} title={issue.title}>{issue.title || issue.key}</Link>
                <p className="truncate text-xs text-muted-foreground"><span className={num}>{issue.key}</span> · {ownersByIssue.get(issue.id)?.join("、") ?? "未分配负责人"}</p>
              </div>
              <span className={`shrink-0 text-xs ${issue.risk === "overdue" ? "font-medium text-destructive" : "text-muted-foreground"}`}>
                {issue.interrupted && issue.risk !== "overdue" ? labels.interrupted : dueLabel(issue.dueDate, today)}
              </span>
            </li>)}
          </ul> : <p className="text-sm text-muted-foreground">{counts.total ? "已同步的工单中暂无逾期、临期或中断事项。" : "本月暂无足够排期数据判断到期风险。"}</p>}
        </section>
      </div>

      {(counts.unscheduled > 0 || unassigned.issues.length > 0) && <aside className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-delivery-soon/35 bg-delivery-soon/10 p-4" aria-label="待补齐交付数据">
        <div className="flex min-w-0 items-start gap-3">
          <CircleAlert className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
          <div className="space-y-1">
            <h2 className="text-sm font-semibold">待补齐交付数据</h2>
            <p className="text-xs text-muted-foreground">已归月的子工单即使缺截止日也计入进度。旧快照需重新同步补齐。未归属的工单可在席位接单设置中核对 Jira 账号。</p>
          </div>
        </div>
        <div className="flex flex-wrap gap-2">
          {counts.unscheduled > 0 && <Button size="sm" variant="outline" onClick={() => showDetails("unscheduled")}>缺截止日 <span className={num}>{counts.unscheduled}</span></Button>}
          {unassigned.issues.length > 0 && <Button size="sm" variant="outline" onClick={() => showDetails("unassigned")}>未分配负责人 <span className={num}>{unassigned.issues.length}</span></Button>}
          <Button size="sm" variant="ghost" asChild><Link to={"/delivery?" + new URLSearchParams({ month, ...(project ? { projectId: project } : {}) })}>查看月度条目 <ArrowRight /></Link></Button>
        </div>
      </aside>}

      <section className={`${surface} p-5 md:p-6`} aria-labelledby="employee-delivery-progress">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="space-y-1">
            <h2 id="employee-delivery-progress" className="flex items-center gap-2 text-lg font-semibold"><Users className="size-5 text-muted-foreground" aria-hidden="true" />员工月度进度</h2>
            <p className="text-xs text-muted-foreground">按负责人汇总多个席位，同一员工的协作工单只计一次。</p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Input aria-label="搜索员工或席位" placeholder="搜索员工或席位" className="w-44 max-w-full" value={employeeSearch} onChange={event => setEmployeeSearch(event.target.value)} />
            <Button size="sm" variant={riskOnly ? "secondary" : "outline"} aria-pressed={riskOnly} onClick={() => setRiskOnly(!riskOnly)}>仅看有风险</Button>
          </div>
        </div>
        {employeeRows.length > 0 ? <div className="mt-4 divide-y divide-border border-t border-border">
          {employeeRows.map(person => {
            const { stats } = person;
            const completion = stats.total ? Math.round(100 * stats.done / stats.total) : null;
            const personFilter = stats.total ? "all" : person.id === UNASSIGNED ? "unassigned" : "unscheduled";
            return <div key={person.id} className="grid min-w-0 gap-3 py-4 sm:grid-cols-12 sm:items-center">
              <div className="min-w-0 space-y-1 sm:col-span-3">
                <button type="button" onClick={() => showDetails(personFilter, person.id)}
                  className="cursor-pointer break-words text-left text-sm font-semibold underline-offset-4 hover:underline">{person.name}</button>
                {person.seats.length > 0 && <p className="break-words text-xs text-muted-foreground">{person.seats.join(" · ")}</p>}
              </div>
              <div className="min-w-0 space-y-2 sm:col-span-5">
                <div className="flex items-baseline justify-between gap-2 text-xs text-muted-foreground">
                  <span>{stats.total > 0 ? <><strong className={`font-semibold text-foreground ${num}`}>{stats.done} / {stats.total}</strong> 已完成</> : "本月无已排期子工单"}</span>
                  {completion !== null && <strong className={`text-sm text-foreground ${num}`}>{completion}%</strong>}
                </div>
                <DeliveryProgressBar emptyLabel="本月无已排期子工单" counts={stats} label={`${person.name}月度进度`} />
              </div>
              <div className="flex flex-wrap gap-2 text-xs sm:col-span-4 sm:justify-end">
                {stats.overdue > 0 && <button type="button" className="cursor-pointer rounded-full bg-destructive/10 px-2 py-1 font-medium text-destructive hover:underline" onClick={() => showDetails("overdue", person.id)}>逾期 {stats.overdue}</button>}
                {stats.due_soon > 0 && <button type="button" className="cursor-pointer rounded-full bg-delivery-soon/15 px-2 py-1 font-medium hover:underline" onClick={() => showDetails("due_soon", person.id)}>临期 {stats.due_soon}</button>}
                {stats.interrupted > 0 && <button type="button" className="cursor-pointer rounded-full bg-muted px-2 py-1 font-medium hover:underline" onClick={() => showDetails("interrupted", person.id)}>中断 {stats.interrupted}</button>}
                {stats.unscheduled > 0 && <button type="button" className="cursor-pointer rounded-full bg-muted px-2 py-1 text-muted-foreground hover:underline" onClick={() => showDetails("unscheduled", person.id)}>缺截止日 {stats.unscheduled}</button>}
                {!person.riskCount && !stats.unscheduled && stats.total > 0 && <span className="text-muted-foreground">暂无到期风险</span>}
              </div>
            </div>;
          })}
        </div> : <p className="mt-4 text-sm text-muted-foreground">{search || riskOnly ? "没有匹配的员工。" : "暂无已分配负责人的席位。"}</p>}
      </section>

      <section className={`${surface} space-y-3 p-5 md:p-6`} aria-labelledby="delivery-child-issues">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 id="delivery-child-issues" ref={detailHeading} tabIndex={-1} className="text-lg font-semibold">子工单明细</h2>
            <p role="status" className="text-xs text-muted-foreground">{currentEmployee?.name ?? "全部负责人"} · {details.length} 个子工单 · {mainGroups.length} 组（按主工单聚合）</p>
          </div>
          <div className="flex flex-wrap gap-2">
            {mainGroups.length > 0 && <Button type="button" size="sm" variant="outline" onClick={() =>
              setExpansion(allExpanded ? undefined : { scope: expansionScope, ids: new Set(mainGroups.map(group => group.id)) })
            }>{allExpanded ? "全部收起" : "全部展开"}</Button>}
            {currentEmployee && <Button size="sm" variant="outline" onClick={() => { setEmployee(""); setPage(1); setExpansion(undefined); }}>清除负责人筛选</Button>}
            <select className={field} aria-label="工单风险筛选" value={filter}
              onChange={event => { setDetailFilter(event.target.value as DashboardFilter); setPage(1); setExpansion(undefined); }}>
              {filters.map(key => <option key={key} value={key}>{labels[key]}</option>)}
            </select>
          </div>
        </div>
        {details.length > 0 ? <div className="overflow-x-auto" role="region" aria-label="子工单列表" tabIndex={0}>
          <table className="w-full text-left text-sm">
            <thead className="border-b border-border text-muted-foreground"><tr>
              {["主工单 / 子工单", "负责人", "计划截止", "风险与状态", "来源更新时间"].map(label => <th key={label} scope="col" className="whitespace-nowrap p-3 font-medium">{label}</th>)}
            </tr></thead>
            {mainGroups.slice((currentPage - 1) * pageSize, currentPage * pageSize).map(group =>
              <MainIssueGroup key={group.id} group={group} ownersByIssue={ownersByIssue}
                expanded={expandedGroups.has(group.id)} onToggle={() => toggleGroup(group.id)} />
            )}
          </table>
        </div> : <p className="border-t border-border pt-3 text-sm text-muted-foreground">
          {filter === "all" ? "本月暂无符合范围的已排期子工单。" : "暂无符合筛选条件的子工单。"}
        </p>}
        {pages > 1 && <div className="flex items-center justify-end gap-2">
          <span className="text-xs text-muted-foreground">每页 {pageSize} 个主工单分组</span>
          <Button variant="outline" size="sm" disabled={currentPage === 1} onClick={() => setPage(currentPage - 1)}>上一页</Button>
          <span className={`text-sm ${num}`}>{currentPage} / {pages}</span>
          <Button variant="outline" size="sm" disabled={currentPage === pages} onClick={() => setPage(currentPage + 1)}>下一页</Button>
        </div>}
      </section>

      <footer className="flex flex-wrap items-start justify-between gap-3 text-xs text-muted-foreground">
        <details className="max-w-3xl space-y-2">
          <summary className="cursor-pointer">统计口径</summary>
          <p>同一项目的子工单按 Jira 编号去重。归属只看该子工单的执行席位、Jira 经办人或研发负责人。跨员工协作在各员工名下各计一次，整体汇总只计一次。</p>
          <p>统计轻舟当月排期或期望交付条目下的子工单。截止日用于判断临期和逾期，依次取子工单排期、所属主工单排期、条目期望交付日。子工单按自身的 Jira 状态判断完成，取消和作废排除。</p>
          <p>即将到期包含今天和未来 7 天，交付链中断来自已关联的中断节点。中断可能与逾期或临期重合。未分配和缺截止日包含无法确定月份的工单。</p>
        </details>
        <span className={num}>汇总时间 {dateTime.format(new Date(data.asOf))} · 上海时区</span>
      </footer>
    </>}
  </section>;
}
