import { DeliveryEntryOverview } from "@/components/DeliveryEntryOverview";
import { DeliveryEntryEvidence, deliveryEvidenceRecords, type DeliveryEvidenceState } from "@/components/DeliveryMaterials";
import { ApiError } from "@/api/client";
import { DeliveryEntryStages } from "@/components/DeliveryEntryStages";
import { DELIVERY_ANALYSIS_SECTION_ID, deliveryEntryStageRows, ENTRY_STAGES } from "@/lib/delivery-entry-stages";
import { deliveryWorkflowApi } from "@/api/delivery-workflows";
import { DeliveryWorkflowPanel } from "@/components/DeliveryWorkflowPanel";
import { useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link, useLocation, useSearchParams } from "@/lib/router";
import { useCompany } from "@/context/CompanyContext";
import { useBreadcrumbs } from "@/context/BreadcrumbContext";
import { useManagementAccess } from "@/hooks/useManagementAccess";
import { projectsApi } from "@/api/projects";
import { deliveryIntakeApi } from "@/api/delivery-intake";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { monthlyFilterKeys } from "@/lib/delivery-monthly-filters";
import { DeliveryWorkDispatch } from "@/components/DeliveryWorkDispatch";
import { DeliveryDemandLookup } from "@/components/DeliveryDemandLookup";
import { DeliveryMonthlyBoard } from "@/components/DeliveryMonthlyBoard";
import { DeliveryAdmissionPanel } from "@/components/DeliveryAdmissionPanel";
import { DeliverySources } from "./DeliveryIntake";

const field = "rounded-md border border-border bg-background p-2 text-sm";
const tabs = [["overview", "交付概览"], ["work", "工单与执行"]] as const;
function time(value: string) { return new Date(value).toLocaleString("zh-CN"); }

export function DeliveryEntries() {
  const { selectedCompanyId } = useCompany();
  const [params] = useSearchParams();
  // Reset entry-local UI before rendering a different entry, including cached data.
  const entryKey = JSON.stringify([selectedCompanyId, params.get("snapshotId"), params.get("view") === "sources"]);
  return <DeliveryEntriesPage key={entryKey} />;
}

