import { DeliveryChainAdmissionPanel } from "@/components/DeliveryChainAdmissionPanel";
import { DeliveryMaterials } from "@/components/DeliveryMaterials";
import { ApiError } from "@/api/client";
import { DeliveryEntryStages } from "@/components/DeliveryEntryStages";
import { ENTRY_STAGES, type EntryStageId } from "@/lib/delivery-entry-stages";
import { deliveryWorkflowApi } from "@/api/delivery-workflows";
import { DeliveryWorkflowPanel } from "@/components/DeliveryWorkflowPanel";
import { useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link, useSearchParams } from "@/lib/router";
import { useCompany } from "@/context/CompanyContext";
import { useBreadcrumbs } from "@/context/BreadcrumbContext";
import { useManagementAccess } from "@/hooks/useManagementAccess";
import { projectsApi } from "@/api/projects";
import { deliveryIntakeApi } from "@/api/delivery-intake";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { monthlyFilterKeys } from "@/lib/delivery-monthly-filters";
import { DeliveryWorkDispatch } from "@/components/DeliveryWorkDispatch";
import { DeliveryMonthlyBoard } from "@/components/DeliveryMonthlyBoard";
import { DeliveryAdmissionPanel } from "@/components/DeliveryAdmissionPanel";
import { DeliverySourcePlan, DeliverySources } from "./DeliveryIntake";

