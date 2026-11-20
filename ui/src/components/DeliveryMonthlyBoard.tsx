import { DELIVERY_CHAIN_ADMISSION_LABELS } from "@paperclipai/shared";
import { SourceStatusMultiSelect } from "./SourceStatusMultiSelect";
import { useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { DeliveryConnection, DeliveryMonthlyEntries, DeliverySnapshot } from "@paperclipai/shared";
import { api } from "@/api/client";
import { DeliveryDemandLookup } from "@/components/DeliveryDemandLookup";
import { DeliveryMonthlySchedule } from "@/components/DeliveryMonthlySchedule";
import { DeliveryMonthlyBulkSync } from "@/components/DeliveryMonthlyBulkSync";
import { SearchableSelect } from "@/components/SearchableSelect";
import { clearMonthlyFilters, normalizeMonthlyFilters, filterMonthlyEntries, monthlyFilterKeys, monthlySourceOptions, monthlySelectedStatuses, monthlyDetailHref, matchesMonthlyRisk, monthlyRiskViews, monthlyNextAction, monthlyProgressViews, monthlyProgress } from "@/lib/delivery-monthly-filters";
import { Button } from "@/components/ui/button";
import { Link, useNavigate, useSearchParams } from "@/lib/router";

export function DeliveryMonthlyBoard({ companyId, projectId, canManage }: { companyId:string; projectId:string; canManage:boolean }) {
  const navigate=useNavigate(), qc=useQueryClient();
  const [urlParams,setParams]=useSearchParams();
  const params=normalizeMonthlyFilters(urlParams);
  const urlFilterSearch=urlParams.toString(), normalizedFilterSearch=params.toString();
  useEffect(()=>{
    if(urlFilterSearch!==normalizedFilterSearch)setParams(normalizedFilterSearch,{replace:true});
  },[urlFilterSearch,normalizedFilterSearch,setParams]);
  const [page,setPage]=useState(1),[selected,setSelected]=useState<string[]>([]),[preview,setPreview]=useState(false),[receipts,setReceipts]=useState<{demandNo:string;ok:boolean;message:string}[]>([]);
  const base=`/companies/${companyId}/delivery-connections`;
  const [month,setMonth]=useState(() => { if(/^\d{4}-(0[1-9]|1[0-2])$/.test(params.get("month")??""))return params.get("month")!; const now=new Date();return `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,"0")}`; });
  const [actionBusy,setBusy]=useState(""),[actionError,setError]=useState("");
  const urlMonth=params.get("month");
  useEffect(()=>{if(urlMonth&&/^\d{4}-(0[1-9]|1[0-2])$/.test(urlMonth))setMonth(urlMonth);},[urlMonth]);
  const urlSearch=params.get("mq")??"";
  const [search,setSearch]=useState(urlSearch);
  const searchComposing=useRef(false);
  useEffect(()=>{if(!searchComposing.current)setSearch(urlSearch);},[urlSearch]);
  const filterStamp=JSON.stringify(monthlyFilterKeys.map(key=>params.getAll(key)));
  useEffect(()=>{setSelected([]);setPreview(false);setReceipts([]);setPage(1);},[filterStamp]);
  function filter(key:string,value:string) {
    setParams(previous=>{const next=new URLSearchParams(previous);if(value)next.set(key,value);else next.delete(key);if(key==="mProgress")next.delete("mStatus");return next;},{replace:true});
  }
  function clearFilters() {
    setSearch("");
    setParams(previous=>clearMonthlyFilters(previous),{replace:true});
  }
  const connection=useQuery({queryKey:["delivery-connection",companyId,projectId],queryFn:()=>api.get<DeliveryConnection|null>(`${base}?projectId=${projectId}`)});
  const sourceHref="/delivery?"+new URLSearchParams({projectId,view:"sources",month});
  const monthlyKey=["delivery-monthly",companyId,projectId,connection.data?.revision,month];
  const forceRefresh=useRef(false);
  const monthly=useQuery({queryKey:monthlyKey,queryFn:()=>{const force=forceRefresh.current;forceRefresh.current=false;return api.post<DeliveryMonthlyEntries>(`${base}/monthly`,{projectId,expectedRevision:connection.data!.revision,month,...(force?{forceRefresh:true}:{})});},enabled:canManage&&!!connection.data?.credentialsConfigured&&/^\d{4}-(0[1-9]|1[0-2])$/.test(month),retry:false,staleTime:60_000,refetchOnWindowFocus:false});
  const result=monthly.data;
  const busy=actionBusy||(monthly.isFetching?"read":"");
  const error=actionError||(monthly.isError?monthly.error.message:"");
  useEffect(()=>{setSelected([]);setPreview(false);setReceipts([]);setPage(1);setError("");},[month,connection.data?.revision]);
  async function read() { setError("");setSelected([]);setPreview(false);setReceipts([]);setPage(1);forceRefresh.current=true;await monthly.refetch(); }
  function recordSynced(demandNo:string,snapshotId:string) {
    qc.setQueryData<DeliveryMonthlyEntries>(monthlyKey,previous=>previous?{...previous,items:previous.items.map(item=>item.demandNo===demandNo?{...item,snapshotId,admission:item.snapshotId===snapshotId?item.admission:null,chainAdmission:item.snapshotId===snapshotId?item.chainAdmission:null}:item)}:previous);
  }
  async function sync(demandNo:string) {
    setBusy(demandNo);setError("");
    try {
      const response=await api.post<{snapshot:DeliverySnapshot}>(`${base}/sync`,{projectId,expectedRevision:connection.data?.revision,demandNo,months:[month]});
      recordSynced(demandNo,response.snapshot.id);
      await qc.invalidateQueries({queryKey:["delivery-entries",companyId]});
      navigate(monthlyDetailHref(params,projectId,response.snapshot.id,month));
    }catch(e){setError(e instanceof Error?e.message:"条目同步失败");}finally{setBusy("");}
  }
  async function batch() {
    setBusy("batch");setError("");setReceipts([]);
    for (const demandNo of selected) {
      try {
        const response=await api.post<{snapshot:DeliverySnapshot;existing?:boolean}>(`${base}/sync`,{projectId,expectedRevision:connection.data?.revision,demandNo,months:[month]});
        recordSynced(demandNo,response.snapshot.id);
        setReceipts(previous=>[...previous,{demandNo,ok:true,message:response.existing?"已有相同来源版本":"已同步只读版本"}]);
      } catch(e){setReceipts(previous=>[...previous,{demandNo,ok:false,message:e instanceof Error?e.message:"同步失败，可单独重试"}]);}
    }
    await qc.invalidateQueries({queryKey:["delivery-entries",companyId]});setBusy("");
  }
  const items=filterMonthlyEntries(result?.items??[],params);
  const riskBase = new URLSearchParams(params); riskBase.delete("mRisk");
  const riskRows = filterMonthlyEntries(result?.items ?? [], riskBase);
  const progressBase = new URLSearchParams(params); progressBase.delete("mProgress"); progressBase.delete("mRisk");
  const progressRows = filterMonthlyEntries(result?.items ?? [], progressBase);
  const pageCount=Math.max(1,Math.ceil(items.length/20));
  const currentPage=Math.min(page,pageCount);
  const field="rounded-md border border-border bg-background p-2 text-sm";
  const activeFilters=monthlyFilterKeys.filter(key=>params.getAll(key).some(Boolean)).length;
  const advancedFilters=["mOwner","mAnalysisOwner","mStatus","mSync","mAdmission","mWork"].filter(key=>params.getAll(key).some(Boolean)).length;
  const [advancedOpen,setAdvancedOpen]=useState(()=>advancedFilters>0);
  return <section className="space-y-3" aria-label="月度排期条目">
    <section className="space-y-3 rounded-lg border border-border p-3" aria-label="月度条目筛选">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-sm font-semibold">月度条目</h2>
        <div className="flex flex-wrap items-center gap-2">
          <Button type="button" size="sm" variant="outline" onClick={()=>void read()} disabled={!!busy||!connection.data?.credentialsConfigured||!month||!canManage}>{busy==="read"?"正在读取…":monthly.isError?"重试读取":"刷新条目"}</Button>
          {canManage&&connection.data?.credentialsConfigured&&<DeliveryMonthlySchedule key={companyId+":"+projectId} companyId={companyId} projectId={projectId} />}
          {canManage&&<Link className="text-xs text-muted-foreground underline" to={sourceHref}>来源配置</Link>}
        </div>
      </div>
      <div className="grid items-end gap-3 sm:grid-cols-2 lg:grid-cols-4"><label className="space-y-2 text-sm"><span className="block">{connection.data?.subProductAttribution?"查询月份":"排期月份"}</span><input type="month" required aria-label="排期月份" value={month} disabled={!!busy} onChange={e=>{setMonth(e.target.value);setError("");setSelected([]);setPreview(false);setParams(previous=>{const next=new URLSearchParams(previous);next.set("month",e.target.value);return next;});}} className={field+" w-full"} /></label><label className="space-y-2 text-sm"><span className="block">关键词</span><input disabled={!!actionBusy} aria-label="月度条目搜索" value={search} onCompositionStart={()=>{searchComposing.current=true;}} onCompositionEnd={e=>{searchComposing.current=false;setSearch(e.currentTarget.value);filter("mq",e.currentTarget.value);}} onChange={e=>{setSearch(e.currentTarget.value);if(!searchComposing.current)filter("mq",e.currentTarget.value);}} placeholder="编号、标题或负责人" maxLength={200} className={field+" w-full"}/></label><label className="block space-y-2 text-sm"><span className="block">条目归属分类</span><select disabled={!!actionBusy} aria-label="月度条目归属分类" className={field+" w-full"} value={params.get("mScope")??"all"} onChange={e=>filter("mScope",e.target.value==="all"?"":e.target.value)}><option value="all">全部（合并去重）</option><option value="scheduled">本组织已排期</option><option value="expected">本月期望交付</option></select></label><label className="space-y-2 text-sm"><span className="block">风险提醒</span><select aria-label="月度交付风险" disabled={!!actionBusy} className={field+" w-full"} value={params.get("mRisk")??"all"} onChange={e=>filter("mRisk",e.target.value==="all"?"":e.target.value)}>{monthlyRiskViews.map(([key,label])=><option key={key} value={key}>{label}（{key==="all"?riskRows.length:riskRows.filter(item=>matchesMonthlyRisk(item,key)).length}）</option>)}</select></label></div>
      {canManage&&<DeliveryDemandLookup key={companyId+projectId} companyId={companyId} projectId={projectId} month={month} compact/>}
      {result&&<><div className="flex flex-wrap items-center gap-2" role="group" aria-label="月度来源进度"><span className="text-sm text-muted-foreground">进度</span>{monthlyProgressViews.map(([key,label])=><Button key={key} size="sm" variant={(params.get("mProgress")??"all")===key?"secondary":"ghost"} disabled={!!actionBusy} aria-pressed={(params.get("mProgress")??"all")===key} onClick={()=>filter("mProgress",key==="all"?"":key)}>{label} <span className="tabular-nums text-muted-foreground">{key==="all"?progressRows.length:progressRows.filter(item=>monthlyProgress(item)===key).length}</span></Button>)}</div><details className="group space-y-3" aria-label="更多筛选" open={advancedOpen} onToggle={e=>setAdvancedOpen(e.currentTarget.open)}>
        <summary className="cursor-pointer text-sm font-medium">更多筛选{advancedFilters?` · ${advancedFilters} 项已选`:""}</summary>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <div className="space-y-2 text-sm" role="group" aria-label="来源负责人筛选"><span className="block">来源负责人</span><SearchableSelect disabled={!!actionBusy} value={params.get("mOwner")??""} groups={[{id:"owners",options:[{key:"all",value:"",label:"全部负责人"},...monthlySourceOptions(result.items,"owner")]}]} onValueChange={value=>filter("mOwner",value)} placeholder="全部负责人" searchPlaceholder="搜索负责人" emptyMessage="没有匹配的负责人" loadingMessage="正在加载负责人…" renderValue={option=>option?.label??"所选负责人（本月未返回）"} triggerClassName="w-full"/></div>
          <div className="space-y-2 text-sm" role="group" aria-label="条目分析负责人筛选"><span className="block">条目分析负责人</span><SearchableSelect disabled={!!actionBusy} value={params.get("mAnalysisOwner")??""} groups={[{id:"analysis-owners",options:[{key:"all",value:"",label:"全部分析负责人"},...monthlySourceOptions(result.items,"analysisOwner")]}]} onValueChange={value=>filter("mAnalysisOwner",value)} placeholder="全部分析负责人" searchPlaceholder="搜索分析负责人" emptyMessage="没有匹配的分析负责人" loadingMessage="正在加载分析负责人…" renderValue={option=>option?.label??"所选分析负责人（本月未返回）"} triggerClassName="w-full"/></div>
          <div className="space-y-2 text-sm"><span className="block">来源状态</span><SourceStatusMultiSelect label="月度来源状态" disabled={!!actionBusy} options={monthlySourceOptions(result.items,"sourceStatus")} values={monthlySelectedStatuses(params)} onChange={values=>setParams(previous=>{const next=new URLSearchParams(previous);next.delete("mStatus");next.delete("mProgress");values.forEach(value=>next.append("mStatus",value));return next;},{replace:true})}/></div>
          <label className="space-y-2 text-sm"><span className="block">同步情况</span><select disabled={!!actionBusy} aria-label="月度同步情况" value={params.get("mSync")??""} onChange={e=>filter("mSync",e.target.value)} className={field+" w-full"}><option value="">全部同步情况</option><option value="unsynced">尚未同步</option><option value="saved">已纳管</option></select></label>
          <label className="space-y-2 text-sm"><span className="block">交付链准入</span><select disabled={!!actionBusy} aria-label="月度交付链准入" value={params.get("mAdmission")??""} onChange={e=>filter("mAdmission",e.target.value)} className={field+" w-full"}><option value="">全部准入情况</option><option value="unconfigured">未配置准入规则</option><option value="verified">可进入或已进入交付链</option><option value="pending">开始节点条件待核验</option></select></label>
          <label className="space-y-2 text-sm"><span className="block">工单情况</span><select disabled={!!actionBusy} aria-label="月度工单情况" value={params.get("mWork")??""} onChange={e=>filter("mWork",e.target.value)} className={field+" w-full"}><option value="">全部工单情况</option><option value="has">已有工单</option><option value="none">暂无工单</option></select></label>
        </div>

        <p className="text-xs text-muted-foreground">同类状态任选其一，其他条件同时满足。修改筛选会清空批量选择。</p>
      </details>
</>}
      <div className="flex flex-wrap items-center justify-between gap-2"><p className="text-xs text-muted-foreground">{activeFilters?`已启用 ${activeFilters} 项筛选`:"全部条目"} · 筛选可组合使用</p><Button type="button" size="sm" variant="ghost" disabled={!activeFilters||!!actionBusy} onClick={clearFilters}>清除全部筛选</Button></div>
    </section>
    {connection.isError?<p role="alert">来源配置加载失败。<Button variant="outline" onClick={()=>void connection.refetch()}>重试</Button></p>:!connection.isPending&&!connection.data?<p>尚未配置项目来源。{canManage&&<Link className="underline" to={sourceHref}>配置轻舟与 Jira 连接</Link>}</p>:null}
    {connection.data&&!connection.data.credentialsConfigured&&<p className="text-sm">来源凭据未就绪，请先在组织来源配置中保存轻舟账号。</p>}
    {!canManage&&<p className="text-sm text-muted-foreground">在线查询需要管理员读取来源。可切换“已纳管条目”查看已同步的交付记录。</p>}
    {busy==="read"&&<p role="status" className="text-sm">正在读取组织月度排期…</p>}
    {error&&<p role="alert" className="text-sm text-destructive">{error}</p>}
    {canManage&&connection.data?.credentialsConfigured&&<details className="space-y-3 rounded-lg border border-border p-3" aria-label="整月同步操作"><summary className="cursor-pointer text-sm font-medium">{actionBusy==="monthAll"?"正在同步本月条目…":"同步本月全部条目"}<span className="ml-2 text-xs font-normal text-muted-foreground">包含当前筛选外的条目</span></summary>
      <DeliveryMonthlyBulkSync key={`${month}:${connection.data.revision}`} month={month} scopeLabel={connection.data.subProductAttribution?`${connection.data.subProductAttribution} 排期与期望交付条目合并`:undefined} disabled={!!busy&&actionBusy!=="monthAll"} onBusyChange={value=>setBusy(value?"monthAll":"")} readMonth={async()=>{
      setSelected([]);setPreview(false);setReceipts([]);
      const fresh=await monthly.refetch();
      if(fresh.isError||!fresh.data)throw fresh.error??new Error("读取本月完整清单失败，请重试");
      return fresh.data.items.map(item=>item.demandNo);
    }} syncEntry={async demandNo=>{
      const response=await api.post<{snapshot:DeliverySnapshot;existing?:boolean}>(`${base}/sync`,{projectId,expectedRevision:connection.data!.revision,demandNo,months:[month]});
      recordSynced(demandNo,response.snapshot.id);
      // Refresh cached detail on next visit without extra reads for each synced entry.
      void qc.invalidateQueries({queryKey:["delivery-entry",companyId],refetchType:"none"});
      void qc.invalidateQueries({queryKey:["delivery-entries",companyId],refetchType:"none"});
      return {existing:response.existing};
    }}/>
    </details>}
    {result&&<>
      <div className="flex flex-wrap items-center justify-between gap-2"><p className="text-sm" role="status">显示 {items.length} / {result.items.length} 个条目<span className="ml-2 text-xs text-muted-foreground">{result.month} · 更新于 {new Date(result.collectedAt).toLocaleTimeString()}</span></p><div className="flex flex-wrap items-center gap-3"><label className="flex flex-wrap items-center gap-2 text-sm">排序<select aria-label="月度条目排序" className={field} value={params.get("mSort")??"risk"} disabled={!!actionBusy} onChange={e=>filter("mSort",e.target.value)}><option value="risk">风险优先</option><option value="deadline">计划结束时间</option><option value="start">计划开始时间</option></select></label><Button type="button" variant="outline" size="sm" disabled={!!busy||!selected.length} onClick={()=>{setPreview(true);setReceipts([]);}}>预览批量同步（{selected.length}）</Button></div></div>
      {preview&&<section className="space-y-3 rounded-md border border-border p-3" aria-label="批量同步预览"><h3 className="font-medium">将同步 {month} 的 {selected.length} 个条目</h3><p className="break-words text-sm">{selected.join("、")}</p><p className="text-sm text-muted-foreground">逐条读取轻舟及 Jira 并保存来源版本，成功项保留，失败项可单独点击“同步并查看”重试。不创建执行任务。</p><div className="flex items-center justify-between gap-3"><Button type="button" variant="ghost" disabled={!!busy} onClick={()=>setPreview(false)}>关闭预览</Button><Button type="button" disabled={!!busy||!!receipts.length} onClick={()=>void batch()}>{busy==="batch"?"正在逐条同步…":"开始只读同步"}</Button></div>{receipts.map(r=><p key={r.demandNo} className={r.ok?"text-sm":"text-sm text-destructive"}>{r.demandNo} · {r.ok?"成功":"失败"} · {r.message}</p>)}</section>}
      <p className="text-xs text-muted-foreground md:hidden">可横向滚动查看完整排期与操作。</p>
      <div className="overflow-x-auto" tabIndex={0} role="region" aria-label="月度排期表，可横向滚动"><table className="w-full min-w-4xl text-left text-sm"><caption className="sr-only">轻舟月度计划条目</caption><thead><tr className="border-b border-border"><th className="p-3"><span className="sr-only">选择条目</span></th>{["条目","来源负责人","计划时间／工单","管理关注与准入","下一步与操作"].map(label=><th key={label} className="p-3">{label}</th>)}</tr></thead><tbody>{items.slice((currentPage-1)*20,currentPage*20).map(i=><tr key={i.demandNo} className="border-b border-border"><td className="p-3"><input type="checkbox" aria-label={`选择 ${i.demandNo}`} checked={selected.includes(i.demandNo)} disabled={!!busy||(!selected.includes(i.demandNo)&&selected.length>=20)} onChange={e=>{setSelected(previous=>e.target.checked?[...previous,i.demandNo]:previous.filter(key=>key!==i.demandNo));setPreview(false);setReceipts([]);}} /></td><td className="p-3"><p className="font-medium">{i.demandNo}</p><p>{i.title||"来源未提供标题"}</p><p className="text-xs text-muted-foreground">{i.sourceStatus||"来源未提供状态"}</p><p className="text-xs text-muted-foreground">{[i.inSchedule!==false?"本组织已排期":"",i.inExpectedDeliveryMonth?"本月期望交付":""].filter(Boolean).join(" · ")}</p></td><td className="p-3"><p>{i.owner||"来源未提供"}</p><p className="text-xs text-muted-foreground">分析：{i.analysisOwner?.trim()||"来源未提供"}</p></td><td className="p-3"><p>{i.startDate||"待明确"} ～ {i.endDate||"待明确"}</p>{i.expectedDeliveryDate&&<p>期望交付：{i.expectedDeliveryDate.slice(0,7)}</p>}<p>{i.workCountKnown===false?"工单数量待同步核对":`${i.workCount} 个工单`}</p></td><td className="space-y-2 p-3"><div className="flex flex-wrap gap-1">{monthlyRiskViews.filter(([key])=>key!=="all"&&matchesMonthlyRisk(i,key)).map(([key,label])=><span key={key} className="rounded-md bg-muted px-2 py-1 text-xs">{label}</span>)}</div><p>{i.chainAdmission?DELIVERY_CHAIN_ADMISSION_LABELS[i.chainAdmission.state]:i.snapshotId?"待核验交付链条件":"待同步并核对"}</p><details className="text-xs text-muted-foreground"><summary className="cursor-pointer">查看准入依据</summary>{i.chainAdmission?.checks.map(check=><p key={check.key}>{check.passed?"已满足":"未满足"} · {check.label}</p>)}<p>{i.chainAdmission?.reasons.join("；")|| (i.snapshotId?"基于已纳管版本与开始节点配置；派发前仍复核席位与 Jira 条件":"同步后查看交付链开始节点的准入条件")}</p></details></td><td className="space-y-2 p-3"><p className="text-xs text-muted-foreground">{monthlyNextAction(i)}</p><div className="flex flex-wrap gap-2"><Button type="button" variant="outline" disabled={!!busy} onClick={()=>void sync(i.demandNo)}>{busy===i.demandNo?"正在同步…":"同步并查看"}</Button>{i.snapshotId&&<Button type="button" variant="ghost" asChild><Link to={monthlyDetailHref(params,projectId,i.snapshotId,month)}>查看已纳管交付</Link></Button>}</div></td></tr>)}</tbody></table></div>
      {items.length>20&&<div className="flex items-center justify-between"><Button type="button" variant="outline" disabled={currentPage===1||!!busy} onClick={()=>setPage(currentPage-1)}>上一页</Button><span className="text-sm">第 {currentPage} / {pageCount} 页 · {items.length} 个条目</span><Button type="button" variant="outline" disabled={currentPage*20>=items.length||!!busy} onClick={()=>setPage(currentPage+1)}>下一页</Button></div>}
      {!items.length&&<p>{result.items.length?"没有匹配的条目，请调整或清除筛选条件。":"该月份没有返回当前组织的计划条目，可切换月份，或在来源配置的“更多操作”中补录指定条目。"}</p>}
      <details className="text-xs text-muted-foreground"><summary className="cursor-pointer">范围与筛选说明</summary><p className="mt-2">{connection.data?.subProductAttribution?`合并 ${connection.data.subProductAttribution} 的本组织排期与本月期望交付条目，按编号去重；期望交付范围跨研发、测试组织。`:"按本组织的月度排期查询。"}进度来自轻舟状态，风险来自计划时间和负责人；均不代表正式交付或延期结论。进度计数不受风险筛选影响。期望交付条目的工单数量需同步后核对，准入反映已保存版本。</p></details>
    </>}
  </section>;
}