function DeliveryEntriesPage() {
  const { selectedCompanyId: companyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const { canManage } = useManagementAccess();
  const [params, setParams] = useSearchParams();
  const { hash, key: locationKey } = useLocation();
  const viewPlanRequest = hash === "#delivery-workflow" ? locationKey : undefined;
  const [workflowPanelOpen, setWorkflowPanelOpen] = useState(false);
  const [startRequested, setStartRequested] = useState(false);
  const workflowPanelRef = useRef<HTMLDetailsElement>(null);
  const projects = useQuery({ queryKey: ["delivery-projects", companyId], queryFn: () => projectsApi.list(companyId!), enabled: !!companyId });
  const activeProjects = projects.data?.filter(p => !p.archivedAt) ?? [];
  const projectStorageKey = companyId ? `zhiyan:delivery-project:${companyId}` : null;
  let rememberedProjectId = "";
  try { rememberedProjectId = projectStorageKey ? localStorage.getItem(projectStorageKey) ?? "" : ""; } catch { /* Optional browser preference. */ }
  const requestedProjectId = params.get("projectId") ?? rememberedProjectId;
  useEffect(() => {
    const explicitProjectId = params.get("projectId");
    if (!projectStorageKey || !projects.isSuccess || !explicitProjectId || !activeProjects.some(project => project.id === explicitProjectId)) return;
    try { localStorage.setItem(projectStorageKey, explicitProjectId); } catch { /* URL remains usable when storage is unavailable. */ }
  }, [projectStorageKey, projects.isSuccess, projects.data, params]);
  const projectId = activeProjects.find(project => project.id === requestedProjectId)?.id ?? (activeProjects.length === 1 ? activeProjects[0].id : "");
  const snapshotId = params.get("snapshotId") ?? "";
  const sources = params.get("view") === "sources";
  const monthly = !snapshotId && !sources && params.get("view") !== "saved";
  const tabParam = params.get("tab");
  const stageParam = tabParam === "analysis" ? "analysis" : params.get("stage");
  const tab = tabParam === "work" || tabParam === "materials" ? "work" : "overview";
  const page = Math.max(1, Math.floor(Number(params.get("page")) || 1));
  const q = params.get("q") ?? "";
  const [search, setSearch] = useState(q);
  useEffect(() => setSearch(q), [q]);
  function change(values: Record<string, string | undefined>) {
    if (projectStorageKey && Object.hasOwn(values, "projectId")) {
      try {
        if (values.projectId) localStorage.setItem(projectStorageKey, values.projectId);
        else localStorage.removeItem(projectStorageKey);
      } catch { /* Selecting a project still works without browser storage. */ }
    }
    setParams(previous => { const next = new URLSearchParams(previous); for (const [key, value] of Object.entries(values)) { if (value) next.set(key, value); else next.delete(key); } return next; });
  }
  const projectName = (id: string) => projects.data?.find(p => p.id === id)?.name ?? "项目加载中";
  const query = new URLSearchParams({ page: String(page), q, attention: params.get("attention") === "differences" ? "differences" : "all", ...(projectId ? { projectId } : {}) });
  const entries = useQuery({ queryKey: ["delivery-entries", companyId, query.toString()], queryFn: () => deliveryIntakeApi.entries(companyId!, query), enabled: !!companyId && !snapshotId && !sources && !monthly });
  const detail = useQuery({ queryKey: ["delivery-entry", companyId, snapshotId], queryFn: () => deliveryIntakeApi.entry(companyId!, snapshotId), enabled: !!companyId && !!snapshotId && !sources, refetchInterval: 15000 });
  const selectedStage = ENTRY_STAGES.find(stage => stage.id === stageParam)?.id;
  const workflowQuery=useQuery({queryKey:["delivery-workflows",companyId,snapshotId],queryFn:()=>deliveryWorkflowApi.list(companyId!,snapshotId),enabled:!!companyId&&!!snapshotId&&!sources,retry:(count,error)=>!(error instanceof ApiError&&error.status===404)&&count<2,refetchInterval:query=>query.state.error instanceof ApiError&&query.state.error.status===404?false:5000});
  const requestedReviewKey = params.get("reviewKey") ?? "";
  useEffect(() => {
    if (requestedReviewKey && canManage && workflowQuery.isSuccess) { setWorkflowPanelOpen(true); setStartRequested(true); requestAnimationFrame(() => workflowPanelRef.current?.scrollIntoView({behavior:"smooth",block:"start"})); }
  }, [requestedReviewKey, canManage, workflowQuery.isSuccess]);
  const jiraReviewResults = useQuery({
    queryKey: ["delivery-jira-review-results", companyId, snapshotId],
    queryFn: () => deliveryIntakeApi.jiraReviewResults(companyId!, snapshotId),
    enabled: !!companyId && !!snapshotId && !sources && tab === "work" && detail.isSuccess,
    staleTime: 60_000,
    retry: false,
  });
  const workflows = workflowQuery.data ?? [];
  const workflow = workflows[0];
  const evidenceRecords = tab === "work" ? deliveryEvidenceRecords(workflows) : [];
  const workflowState: DeliveryEvidenceState = workflowQuery.isPending ? "loading" : workflowQuery.isError ? "unavailable" : "ready";
  const workflowUnavailable=workflowQuery.error instanceof ApiError&&workflowQuery.error.status===404;
  const canStartWorkflow = !!detail.data?.chainAdmission?.ready && canManage && workflowQuery.isSuccess && !workflow;
  const startBlockReason = !canManage ? "需要交付管理员权限才能启动" : workflowQuery.isPending ? "正在核对已有交付流程…" : workflowQuery.isError ? "交付流程状态暂不可用，请刷新后重试" : !detail.data?.chainAdmission?.ready ? detail.data?.chainAdmission?.reasons.join("；") || "交付链准入条件尚未满足" : "";
  useEffect(() => {
    const taskId=params.get("taskId");if(!workflow||!taskId)return;
    const frame=requestAnimationFrame(()=>document.getElementById(`delivery-node-${taskId}`)?.scrollIntoView({block:"start"}));
    return ()=>cancelAnimationFrame(frame);
  },[workflow?.id,params.get("taskId")]);
  const flowLabels:Record<string,string>={active:"自动交付中",blocked:"交付阻塞待处理",acceptance:"待正式验收",completed:"已登记正式验收",cancelled:"自动交付已取消"};
  const snapshot = detail.data?.snapshot;
  const stages = detail.data ? deliveryEntryStageRows(detail.data, workflow) : [];
  const renderedSnapshotId = snapshot?.id;
  const workflowReady = !!renderedSnapshotId && workflowQuery.isSuccess;
  useEffect(() => {
    if (viewPlanRequest === undefined || !workflowReady) return;
    setWorkflowPanelOpen(true);
    const frame = requestAnimationFrame(() => workflowPanelRef.current?.scrollIntoView({ block: "start" }));
    return () => cancelAnimationFrame(frame);
  }, [viewPlanRequest, workflowReady]);
  useEffect(() => {
    if (hash === `#${DELIVERY_ANALYSIS_SECTION_ID}` && renderedSnapshotId && selectedStage === "analysis") {
      document.getElementById(DELIVERY_ANALYSIS_SECTION_ID)?.scrollIntoView({ block: "start" });
    }
  }, [hash, renderedSnapshotId, selectedStage]);
  useEffect(() => { if (!sources) setBreadcrumbs(snapshot ? [{ label: "需求条目", href: "/delivery" + (projectId ? `?projectId=${projectId}` : "") }, { label: snapshot.demandNo }] : [{ label: "需求条目" }]); }, [setBreadcrumbs, sources, snapshot?.demandNo, projectId]);
  const href = (path: string, values: Record<string, string>) => path + "?" + new URLSearchParams(values);
  const sourceHref = href("/delivery", { projectId: snapshot?.projectId ?? projectId, view: "sources", ...(snapshot ? { demandNo: snapshot.demandNo, snapshotId: snapshot.id } : {}) });
  function openTab(nextTab: typeof tab) {
    change({ tab: nextTab, stage: selectedStage });
  }
  function openWorkflow(taskId?: string) {
    if (!workflow && !canStartWorkflow) return;
    setWorkflowPanelOpen(true);
    setStartRequested(!workflow);
    requestAnimationFrame(() => {
      const node = taskId ? document.getElementById(`delivery-node-${taskId}`) : null;
      (node ?? workflowPanelRef.current)?.scrollIntoView({ behavior: "smooth", block: "start" });
    });
  }
  if (sources) return <DeliverySources key={companyId + projectId + (params.get("demandNo") ?? "")} />;
  if (snapshotId) return <div className="space-y-5">
    <Button variant="ghost" onClick={() => change({ snapshotId: undefined, tab: undefined, stage: undefined })}>返回条目列表</Button>
    {detail.isPending ? <p role="status">正在读取条目交付…</p> : detail.isError ? <div role="alert"><p>条目加载失败：{detail.error.message}</p><Button variant="outline" onClick={() => void detail.refetch()}>重试</Button></div> : snapshot && detail.data && <>
      <header className="space-y-3"><p className="text-sm text-muted-foreground">{projectName(snapshot.projectId)} · 当前查看来源采集于 {time(snapshot.collectedAt)}</p><div className="flex flex-wrap items-center justify-between gap-3"><h1 className="text-2xl font-semibold">{snapshot.demandNo} · {snapshot.plan.title}</h1><Button variant="cta" disabled={!workflow && !canStartWorkflow} onClick={() => openWorkflow()}>{workflow ? "查看交付进度" : "启动 AI 交付链"}</Button></div>{!workflow&&startBlockReason&&<p className="text-sm text-muted-foreground" role="status">{startBlockReason}</p>}<p className="text-sm">{snapshot.plan.roles.map(r => `${r.label}：${r.name || "来源未提供"}`).join(" · ") || "来源未提供负责人"}</p>
        <div className="flex flex-wrap gap-3"><Button variant="outline" asChild><Link to={sourceHref}>来源与历史</Link></Button><Button variant="outline" onClick={() => { void detail.refetch(); if(!workflowUnavailable)void workflowQuery.refetch(); }} disabled={detail.isFetching}>刷新执行情况</Button><Button variant="outline" asChild><Link to={href("/delivery-workbench", { projectId: snapshot.projectId, view: "reports" })}>项目交付报表</Link></Button></div>
      </header>
      <DeliveryEntryStages snapshot={snapshot} stages={stages} workflow={workflow} canManage={canManage} selectedStage={selectedStage} onSelectStage={stage => change({ stage, ...(tabParam === "analysis" ? { tab } : {}) })}/>
      {workflowQuery.isError&&!workflowUnavailable&&<div role="alert" className="text-sm text-destructive">自动交付核验记录读取失败：{workflowQuery.error.message}<Button variant="ghost" onClick={()=>void workflowQuery.refetch()}>重试</Button></div>}
      {companyId&&workflowQuery.isSuccess&&<details id="delivery-workflow" ref={workflowPanelRef} className="rounded-lg border border-border p-4" open={!!workflow||workflowPanelOpen||!!params.get("taskId")} onToggle={event=>setWorkflowPanelOpen(event.currentTarget.open)}><summary className="cursor-pointer font-medium">交付链实例与节点办理</summary><div className="mt-4"><DeliveryWorkflowPanel key={snapshot.id} companyId={companyId} snapshot={snapshot} canManage={canManage} startRequested={startRequested} initialReviewKey={requestedReviewKey} viewPlanRequest={viewPlanRequest}/></div></details>}
      <div className="grid gap-3 md:grid-cols-3">{[["来源业务状态", snapshot.plan.status || "来源未提供"], ["已接入平台执行", `${detail.data.tasks.length} 个任务 · ${detail.data.analyses.length} 个分析修订`], ["正式交付核验", workflow?(flowLabels[workflow.state]??workflow.state):"待核验"]].map(([label, value]) => <section key={label} className="space-y-2 rounded-lg border border-border p-4"><p className="text-sm text-muted-foreground">{label}</p><p className="font-medium">{value}</p></section>)}</div>
      {/* Keep the tab bar in view when a shorter panel reduces the scroll range. */}
      <div className="min-h-dvh space-y-5">
        <nav className="flex flex-wrap gap-2" aria-label="条目详情视图">
          {tabs.map(([key, label]) => <Button
            key={key}
            variant={key === tab ? "secondary" : "ghost"}
            aria-pressed={key === tab}
            onClick={() => openTab(key)}
          >{label}</Button>)}
        </nav>
        {tab === "overview" && <DeliveryEntryOverview
          detail={detail.data}
          workflow={workflow}
          onOpenWork={() => openTab("work")}
          onOpenWorkflow={openWorkflow}
        />}
        {tab === "work" && <div className="space-y-5">
          {jiraReviewResults.isError && <p role="status" className="text-sm text-muted-foreground">
            Jira 交付材料读取失败
            <Button variant="ghost" size="sm" onClick={() => void jiraReviewResults.refetch()}>重试</Button>
          </p>}
          <DeliveryWorkDispatch
            key={snapshot.id}
            plan={snapshot.plan}
            tasks={detail.data.tasks}
            admission={detail.data.admission}
            projectId={snapshot.projectId}
            snapshotId={snapshot.id}
            canManage={canManage}
            records={evidenceRecords}
            jiraReviewResults={jiraReviewResults.data?.results}
            jiraAttachments={jiraReviewResults.data?.attachments}
            workflowState={workflowState}
          />
          <DeliveryEntryEvidence
            companyId={companyId!}
            detail={detail.data}
            records={evidenceRecords}
            workflows={workflows}
            workflowState={workflowState}
          />
          <section className="space-y-2" aria-label="来源核对说明"><h2 className="font-semibold">待核对差异（{snapshot.plan.differences.length}）</h2><p className="text-sm text-muted-foreground">来源差异仅供核对，不修改轻舟或 Jira；来源完成状态不代表交付成果已核验。</p>{snapshot.plan.differences.length ? <ul className="list-disc space-y-2 pl-5 text-sm">{snapshot.plan.differences.map(d => <li key={d.key+d.code}>{d.key}：{d.message}</li>)}</ul> : <p className="text-sm">当前来源版本未发现结构差异。</p>}</section>
          {companyId && !workflow && <details className="rounded-lg border border-border p-4">
            <summary className="cursor-pointer font-medium">新增编码准入与结论登记</summary>
            <div className="mt-3">
              <DeliveryAdmissionPanel key={snapshot.id} companyId={companyId} snapshot={snapshot} admission={detail.data.admission} canManage={canManage} />
            </div>
          </details>}
        </div>}
      </div>
    </>}
  </div>;
  if (monthly) {
    const selected=activeProjects.find(p=>p.id===projectId)??(activeProjects.length===1?activeProjects[0]:undefined);
    return <div className="space-y-3"><header className="space-y-2"><h1 className="text-2xl font-semibold">需求条目</h1></header>
      <nav className="flex flex-wrap gap-3" aria-label="条目浏览方式"><Button variant="secondary" aria-pressed="true">月度排期</Button><Button variant="outline" asChild><Link to={href("/delivery",{view:"saved",...(selected?{projectId:selected.id}:{})})}>已纳管条目</Link></Button><Button variant="outline" asChild><Link to={href("/analysis-executions",selected?{projectId:selected.id}:{})}>独立需求分析</Link></Button></nav>
      {(projects.isPending||projects.isError||activeProjects.length!==1)&&<div className="flex flex-wrap items-start justify-between gap-3">{projects.isPending?<p role="status">正在加载项目…</p>:projects.isError?<p role="alert">项目读取失败。<Button variant="outline" onClick={()=>void projects.refetch()}>重试</Button></p>:activeProjects.length>1?<label className="flex items-center gap-2 text-sm">项目<select aria-label="月度排期项目" className={field} value={selected?.id??""} onChange={e=>change({projectId:e.target.value,...Object.fromEntries(monthlyFilterKeys.map(key=>[key,undefined]))})}><option value="">请选择项目</option>{activeProjects.map(p=><option key={p.id} value={p.id}>{p.name}</option>)}</select></label>:null}
      {!projects.isPending&&!projects.isError&&!activeProjects.length&&<p>请先在项目管理配置项目。</p>}
      </div>}
      {selected&&companyId&&<DeliveryMonthlyBoard key={"monthly:"+companyId+selected.id} companyId={companyId} projectId={selected.id} canManage={canManage}/>}
    </div>;
  }
  return <div className="space-y-5"><header className="space-y-3"><h1 className="text-2xl font-semibold">需求条目</h1><p className="text-sm text-muted-foreground">以需求为中心追踪分析、主子工单与交付材料。同一项目、来源和条目默认展示最新采集版本。</p><nav className="flex flex-wrap gap-3" aria-label="条目浏览方式"><Button variant="outline" asChild><Link to={href("/delivery",projectId?{projectId}:{})}>月度排期</Link></Button><Button variant="secondary" aria-pressed="true">已纳管条目</Button><Button variant="outline" asChild><Link to={href("/analysis-executions", projectId ? { projectId } : {})}>独立需求分析</Link></Button>{canManage && <Button variant="outline" asChild><Link to={sourceHref}>组织来源配置</Link></Button>}</nav></header>
    <form className="flex flex-wrap items-end gap-3" onSubmit={e => { e.preventDefault(); change({ q: search.trim(), page: undefined }); }} aria-label="条目筛选">{activeProjects.length>1&&<label className="space-y-2 text-sm"><span className="block">项目</span><select aria-label="条目项目" className={field} value={projectId} onChange={e => change({ projectId: e.target.value, page: undefined })}><option value="">全部项目</option>{activeProjects.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}</select></label>}<label className="space-y-2 text-sm"><span className="block">编号或标题</span><Input aria-label="条目搜索" maxLength={200} value={search} onChange={e => setSearch(e.target.value)} placeholder="例如 ATS3-00156" /></label><label className="space-y-2 text-sm"><span className="block">核对情况</span><select className={field} aria-label="条目核对情况" value={params.get("attention") === "differences" ? "differences" : "all"} onChange={e => change({ attention: e.target.value, page: undefined })}><option value="all">全部条目</option><option value="differences">存在来源差异</option></select></label><Button type="submit">查询</Button><Button type="button" variant="ghost" onClick={() => { setSearch(""); change({ q: undefined, attention: undefined, projectId: undefined, page: undefined }); }}>清除筛选</Button></form>
    {canManage&&companyId&&(projectId?<DeliveryDemandLookup key={companyId+projectId} companyId={companyId} projectId={projectId}/>:<p className="text-sm text-muted-foreground">查询未纳管的轻舟条目，请先选择具体项目，再按条目编号精确查询。</p>)}
    {projects.isError && <p role="alert">项目列表加载失败。<Button variant="outline" onClick={() => void projects.refetch()}>重试</Button></p>}
    {entries.isPending ? <p role="status">正在汇总需求条目…</p> : entries.isError ? <div role="alert"><p>条目加载失败：{entries.error.message}</p><Button variant="outline" onClick={() => void entries.refetch()}>重试</Button></div> : <>
      <div className="overflow-x-auto"><table className="w-full text-left text-sm"><caption className="sr-only">最新来源版本的需求条目</caption><thead><tr className="border-b border-border">{["条目", "项目／来源负责人", "来源状态", "主单／子单", "待核对差异", "来源采集时间", "操作"].map(label => <th key={label} className="p-3">{label}</th>)}</tr></thead><tbody>{entries.data?.items.map(s => <tr key={s.id} className="border-b border-border"><td className="p-3"><Link className="font-medium underline" to={href("/delivery", { ...Object.fromEntries(params), snapshotId: s.id })}>{s.demandNo} · {s.plan.title}</Link></td><td className="p-3"><p>{projectName(s.projectId)}</p><p className="text-xs text-muted-foreground">{s.plan.roles.map(r => `${r.label}：${r.name || "未提供"}`).join("；") || "来源未提供负责人"}</p></td><td className="p-3">{s.plan.status || "未提供"}</td><td className="p-3 font-mono">{s.plan.mains.length} / {s.plan.items.filter(i => i.parentKey).length}</td><td className="p-3">{s.plan.differences.length ? `${s.plan.differences.length} 项待核对` : "未发现结构差异"}</td><td className="whitespace-nowrap p-3"><p>{time(s.collectedAt)}</p><p className="text-xs text-muted-foreground">{s.plan.sourceMode === "online_readonly" ? "在线读取" : "手工快照"}</p></td><td className="p-3"><Button variant="ghost" asChild><Link to={href("/delivery", { ...Object.fromEntries(params), snapshotId: s.id })}>查看交付</Link></Button></td></tr>)}</tbody></table></div>
      {!entries.data?.items.length && <section className="space-y-3 rounded-lg border border-border p-5"><h2 className="font-semibold">当前筛选下暂无已纳管条目</h2><p className="text-sm text-muted-foreground">可调整筛选；首次使用请由管理员接入轻舟来源或导入条目快照。</p>{canManage && <Button variant="outline" asChild><Link to={sourceHref}>接入条目来源</Link></Button>}</section>}
      <div className="flex items-center justify-between"><Button variant="outline" disabled={page <= 1 || entries.isFetching} onClick={() => change({ page: String(page - 1) })}>上一页</Button><p className="text-sm">第 {page} 页 · 每页最多 20 个条目</p><Button variant="outline" disabled={!entries.data?.hasMore || entries.isFetching} onClick={() => change({ page: String(page + 1) })}>下一页</Button></div>
    </>}
  </div>;
}