const field = "rounded-md border border-border bg-background p-2 text-sm";
const analysisStates: Record<string, string> = { draft: "未派发", queued: "排队中", running: "分析执行中", waiting: "等待人工决定", interrupted: "中断待处理", local_completed: "本地完成，待正式发布", published: "已登记正式发布" };
const taskStates: Record<string, string> = { backlog: "待安排", todo: "待执行", in_progress: "处理中", in_review: "待评审", blocked: "存在阻塞", done: "已完成", cancelled: "已取消" };
const runStates: Record<string, string> = { queued: "排队中", running: "运行中", scheduled_retry: "等待重试", succeeded: "运行结束", failed: "运行失败", cancelled: "运行已停止", timed_out: "运行超时" };
const tabs = [["overview", "交付概览"], ["work", "工单与执行"], ["analysis", "需求分析"], ["materials", "交付物与核验"]] as const;
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
  const [workflowPanelOpen, setWorkflowPanelOpen] = useState(false);
  const [startRequested, setStartRequested] = useState(false);
  const workflowPanelRef = useRef<HTMLDetailsElement>(null);
  const projectId = params.get("projectId") ?? "";
  const snapshotId = params.get("snapshotId") ?? "";
  const sources = params.get("view") === "sources";
  const monthly = !snapshotId && !sources && params.get("view") !== "saved";
  const tab = tabs.some(([key]) => key === params.get("tab")) ? params.get("tab")! : "overview";
  const page = Math.max(1, Math.floor(Number(params.get("page")) || 1));
  const q = params.get("q") ?? "";
  const [search, setSearch] = useState(q);
  useEffect(() => setSearch(q), [q]);
  function change(values: Record<string, string | undefined>) {
    setParams(previous => { const next = new URLSearchParams(previous); for (const [key, value] of Object.entries(values)) { if (value) next.set(key, value); else next.delete(key); } return next; });
  }
  const projects = useQuery({ queryKey: ["delivery-projects", companyId], queryFn: () => projectsApi.list(companyId!), enabled: !!companyId });
  const activeProjects = projects.data?.filter(p => !p.archivedAt) ?? [];
  const projectName = (id: string) => projects.data?.find(p => p.id === id)?.name ?? "项目加载中";
  const query = new URLSearchParams({ page: String(page), q, attention: params.get("attention") === "differences" ? "differences" : "all", ...(projectId ? { projectId } : {}) });
  const entries = useQuery({ queryKey: ["delivery-entries", companyId, query.toString()], queryFn: () => deliveryIntakeApi.entries(companyId!, query), enabled: !!companyId && !snapshotId && !sources && !monthly });
  const detail = useQuery({ queryKey: ["delivery-entry", companyId, snapshotId], queryFn: () => deliveryIntakeApi.entry(companyId!, snapshotId), enabled: !!companyId && !!snapshotId && !sources, refetchInterval: 15000 });
  const selectedStage = ENTRY_STAGES.find(stage => stage.id === params.get("stage"))?.id;
  const workflowQuery=useQuery({queryKey:["delivery-workflows",companyId,snapshotId],queryFn:()=>deliveryWorkflowApi.list(companyId!,snapshotId),enabled:!!companyId&&!!snapshotId&&!sources,retry:(count,error)=>!(error instanceof ApiError&&error.status===404)&&count<2,refetchInterval:query=>query.state.error instanceof ApiError&&query.state.error.status===404?false:5000});
  const workflow=workflowQuery.data?.[0];
  const workflowUnavailable=workflowQuery.error instanceof ApiError&&workflowQuery.error.status===404;
  const canStartWorkflow = !!detail.data?.chainAdmission?.ready && canManage && workflowQuery.isSuccess && !workflow;
  const startBlockReason = !canManage ? "需要交付管理员权限才能启动" : workflowQuery.isPending ? "正在核对已有交付流程…" : workflowQuery.isError ? "交付流程状态暂不可用，请刷新后重试" : !detail.data?.chainAdmission?.ready ? detail.data?.chainAdmission?.reasons.join("；") || "交付链准入条件尚未满足" : "";
  const flowLabels:Record<string,string>={active:"自动交付中",blocked:"交付阻塞待处理",acceptance:"待正式验收",completed:"已登记正式验收",cancelled:"自动交付已取消"};
  const snapshot = detail.data?.snapshot;
  useEffect(() => { if (!sources) setBreadcrumbs(snapshot ? [{ label: "需求条目", href: "/delivery" + (projectId ? `?projectId=${projectId}` : "") }, { label: snapshot.demandNo }] : [{ label: "需求条目" }]); }, [setBreadcrumbs, sources, snapshot?.demandNo, projectId]);
  const href = (path: string, values: Record<string, string>) => path + "?" + new URLSearchParams(values);
  const sourceHref = href("/delivery", { projectId: snapshot?.projectId ?? projectId, view: "sources", ...(snapshot ? { demandNo: snapshot.demandNo, snapshotId: snapshot.id } : {}) });
  const admissionOverviewParams=new URLSearchParams(params);admissionOverviewParams.set("tab","overview");admissionOverviewParams.delete("stage");
  const admissionOverviewHref="/delivery?"+admissionOverviewParams+"#delivery-admission";
  if (sources) return <DeliverySources key={companyId + projectId + (params.get("demandNo") ?? "")} />;
  if (snapshotId) return <div className="space-y-5">
    <Button variant="ghost" onClick={() => change({ snapshotId: undefined, tab: undefined, stage: undefined })}>返回条目列表</Button>
    {detail.isPending ? <p role="status">正在读取条目交付…</p> : detail.isError ? <div role="alert"><p>条目加载失败：{detail.error.message}</p><Button variant="outline" onClick={() => void detail.refetch()}>重试</Button></div> : snapshot && detail.data && <>
      <header className="space-y-3"><p className="text-sm text-muted-foreground">{projectName(snapshot.projectId)} · 当前查看来源采集于 {time(snapshot.collectedAt)}</p><div className="flex flex-wrap items-center justify-between gap-3"><h1 className="text-2xl font-semibold">{snapshot.demandNo} · {snapshot.plan.title}</h1><Button variant="cta" disabled={!workflow && !canStartWorkflow} onClick={() => { if (!workflow && !canStartWorkflow) return; setWorkflowPanelOpen(true); setStartRequested(!workflow); requestAnimationFrame(() => workflowPanelRef.current?.scrollIntoView({behavior:"smooth",block:"start"})); }}>{workflow ? "查看交付进度" : "启动 AI 交付链"}</Button></div>{!workflow&&startBlockReason&&<p className="text-sm text-muted-foreground" role="status">{startBlockReason}</p>}<p className="text-sm">{snapshot.plan.roles.map(r => `${r.label}：${r.name || "来源未提供"}`).join(" · ") || "来源未提供负责人"}</p>
        <div className="flex flex-wrap gap-3"><Button variant="outline" asChild><Link to={sourceHref}>来源与历史</Link></Button><Button variant="outline" onClick={() => { void detail.refetch(); if(!workflowUnavailable)void workflowQuery.refetch(); }} disabled={detail.isFetching}>刷新执行情况</Button><Button variant="outline" asChild><Link to={href("/delivery-workbench", { projectId: snapshot.projectId, view: "reports" })}>项目交付报表</Link></Button></div>
      </header>
      <DeliveryEntryStages key={snapshot.id} detail={detail.data} workflow={workflow} canManage={canManage} selectedStage={selectedStage as EntryStageId|undefined} onSelectStage={stage=>change({stage})}/>
      {workflowQuery.isError&&!workflowUnavailable&&<div role="alert" className="text-sm text-destructive">自动交付核验记录读取失败：{workflowQuery.error.message}<Button variant="ghost" onClick={()=>void workflowQuery.refetch()}>重试</Button></div>}
      {companyId&&workflowQuery.isSuccess&&<details ref={workflowPanelRef} className="rounded-lg border border-border p-4" open={!!workflow||workflowPanelOpen} onToggle={event=>setWorkflowPanelOpen(event.currentTarget.open)}><summary className="cursor-pointer font-medium">自动交付配置与人工决策</summary><div className="mt-4"><DeliveryWorkflowPanel key={snapshot.id} companyId={companyId} snapshot={snapshot} canManage={canManage} startRequested={startRequested}/></div></details>}
      <div className="grid gap-3 md:grid-cols-3">{[["来源业务状态", snapshot.plan.status || "来源未提供"], ["已接入平台执行", `${detail.data.tasks.length} 个任务 · ${detail.data.analyses.length} 个分析修订`], ["正式交付核验", workflow?(flowLabels[workflow.state]??workflow.state):"待核验"]].map(([label, value]) => <section key={label} className="space-y-2 rounded-lg border border-border p-4"><p className="text-sm text-muted-foreground">{label}</p><p className="font-medium">{value}</p></section>)}</div>
      <nav className="flex flex-wrap gap-2" aria-label="条目详情视图">{tabs.map(([key, label]) => <Button key={key} variant={key === tab ? "secondary" : "ghost"} aria-pressed={key === tab} onClick={() => change({ tab: key, ...(key === "overview" ? { stage: undefined } : {}) })}>{label}</Button>)}</nav>
      {tab==="overview"&&!selectedStage&&<DeliveryChainAdmissionPanel admission={detail.data.chainAdmission}/>}
      {companyId&&!workflow&&<DeliveryAdmissionPanel key={snapshot.id} companyId={companyId} snapshot={snapshot} admission={detail.data.admission} canManage={canManage} compact={tab!=="overview"||!!selectedStage} overviewHref={admissionOverviewHref}/>}
      {tab === "overview" && !selectedStage && <>
        
        <section className="space-y-3 rounded-lg border border-border p-4"><h2 className="font-semibold">下一步行动</h2>{snapshot.plan.differences.length > 0 ? <p>有 {snapshot.plan.differences.length} 项来源差异需要核对，请先在“工单与执行”查看缺项，再通过“来源与历史”核对版本。</p> : <p>本来源版本未发现结构差异。请核对分析交接、研发交付和测试准入材料，来源状态不代替正式结论。</p>}
          {detail.data.analyses.filter(a => a.state === "waiting" || a.state === "interrupted").map(a => <p key={a.id}><Link className="underline" to={href("/analysis-executions", { projectId: snapshot.projectId, executionId: a.id })}>{a.title} · {analysisStates[a.state]} → 查看问题与决定</Link></p>)}
          {detail.data.tasks.filter(t => t.status === "blocked" || ["failed", "timed_out"].includes(t.runStatus ?? "")).map(t => <p key={t.id}><Link className="underline" to={`/issues/${t.id}`}>{t.jiraKey} · 需要处理 → 查看任务与决策</Link></p>)}
        </section>

      </>}
      {tab === "work" && <div className="space-y-5"><DeliveryWorkDispatch key={snapshot.id} plan={snapshot.plan} tasks={detail.data.tasks} admission={detail.data.admission} projectId={snapshot.projectId} snapshotId={snapshot.id} canManage={canManage}/><DeliverySourcePlan plan={snapshot.plan} /><section className="space-y-3"><h2 className="font-semibold">平台任务与运行</h2><p className="text-sm text-muted-foreground">按本项目中已登记的 Jira 身份关联，平台任务状态与运行状态分别展示；未接入不等于没有工单。</p>{detail.data.tasks.map(t => <article key={t.id} className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-border p-3"><div><Link className="font-medium underline" to={`/issues/${t.id}`}>{t.jiraKey} · {t.title}</Link><p className="text-sm">任务：{taskStates[t.status] ?? t.status} · 运行：{t.runStatus ? runStates[t.runStatus] ?? t.runStatus : "尚无关联运行"}</p><p className="text-xs text-muted-foreground">更新于 {time(t.updatedAt)}</p></div><Button variant="outline" asChild><Link to={`/issues/${t.id}`}>对话、决策与恢复</Link></Button></article>)}{!detail.data.tasks.length && <p>该来源版本中的 Jira 工单尚无可关联的平台接入任务。</p>}<Button variant="outline" asChild><Link to={href("/jira-intake", { projectId: snapshot.projectId, demandNo: snapshot.demandNo, snapshotId: snapshot.id })}>接入并派发 Jira 工单</Link></Button></section></div>}
      {tab === "analysis" && <section className="space-y-3"><h2 className="font-semibold">关联需求分析</h2><p className="text-sm text-muted-foreground">按同一项目、条目编号关联，保留所有修订。已有独立分析可通过原流程管理。</p>{detail.data.analyses.map(a => <article key={a.id} className="space-y-2 rounded-md border border-border p-3"><Link className="font-medium underline" to={href("/analysis-executions", { projectId: snapshot.projectId, executionId: a.id, demandNo: snapshot.demandNo, snapshotId: snapshot.id })}>{a.title} · 修订 {a.revision}</Link><p className="text-sm">{analysisStates[a.state] ?? a.state} · {time(a.updatedAt)}</p></article>)}{!detail.data.analyses.length && <p>尚无与此条目编号关联的分析任务。</p>}<Button variant="outline" asChild><Link to={href("/analysis-executions", { projectId: snapshot.projectId, demandNo: snapshot.demandNo, snapshotId: snapshot.id })}>{canManage ? "创建或查看分析任务" : "查看分析任务"}</Link></Button></section>}
      {tab === "materials" && <DeliveryMaterials companyId={companyId!} detail={detail.data} workflow={workflow} workflowState={workflowQuery.isPending ? "loading" : workflowQuery.isError ? "unavailable" : "ready"} />}
    </>}
  </div>;
  if (monthly) {
    const selected=activeProjects.find(p=>p.id===projectId)??(activeProjects.length===1?activeProjects[0]:undefined);
    return <div className="space-y-5"><header className="space-y-3"><h1 className="text-2xl font-semibold">需求条目</h1><p className="text-sm text-muted-foreground">从月度计划安排分析、设计与编码，按真实交付条件推进。</p></header>
      <nav className="flex flex-wrap gap-3" aria-label="条目浏览方式"><Button variant="secondary" aria-pressed="true">月度排期</Button><Button variant="outline" asChild><Link to={href("/delivery",{view:"saved",...(selected?{projectId:selected.id}:{})})}>已纳管条目</Link></Button><Button variant="outline" asChild><Link to={href("/analysis-executions",selected?{projectId:selected.id}:{})}>独立需求分析</Link></Button></nav>
      {projects.isPending?<p role="status">正在加载项目…</p>:projects.isError?<p role="alert">项目读取失败。<Button variant="outline" onClick={()=>void projects.refetch()}>重试</Button></p>:<label className="block space-y-2 text-sm">项目<select aria-label="月度排期项目" className={field} value={selected?.id??""} onChange={e=>change({projectId:e.target.value,...Object.fromEntries(monthlyFilterKeys.map(key=>[key,undefined]))})}><option value="">请选择项目</option>{activeProjects.map(p=><option key={p.id} value={p.id}>{p.name}</option>)}</select></label>}
      {!projects.isPending&&!projects.isError&&!activeProjects.length&&<p>请先在项目管理配置项目。</p>}
      {selected&&companyId&&<DeliveryMonthlyBoard key={companyId+selected.id} companyId={companyId} projectId={selected.id} canManage={canManage}/>}
    </div>;
  }
  return <div className="space-y-5"><header className="space-y-3"><h1 className="text-2xl font-semibold">需求条目</h1><p className="text-sm text-muted-foreground">以需求为中心追踪分析、主子工单与交付材料。同一项目、来源和条目默认展示最新采集版本。</p><nav className="flex flex-wrap gap-3" aria-label="条目浏览方式"><Button variant="outline" asChild><Link to={href("/delivery",projectId?{projectId}:{})}>月度排期</Link></Button><Button variant="secondary" aria-pressed="true">已纳管条目</Button><Button variant="outline" asChild><Link to={href("/analysis-executions", projectId ? { projectId } : {})}>独立需求分析</Link></Button>{canManage && <Button variant="outline" asChild><Link to={sourceHref}>组织来源配置</Link></Button>}</nav></header>
    <form className="flex flex-wrap items-end gap-3" onSubmit={e => { e.preventDefault(); change({ q: search.trim(), page: undefined }); }} aria-label="条目筛选"><label className="space-y-2 text-sm"><span className="block">项目</span><select aria-label="条目项目" className={field} value={projectId} onChange={e => change({ projectId: e.target.value, page: undefined })}><option value="">全部项目</option>{activeProjects.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}</select></label><label className="space-y-2 text-sm"><span className="block">编号或标题</span><Input aria-label="条目搜索" maxLength={200} value={search} onChange={e => setSearch(e.target.value)} placeholder="例如 ATS3-00156" /></label><label className="space-y-2 text-sm"><span className="block">核对情况</span><select className={field} aria-label="条目核对情况" value={params.get("attention") === "differences" ? "differences" : "all"} onChange={e => change({ attention: e.target.value, page: undefined })}><option value="all">全部条目</option><option value="differences">存在来源差异</option></select></label><Button type="submit">查询</Button><Button type="button" variant="ghost" onClick={() => { setSearch(""); change({ q: undefined, attention: undefined, projectId: undefined, page: undefined }); }}>清除筛选</Button></form>
    {projects.isError && <p role="alert">项目列表加载失败。<Button variant="outline" onClick={() => void projects.refetch()}>重试</Button></p>}
    {entries.isPending ? <p role="status">正在汇总需求条目…</p> : entries.isError ? <div role="alert"><p>条目加载失败：{entries.error.message}</p><Button variant="outline" onClick={() => void entries.refetch()}>重试</Button></div> : <>
      <div className="overflow-x-auto"><table className="w-full text-left text-sm"><caption className="sr-only">最新来源版本的需求条目</caption><thead><tr className="border-b border-border">{["条目", "项目／来源负责人", "来源状态", "主单／子单", "待核对差异", "来源采集时间", "操作"].map(label => <th key={label} className="p-3">{label}</th>)}</tr></thead><tbody>{entries.data?.items.map(s => <tr key={s.id} className="border-b border-border"><td className="p-3"><Link className="font-medium underline" to={href("/delivery", { ...Object.fromEntries(params), snapshotId: s.id })}>{s.demandNo} · {s.plan.title}</Link></td><td className="p-3"><p>{projectName(s.projectId)}</p><p className="text-xs text-muted-foreground">{s.plan.roles.map(r => `${r.label}：${r.name || "未提供"}`).join("；") || "来源未提供负责人"}</p></td><td className="p-3">{s.plan.status || "未提供"}</td><td className="p-3 font-mono">{s.plan.mains.length} / {s.plan.items.filter(i => i.parentKey).length}</td><td className="p-3">{s.plan.differences.length ? `${s.plan.differences.length} 项待核对` : "未发现结构差异"}</td><td className="whitespace-nowrap p-3"><p>{time(s.collectedAt)}</p><p className="text-xs text-muted-foreground">{s.plan.sourceMode === "online_readonly" ? "在线读取" : "手工快照"}</p></td><td className="p-3"><Button variant="ghost" asChild><Link to={href("/delivery", { ...Object.fromEntries(params), snapshotId: s.id })}>查看交付</Link></Button></td></tr>)}</tbody></table></div>
      {!entries.data?.items.length && <section className="space-y-3 rounded-lg border border-border p-5"><h2 className="font-semibold">当前筛选下暂无已纳管条目</h2><p className="text-sm text-muted-foreground">可调整筛选；首次使用请由管理员接入轻舟来源或导入条目快照。</p>{canManage && <Button variant="outline" asChild><Link to={sourceHref}>接入条目来源</Link></Button>}</section>}
      <div className="flex items-center justify-between"><Button variant="outline" disabled={page <= 1 || entries.isFetching} onClick={() => change({ page: String(page - 1) })}>上一页</Button><p className="text-sm">第 {page} 页 · 每页最多 20 个条目</p><Button variant="outline" disabled={!entries.data?.hasMore || entries.isFetching} onClick={() => change({ page: String(page + 1) })}>下一页</Button></div>
    </>}
  </div>;
}
