import { taskStageFilter, taskMatchesStage } from "@/lib/task-delivery-stage";
import { lazy, Suspense, useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { DELIVERY_STAGE_LABELS, type CompactIssue, type Project } from "@paperclipai/shared";
import { issuesApi } from "@/api/issues";
import { agentsApi } from "@/api/agents";
import { accessApi } from "@/api/access";
import { authApi } from "@/api/auth";
import { dsp7SeatsApi } from "@/api/dsp7-seats";
import { heartbeatsApi } from "@/api/heartbeats";
import { projectsApi } from "@/api/projects";
import { useCompany } from "@/context/CompanyContext";
import { useBreadcrumbs } from "@/context/BreadcrumbContext";
import { useDialogActions } from "@/context/DialogContext";
import { useManagementAccess } from "@/hooks/useManagementAccess";
import { useVisibilityRefetchInterval } from "@/lib/polling";
import { Link, useLocation, useSearchParams } from "@/lib/router";
import { queryKeys } from "@/lib/queryKeys";
import { createIssueDetailLocationState } from "@/lib/issueDetailBreadcrumb";
import { managementConclusion, managementExecution, managementSeat, managementViewMatches } from "@/lib/issue-management";
import { useManagementIssues } from "@/hooks/useManagementIssues";
import { useManagementScope } from "@/hooks/useManagementScope";
import { timeAgo } from "@/lib/timeAgo";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "./ui/sheet";
import { IssuesList } from "./IssuesList";
import { IssueStatusBadge } from "./StatusBadge";
import { Dsp7ExecutionStatus } from "./Dsp7ExecutionStatus";

const ManagedSessionPanel = lazy(() => import("./ManagedSessionPanel").then(m => ({ default: m.ManagedSessionPanel })));
const statuses: Record<string, string> = { backlog: "待排期", todo: "待处理", in_progress: "处理中", in_review: "待评审", blocked: "阻塞", done: "已完成", cancelled: "已取消" };
const priorities: Record<string, string> = { critical: "紧急", high: "高", medium: "中", low: "低" };
const tabs = [["all", "全部工单"], ["attention", "需要处理与核实"], ["pending", "待处理"], ["running", "执行中"], ["waiting", "等待人工"], ["blocked", "已阻塞"], ["error", "执行异常"], ["done", "已完成"]] as const;
const columns = [["stage", "交付环节"], ["project", "项目"], ["owner", "负责人 / 席位"], ["status", "工单状态"], ["runtime", "执行状态"], ["priority", "优先级"], ["updated", "最近更新"]] as const;
type Column = typeof columns[number][0];
type SavedView = { name: string; query: string };
const defaultColumns: Column[] = ["stage", "project", "owner", "status", "runtime", "updated"];
const selectClass = "max-w-full rounded-md border border-border bg-background px-3 py-2 text-sm";


export function IssueManagement() {
  const { selectedCompanyId } = useCompany();
  return selectedCompanyId ? <ManagementCollection key={selectedCompanyId} companyId={selectedCompanyId} /> : <p className="p-4 text-sm text-muted-foreground">请先选择组织。</p>;
}

function ManagementCollection({ companyId }: { companyId: string }) {
  const [params, setParams] = useSearchParams();
  const { setBreadcrumbs } = useBreadcrumbs();
  const { openNewIssue } = useDialogActions();
  const { canManage, loading: accessLoading, error: accessError } = useManagementAccess();
  const { scope } = useManagementScope(companyId);
  const personalView = scope === "mine";
  const cache = useQueryClient();
  const interval = useVisibilityRefetchInterval({ visibleMs: 10000 });
  const session = useQuery({ queryKey: queryKeys.auth.session, queryFn: authApi.getSession });
  const projects = useQuery({ queryKey: queryKeys.projects.list(companyId, { includeArchived: true }), queryFn: () => projectsApi.list(companyId, { includeArchived: true }) });
  const seats = useQuery({ queryKey: ["dsp7-registered-seats", companyId], queryFn: () => dsp7SeatsApi.list(companyId), refetchInterval: interval, retry: false });
  const agents = useQuery({ queryKey: queryKeys.agents.list(companyId), queryFn: () => agentsApi.list(companyId) });
  const users = useQuery({ queryKey: queryKeys.access.companyUserDirectory(companyId), queryFn: () => accessApi.listUserDirectory(companyId) });
  const labels = useQuery({ queryKey: ["management-labels", companyId], queryFn: () => issuesApi.listLabels(companyId) });
  const live = useQuery({ queryKey: queryKeys.liveRuns(companyId), queryFn: () => heartbeatsApi.liveRunsForCompany(companyId), refetchInterval: interval, retry: false });
  const workspace = params.getAll("workspace");
  const participant = params.get("participantAgentId") || undefined;
  const collection = useManagementIssues(companyId, participant, workspace);
  useEffect(() => { setBreadcrumbs([{ label: "AI任务" }]); }, [setBreadcrumbs]);
  const all = useMemo(() => [...new Map((collection.data?.pages.flat() ?? []).map(i => [i.id, i])).values()], [collection.data]);
  const projectMap = new Map((projects.data ?? []).map(p => [p.id, p]));
  const seatFor = (issue: CompactIssue) => managementSeat(issue, seats.data ?? []);
  const liveIds = new Set((live.data ?? []).filter(r => r.status === "running" && r.issueId).map(r => r.issueId));
  const executionById = new Map(all.map(issue => [issue.id, managementExecution(issue, seatFor(issue), liveIds.has(issue.id), seats.isError || live.isError ? true : seats.isPending || live.isPending ? "loading" : false)]));
  const runtimeFor = (issue: CompactIssue) => executionById.get(issue.id)!;
  const userNames = new Map((users.data?.users ?? []).flatMap(u => [[u.principalId, u.user?.name ?? u.user?.email ?? "成员"], ...(u.user ? [[u.user.id, u.user.name ?? u.user.email ?? "成员"]] : [])] as Array<[string, string]>));
  const nameFor = (id: string | null) => userNames.get(id ?? "") ?? "人员信息待同步";
  const project = params.get("projectId") ?? "";
  const owner = params.get("owner") ?? "";
  const seatId = params.get("seat") ?? "";
  const requestedTab = params.get("view") ?? "all";
  const tab = tabs.some(([key]) => key === requestedTab) ? requestedTab : "all";
  const status = params.get("status") ?? "";
  const execution = params.get("execution") ?? "";
  const priority = params.get("priority") ?? "";
  const search = params.get("q") ?? "";
  const sort = params.get("sort") ?? "updated";
  const mode = params.get("mode") ?? "table";
  const [searchDraft, setSearchDraft] = useState(search);
  useEffect(() => setSearchDraft(search), [search]);
  function patch(values: Record<string, string>) { const next = new URLSearchParams(params); for (const [key, value] of Object.entries(values)) value ? next.set(key, value) : next.delete(key); next.delete("page"); setParams(next, { replace: true }); }
  useEffect(() => { if (searchDraft === search) return; const timer = setTimeout(() => patch({ q: searchDraft }), 300); return () => clearTimeout(timer); }, [searchDraft, search, params]);
  const stage = taskStageFilter(params.get("taskType"));
  const missingStageProjection = stage !== "all" && all.some(issue => !issue.deliveryStages);
  const analysisCreateParams = new URLSearchParams(params);
  analysisCreateParams.set("taskType", "analysis");
  analysisCreateParams.set("createAnalysis", "1");
  analysisCreateParams.delete("executionId");
  analysisCreateParams.delete("supersedesId");
  if (project === "__none__") analysisCreateParams.delete("projectId");
  const base = all.filter(i => taskMatchesStage(i, stage) && (!personalView || !!session.data?.user.id && i.assigneeUserId === session.data.user.id || !!seatFor(i)?.isMine && i.assigneeAgentId === seatFor(i)?.agentId) && (params.get("routines") === "1" || i.originKind !== "routine_execution") && (workspace.length < 2 || workspace.includes(i.projectWorkspaceId ?? projectMap.get(i.projectId ?? "")?.primaryWorkspace?.id ?? "") || workspace.includes(i.executionWorkspaceId ?? "")) && (!project || (project === "__none__" ? !i.projectId : i.projectId === project)) && (!owner || i.assigneeUserId === owner || seatFor(i)?.owner?.id === owner) && (!seatId || seatFor(i)?.agentId === seatId) && (!status || i.status === status) && (!priority || i.priority === priority) && (!execution || runtimeFor(i).kind === execution) && (!params.get("assignee") || (params.get("assignee") === "__me" ? i.assigneeUserId === session.data?.user.id : params.get("assignee") === "__unassigned" ? !i.assigneeAgentId && !i.assigneeUserId : i.assigneeAgentId === params.get("assignee") || i.assigneeUserId === params.get("assignee"))) && (!search || `${i.title} ${i.identifier ?? ""} ${i.description?.match(/[A-Z][A-Z0-9_]+-\d+/)?.[0] ?? ""} ${seatFor(i)?.presence?.tasks.find(t => t.taskId === i.id)?.jiraKey ?? ""}`.toLocaleLowerCase().includes(search.toLocaleLowerCase())));
  const inTab = (i: CompactIssue, view: string) => managementViewMatches(view, i, runtimeFor(i), !!seatFor(i)?.presence?.alerts.some(a => a.taskId === i.id));
  const filtered = base.filter(i => inTab(i, tab)).sort((a, b) => sort === "title" ? a.title.localeCompare(b.title, "zh-CN") : sort === "created" ? +new Date(b.createdAt) - +new Date(a.createdAt) : +new Date(b.updatedAt) - +new Date(a.updatedAt));
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(50);
  const [selected, setSelected] = useState<string[]>([]);
  const filterKey = params.toString();
  useEffect(() => { setPage(1); setSelected([]); }, [filterKey, pageSize]);
  const pages = Math.max(1, Math.ceil(filtered.length / pageSize));
  const safePage = Math.min(page, pages);
  const rows = filtered.slice((safePage - 1) * pageSize, safePage * pageSize);
  const rowKey = rows.map(issue => issue.id).join(",");
  const [opened, setOpened] = useState<string | null>(null);
  const [visibleColumns, setVisibleColumns] = useState<Column[]>(defaultColumns);
  const [saved, setSaved] = useState<SavedView[]>([]);
  const [viewName, setViewName] = useState("");
  const [notice, setNotice] = useState("");
  const storageKey = session.data?.user.id ? `zhiyan:issue-management:${companyId}:${session.data.user.id}` : null;
  useEffect(() => { if (!storageKey) return; try { const value = JSON.parse(localStorage.getItem(storageKey) ?? "{}"); setSaved(Array.isArray(value.views) ? value.views.filter((v: SavedView) => typeof v.name === "string" && typeof v.query === "string") : []); setVisibleColumns(Array.isArray(value.columns) ? value.columns.filter((c: Column) => columns.some(([key]) => key === c)) : defaultColumns); } catch { setNotice("本机视图配置读取失败，已使用默认布局。"); } }, [storageKey]);
  function persist(views: SavedView[], cols: Column[]) { setSaved(views); setVisibleColumns(cols); if (!storageKey) return; try { localStorage.setItem(storageKey, JSON.stringify({ views, columns: cols })); } catch { setNotice("浏览器未允许保存，当前布局仍可使用。"); } }
  const [batchKind, setBatchKind] = useState("label");
  const [batchValue, setBatchValue] = useState("");
  const [batchArmed, setBatchArmed] = useState(false);
  useEffect(() => setBatchArmed(false), [filterKey]);
  useEffect(() => {
    const visible = new Set(rowKey.split(","));
    setSelected(current => { const kept = current.filter(id => visible.has(id)); return kept.length === current.length ? current : kept; });
    setBatchArmed(false);
  }, [rowKey]);
  const batch = useMutation({ mutationFn: async () => {
    const results: string[] = []; let succeeded = 0;
    for (const id of selected) {
      const issue = all.find(i => i.id === id); if (!issue) continue;
      try {
        // Re-read before mutation, preserving labels and refusing to rebind governed Harness executions.
        const fresh = await issuesApi.get(id);
        if (batchKind !== "label" && (fresh.executionRunId || seatFor(issue) || fresh.description?.includes("DSP7-JIRA-INTAKE"))) { results.push(`${issue.identifier}: 席位或执行任务，请在详情中调整`); continue; }
        const data = batchKind === "label" ? { labelIds: [...new Set([...(fresh.labelIds ?? fresh.labels?.map(l => l.id) ?? []), batchValue])] } : batchKind === "project" ? { projectId: batchValue === "__none__" ? null : batchValue } : { assigneeUserId: batchValue, assigneeAgentId: null };
        await issuesApi.update(id, data); succeeded++;
      } catch (error) { results.push(`${issue.identifier ?? id}: ${error instanceof Error ? error.message : "修改失败"}`); }
    }
    return { succeeded, results };
  }, onSuccess: async result => { setNotice(`成功 ${result.succeeded} 项。${result.results.join("；")}`); setSelected([]); setBatchArmed(false); await cache.invalidateQueries({ queryKey: queryKeys.issues.list(companyId) }); } });
  const batchTarget = batchKind === "label" ? labels.data?.find(l => l.id === batchValue)?.name : batchKind === "project" ? batchValue === "__none__" ? "未关联项目" : projectMap.get(batchValue)?.name : nameFor(batchValue);
  const activeFilters = [["projectId", project, project === "__none__" ? "未关联项目" : projectMap.get(project)?.name ?? "所选项目"], ["owner", owner, nameFor(owner)], ["seat", seatId, seats.data?.find(s => s.agentId === seatId)?.name ?? "所选席位"], ["status", status, statuses[status]], ["priority", priority, priorities[priority]], ["execution", execution, "执行状态条件"], ["q", search, `搜索：${search}`], ["assignee", params.get("assignee"), "指定执行者"], ["participantAgentId", participant, "指定参与者"], ["workspace", workspace.join(","), "指定工作区"], ["routines", params.get("routines"), "包含周期执行任务"]].filter(([, value]) => value);
  const full = !missingStageProjection && !collection.hasNextPage && !collection.isFetching && !collection.isError && collection.isSuccess;
  const refresh = () => { void collection.refetch(); void seats.refetch(); void live.refetch(); void projects.refetch(); void users.refetch(); void labels.refetch(); };
  if (accessLoading) return <p role="status" className="p-4 text-sm text-muted-foreground">正在确认任务访问范围…</p>;
  if (accessError) return <p role="alert" className="p-4 text-sm text-destructive">任务权限读取失败，请刷新重试。</p>;
  return <div className="space-y-4">
    <header className="flex flex-wrap items-center justify-between gap-3"><div><h1 className="text-2xl font-semibold">AI任务</h1><p className="mt-1 text-sm text-muted-foreground">派单、跟踪执行与处理异常，工单状态和本机执行分别核对。</p></div><div className="flex flex-wrap gap-2"><Button variant="outline" disabled={collection.isFetching} onClick={refresh}>刷新</Button>{canManage && <>{(stage === "all" || stage === "analysis") ? <Button asChild><Link to={"/issues?" + analysisCreateParams}>新建需求分析</Link></Button> : stage !== "other" && <Button asChild><Link to={"/delivery" + (project && project !== "__none__" ? "?" + new URLSearchParams({ projectId: project }) : "")}>安排{DELIVERY_STAGE_LABELS[stage]}任务</Link></Button>}<Button asChild><Link to="/jira-intake">接入 Jira 工单</Link></Button><Button variant="outline" onClick={() => openNewIssue(project && project !== "__none__" ? { projectId: project } : {})}>新建平台任务</Button></>}</div></header>
    <div className="flex flex-wrap gap-2" role="group" aria-label="工单快捷视图">{tabs.map(([key, label]) => <Button key={key} variant={tab === key ? "secondary" : "outline"} aria-pressed={tab === key} onClick={() => patch({ view: key === "all" ? "" : key })}>{label}<span className="tabular-nums">{collection.isPending ? "—" : `${full ? "" : "≥"}${base.filter(i => inTab(i, key)).length}`}</span></Button>)}</div>
    <section className="space-y-3 rounded-xl border border-border bg-card p-4" aria-label="筛选与显示设置">
      <div className="flex flex-wrap items-end gap-3">
        <label className="space-y-1 text-sm"><span className="block text-muted-foreground">展示范围</span><select aria-label="工单展示范围" className={selectClass} disabled={!canManage} value={personalView ? "mine" : "company"} onChange={e => patch({ scope: e.target.value })}>{canManage && <option value="company">组织工单</option>}<option value="mine">我的工单</option></select></label>
        <label className="space-y-1 text-sm"><span className="block text-muted-foreground">项目</span><select className={selectClass} value={project} onChange={e => patch({ projectId: e.target.value })}><option value="">全部项目</option><option value="__none__">未关联项目</option>{project && project !== "__none__" && !projectMap.has(project) && <option value={project}>所选项目（待核对）</option>}{projects.data?.map(p => <option key={p.id} value={p.id}>{p.name}{p.archivedAt ? "（已归档）" : ""}</option>)}</select></label>
        {canManage && <label className="space-y-1 text-sm"><span className="block text-muted-foreground">负责人</span><select className={selectClass} value={owner} onChange={e => patch({ owner: e.target.value })}><option value="">全部人员</option>{owner && !users.data?.users.some(u => (u.user?.id ?? u.principalId) === owner) && <option value={owner}>所选负责人（待同步）</option>}{users.data?.users.map(u => <option key={u.principalId} value={u.user?.id ?? u.principalId}>{u.user?.name ?? u.user?.email ?? u.principalId}</option>)}</select></label>}
        <label className="space-y-1 text-sm"><span className="block text-muted-foreground">席位</span><select className={selectClass} value={seatId} onChange={e => patch({ seat: e.target.value })}><option value="">{canManage ? "全部席位" : "我的全部席位"}</option>{seatId && !seats.data?.some(s => s.agentId === seatId) && <option value={seatId}>所选席位（待同步）</option>}{seats.data?.filter(s => canManage || s.isMine).map(s => <option key={s.agentId} value={s.agentId}>{s.name}{s.online ? "" : "（离线）"}</option>)}</select></label>
        <label className="min-w-0 basis-full space-y-1 text-sm sm:flex-1 sm:basis-64"><span className="block text-muted-foreground">关键词</span><Input value={searchDraft} onChange={e => setSearchDraft(e.target.value)} placeholder="搜索 Jira 编号、平台编号或标题" aria-label="搜索工单" /></label>
        <details className="text-sm"><summary className="cursor-pointer rounded-md border border-border px-3 py-2">更多筛选</summary><div className="mt-2 flex flex-wrap gap-2"><label>工单状态 <select className={selectClass} value={status} onChange={e => patch({ status: e.target.value })}><option value="">全部状态</option>{Object.entries(statuses).map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select></label><label>优先级 <select className={selectClass} value={priority} onChange={e => patch({ priority: e.target.value })}><option value="">全部优先级</option>{Object.entries(priorities).map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select></label><label>执行状态 <select className={selectClass} value={execution} onChange={e => patch({ execution: e.target.value })}><option value="">全部执行状态</option>{[["running", "有活动执行"], ["waiting", "等待人工"], ["offline", "席位离线"], ["queued", "等待调度"], ["registered", "已登记待核验"], ["local", "等待本机连接"], ["error", "执行异常 / 中断"], ["unknown", "状态待核验 / 读取失败"], ["ended", "工单已结束"]].map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select></label><label className="flex items-center gap-2"><input type="checkbox" checked={params.get("routines") === "1"} onChange={e => patch({ routines: e.target.checked ? "1" : "" })} />包含周期执行任务</label></div></details>
      </div>
      <div className="flex flex-wrap items-center justify-between gap-3"><div className="flex flex-wrap gap-2"><Button size="sm" variant={mode === "table" ? "secondary" : "ghost"} onClick={() => patch({ mode: "" })}>管理表格</Button><Button size="sm" variant={mode === "advanced" ? "secondary" : "ghost"} onClick={() => patch({ mode: "advanced" })}>列表 / 看板</Button><label className="text-sm">排序 <select className={selectClass} value={sort} onChange={e => patch({ sort: e.target.value })}><option value="updated">最近更新优先</option><option value="created">最近创建优先</option><option value="title">标题</option></select></label></div><details className="text-sm"><summary className="cursor-pointer">列设置与个人视图</summary><div className="mt-2 space-y-3"><div className="flex flex-wrap gap-3">{columns.map(([key, label]) => <label key={key} className="flex items-center gap-1"><input type="checkbox" checked={visibleColumns.includes(key)} onChange={e => persist(saved, e.target.checked ? [...visibleColumns, key] : visibleColumns.filter(c => c !== key))} />{label}</label>)}</div><div className="flex flex-wrap gap-2"><Input maxLength={80} value={viewName} onChange={e => setViewName(e.target.value)} placeholder="例如：DSP7 等待人工" aria-label="个人视图名称" className="w-56" /><Button size="sm" disabled={!viewName.trim() || !storageKey || (saved.length >= 20 && !saved.some(view => view.name === viewName.trim()))} onClick={() => { persist([...saved.filter(v => v.name !== viewName.trim()), { name: viewName.trim(), query: params.toString() }], visibleColumns); setViewName(""); }}>保存当前视图</Button></div><p className="text-xs text-muted-foreground">仅保存到当前浏览器，按账号和组织隔离，最多 20 个。</p></div></details></div>
      {saved.length > 0 && <div className="flex flex-wrap gap-2" aria-label="个人已保存视图">{saved.map(v => <span key={v.name} className="inline-flex items-center rounded-md border border-border"><Button size="sm" variant="ghost" onClick={() => setParams(new URLSearchParams(v.query), { replace: true })}>{v.name}</Button><Button size="sm" variant="ghost" aria-label={`删除视图 ${v.name}`} onClick={() => persist(saved.filter(item => item.name !== v.name), visibleColumns)}>×</Button></span>)}</div>}
      {activeFilters.length > 0 && <div className="flex flex-wrap items-center gap-2">{activeFilters.map(([key, , label]) => <Button size="sm" variant="secondary" key={key} aria-label={`移除筛选 ${label}`} onClick={() => patch({ [key!]: "" })}>{label} ×</Button>)}<Button size="sm" variant="ghost" onClick={() => setParams(new URLSearchParams(stage === "all" ? {} : { taskType: stage }), { replace: true })}>清除全部条件</Button></div>}
    </section>
    <p className="text-xs text-muted-foreground">{personalView ? "我的工单范围 · " : "组织工单范围 · "}{full ? `已核对 ${all.length} 条工单元数据` : `已加载 ${all.length} 条，正在核对完整范围；带 ≥ 的数量尚未完整`} · 快捷视图数量沿用当前筛选。已完成表示工单状态，正式交付请核对证据；“等待人工”和“执行异常”只按已采集执行证据归类。</p>
    {!canManage && !seats.isPending && !seats.isError && !seats.data?.some(s => s.isMine) && <p role="status" className="text-sm text-muted-foreground">你尚未绑定席位，当前仅展示直接分配给本人的任务。请联系组织管理员绑定席位。</p>}
    {missingStageProjection && <p role="alert" className="text-sm text-destructive">任务环节信息未完整返回，请更新服务并重新检查；不能据此判断没有任务或归入其他任务。</p>}
    {(collection.error || seats.error || live.error || projects.error || users.error) && <div role="alert" className="space-y-1 rounded-md border border-border p-3 text-sm text-destructive">{collection.error && <p>工单数据读取失败，统计不完整：{collection.error.message}</p>}{(seats.error || live.error) && <p>执行状态读取失败，不能据此判断正在执行、等待人工或异常。</p>}{projects.error && <p>项目列表读取失败，已有项目条件仍保留。</p>}{users.error && <p>人员列表读取失败，请刷新重试。</p>}<Button variant="outline" size="sm" onClick={refresh}>重新检查</Button></div>}
    {notice && <p role="status" className="rounded-md bg-muted p-3 text-sm">{notice}</p>}
    {canManage && selected.length > 0 && <section className="space-y-2 rounded-lg border border-border bg-muted p-3" aria-label="批量管理"><div className="flex flex-wrap items-center gap-2"><span className="text-sm">已选 {selected.length} 项（当前页）</span><select aria-label="批量操作" className={selectClass} value={batchKind} disabled={batch.isPending} onChange={e => { setBatchKind(e.target.value); setBatchValue(""); setBatchArmed(false); }}><option value="label">添加标签</option><option value="project">调整项目</option><option value="owner">调整负责人</option></select><select aria-label="批量目标" className={selectClass} value={batchValue} disabled={batch.isPending} onChange={e => { setBatchValue(e.target.value); setBatchArmed(false); }}><option value="">请选择目标</option>{batchKind === "label" ? labels.data?.map(l => <option key={l.id} value={l.id}>{l.name}</option>) : batchKind === "project" ? <><option value="__none__">未关联项目</option>{projects.data?.filter(p => !p.archivedAt).map(p => <option key={p.id} value={p.id}>{p.name}</option>)}</> : users.data?.users.map(u => <option key={u.principalId} value={u.user?.id ?? u.principalId}>{u.user?.name ?? u.user?.email ?? "成员"}</option>)}</select><Button size="sm" disabled={!batchValue || batch.isPending} onClick={() => batchArmed ? batch.mutate() : setBatchArmed(true)}>{batch.isPending ? "正在逐项保存…" : batchArmed ? "确认执行修改" : "预览修改"}</Button><Button size="sm" variant="ghost" disabled={batch.isPending} onClick={() => { setSelected([]); setBatchArmed(false); }}>取消选择</Button></div>{batchArmed && <p className="text-sm">将对选中的 {selected.length} 项执行“{batchKind === "label" ? "添加标签" : batchKind === "project" ? "调整项目" : "调整负责人"}”，目标为“{batchTarget}”。不会派单或启动执行；席位及 Harness 任务不允许在这里修改项目或负责人，跳过和失败会逐项列出。</p>}{labels.error && batchKind === "label" && <p className="text-sm text-destructive">标签加载失败，请刷新页面。</p>}</section>}
    {mode === "advanced" ? <IssuesList issues={filtered as Parameters<typeof IssuesList>[0]["issues"]} agents={agents.data} projects={projects.data} isLoading={collection.isPending} error={collection.error} viewStateKey="zhiyan:management-advanced" rowPresentation="task" toolbarPresentation="collection" searchWithinLoadedIssues onUpdateIssue={(id, data) => { void issuesApi.update(id, data).then(() => cache.invalidateQueries({ queryKey: queryKeys.issues.list(companyId) })).catch(error => setNotice(error.message)); }} /> : <>
      <div className="overflow-x-auto rounded-xl border border-border bg-card"><table className="w-full text-left text-sm"><caption className="sr-only">任务管理列表</caption><thead className="border-b border-border bg-muted text-xs text-muted-foreground"><tr>{canManage && <th className="p-3"><input type="checkbox" aria-label="选择当前页全部工单" disabled={batch.isPending || rows.length === 0} checked={rows.length > 0 && rows.every(i => selected.includes(i.id))} onChange={e => { setSelected(e.target.checked ? rows.map(i => i.id) : []); setBatchArmed(false); }} /></th>}<th className="min-w-64 p-3">工单与标题</th>{columns.filter(([key]) => visibleColumns.includes(key)).map(([key, label]) => <th className="whitespace-nowrap p-3" key={key}>{label}</th>)}<th className="p-3">操作</th></tr></thead><tbody className="divide-y divide-border">{rows.map(issue => { const seat = seatFor(issue); const runtime = runtimeFor(issue); const conclusion = managementConclusion(issue, runtime, !!seat?.presence?.alerts.some(a => a.taskId === issue.id)); const jira = seat?.presence?.tasks.find(t => t.taskId === issue.id)?.jiraKey ?? issue.description?.match(/[A-Z][A-Z0-9_]+-\d+/)?.[0]; return <tr key={issue.id} className="align-top hover:bg-accent/50">{canManage && <td className="p-3"><input type="checkbox" aria-label={`选择 ${issue.identifier ?? issue.title}`} checked={selected.includes(issue.id)} disabled={batch.isPending} onChange={e => { setSelected(e.target.checked ? [...selected, issue.id] : selected.filter(id => id !== issue.id)); setBatchArmed(false); }} /></td>}<td className="p-3"><button className="text-left font-medium text-foreground hover:underline" onClick={() => setOpened(issue.id)}>{issue.title}</button><p className="mt-1 text-xs text-muted-foreground">{jira ? `${jira} · ` : ""}{issue.identifier}</p></td>{visibleColumns.includes("stage") && <td className="p-3 text-xs">{issue.deliveryStages ? issue.deliveryStages.length ? issue.deliveryStages.map(value => DELIVERY_STAGE_LABELS[value]).join("、") : "其他任务" : "环节待核对"}</td>}{visibleColumns.includes("project") && <td className="p-3"><button className="text-left text-xs hover:underline" onClick={() => patch({ projectId: issue.projectId ?? "__none__" })}>{projectMap.get(issue.projectId ?? "")?.name ?? (issue.projectId ? "项目待同步" : "未关联项目")}</button></td>}{visibleColumns.includes("owner") && <td className="p-3"><p className="text-xs">{seat?.owner?.name ?? (issue.assigneeUserId ? nameFor(issue.assigneeUserId) : issue.assigneeAgentId ? agents.data?.find(a => a.id === issue.assigneeAgentId)?.name ?? "执行者待同步" : "未分配")}</p><p className="mt-1 text-xs text-muted-foreground">{seat ? `${seat.name} · ${seat.online ? "在线" : "离线"}` : "无关联席位"}</p></td>}{visibleColumns.includes("status") && <td className="whitespace-nowrap p-3"><IssueStatusBadge status={issue.status} /></td>}{visibleColumns.includes("runtime") && <td className="p-3"><span title={runtime.reason} className={`whitespace-nowrap text-xs ${runtime.kind === "error" ? "text-destructive" : runtime.kind === "running" ? "text-primary" : runtime.kind === "waiting" ? "text-amber-700 dark:text-amber-300" : "text-muted-foreground"}`}>{conclusion.label}</span>{runtime.kind === "waiting" && <p className="mt-1 max-w-48 line-clamp-2 text-xs text-muted-foreground">{runtime.reason}{seat?.presence?.alerts.find(a => a.taskId === issue.id)?.elapsedMinutes != null ? ` · 已等待 ${seat.presence.alerts.find(a => a.taskId === issue.id)!.elapsedMinutes} 分钟（心跳上报）` : ""}</p>}</td>}{visibleColumns.includes("priority") && <td className="p-3 text-xs">{priorities[issue.priority] ?? issue.priority}</td>}{visibleColumns.includes("updated") && <td className="whitespace-nowrap p-3 text-xs text-muted-foreground" title={new Date(issue.updatedAt).toLocaleString("zh-CN")}>{timeAgo(issue.updatedAt)}</td>}<td className="whitespace-nowrap p-3"><Button variant="outline" size="sm" onClick={() => setOpened(issue.id)}>{conclusion.actionLabel}</Button></td></tr>; })}</tbody></table>{!rows.length && <div className="space-y-2 p-8 text-center text-sm text-muted-foreground"><p>{collection.isPending ? "正在加载工单…" : collection.isError ? "工单加载失败，请重新检查。" : missingStageProjection ? "环节信息尚未完整，无法确认匹配结果。" : full ? "当前条件下没有工单。" : "已加载范围内暂无匹配，正在继续核对…"}</p>{activeFilters.length > 0 && <Button variant="outline" size="sm" onClick={() => setParams(new URLSearchParams(stage === "all" ? {} : { taskType: stage }), { replace: true })}>清除筛选</Button>}</div>}</div>
      <footer className="flex flex-wrap items-center justify-between gap-3 text-sm text-muted-foreground"><p>{filtered.length ? `${(safePage - 1) * pageSize + 1}–${Math.min(safePage * pageSize, filtered.length)}` : "0"} / {full ? "共" : "已匹配"} {filtered.length} 条</p><div className="flex items-center gap-2"><label>每页 <select className={selectClass} value={pageSize} disabled={batch.isPending} onChange={e => setPageSize(Number(e.target.value))}><option value={25}>25</option><option value={50}>50</option><option value={100}>100</option></select></label><Button variant="outline" size="sm" disabled={safePage <= 1 || batch.isPending} onClick={() => { setPage(safePage - 1); setSelected([]); }}>上一页</Button><span>{safePage} / {pages}</span><Button variant="outline" size="sm" disabled={safePage >= pages || batch.isPending} onClick={() => { setPage(safePage + 1); setSelected([]); }}>下一页</Button></div></footer>
    </>}
    <Sheet open={!!opened} onOpenChange={open => { if (!open) setOpened(null); }}><SheetContent className="w-full overflow-y-auto sm:max-w-3xl"><SheetHeader><SheetTitle>工单快速查看</SheetTitle><SheetDescription>保留列表位置与条件，查看执行证据和对话；派单与正式决策沿用原有流程。</SheetDescription></SheetHeader>{opened && <ManagementDetail key={opened} companyId={companyId} id={opened} projects={projects.data ?? []} />}</SheetContent></Sheet>
  </div>;
}

function ManagementDetail({ companyId, id, projects }: { companyId: string; id: string; projects: Project[] }) {
  const location = useLocation();
  const returnState = createIssueDetailLocationState("任务", `${location.pathname}${location.search}${location.hash}`, "issues");
  const detail = useQuery({ queryKey: queryKeys.issues.detail(id), queryFn: () => issuesApi.get(id) });
  const [showSessions, setShowSessions] = useState(false);
  const issue = detail.data;
  return <div className="space-y-4 px-4 pb-6">{detail.isPending ? <p className="text-sm">正在加载详情…</p> : detail.error ? <p role="alert" className="text-sm text-destructive">{detail.error.message}</p> : issue && <><div className="space-y-2"><p className="text-xs text-muted-foreground">{issue.identifier} · {projects.find(p => p.id === issue.projectId)?.name ?? "未关联项目"}</p><h2 className="text-lg font-semibold">{issue.title}</h2><p className="text-sm">工单状态：{statuses[issue.status] ?? issue.status}</p><Button asChild><Link state={returnState} to={`/issues/${issue.identifier ?? issue.id}`}>打开统一任务详情 · 派单与决策</Link></Button></div><Dsp7ExecutionStatus issue={issue} /><details className="rounded-md border border-border p-3"><summary className="cursor-pointer text-sm">工单说明</summary><p className="mt-3 whitespace-pre-wrap break-words text-sm">{issue.description?.replace(/<!-- DSP7-JIRA-INTAKE .*? -->/gs, "") || "暂无说明"}</p></details><section className="space-y-3"><Button variant="outline" onClick={() => setShowSessions(!showSessions)} aria-expanded={showSessions}>{showSessions ? "收起会话与阶段" : "查看会话、Harness 阶段与交付记录"}</Button>{showSessions && <Suspense fallback={<p className="text-sm">正在加载会话模块…</p>}><ManagedSessionPanel companyId={companyId} taskId={id} /></Suspense>}</section></>}</div>;
}
