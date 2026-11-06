import { DELIVERY_CHAIN_ADMISSION_LABELS } from "@paperclipai/shared";
import { SourceStatusMultiSelect } from "./SourceStatusMultiSelect";
import { useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { DeliveryConnection, DeliveryMonthlyEntries, DeliverySnapshot } from "@paperclipai/shared";
import { api } from "@/api/client";
import { DeliveryMonthlyBulkSync } from "@/components/DeliveryMonthlyBulkSync";
import { SearchableSelect } from "@/components/SearchableSelect";
import { filterMonthlyEntries, monthlyFilterKeys, monthlySourceOptions, monthlySelectedStatuses, monthlyDetailHref, matchesMonthlyRisk, monthlyRiskViews, monthlyNextAction, monthlyProgressViews, monthlyProgress } from "@/lib/delivery-monthly-filters";
import { Button } from "@/components/ui/button";
import { Link, useNavigate, useSearchParams } from "@/lib/router";

export function DeliveryMonthlyBoard({ companyId, projectId, canManage }: { companyId:string; projectId:string; canManage:boolean }) {
  const navigate=useNavigate(), qc=useQueryClient();
  const [params,setParams]=useSearchParams();
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
    setParams(previous=>{const next=new URLSearchParams(previous);if(value)next.set(key,value);else next.delete(key);return next;},{replace:true});
  }
  function clearFilters() {
    setParams(previous=>{const next=new URLSearchParams(previous);monthlyFilterKeys.forEach(key=>next.delete(key));return next;},{replace:true});
  }
  const connection=useQuery({queryKey:["delivery-connection",companyId,projectId],queryFn:()=>api.get<DeliveryConnection|null>(`${base}?projectId=${projectId}`)});
  const sourceHref="/delivery?"+new URLSearchParams({projectId,view:"sources",month});
  const monthlyKey=["delivery-monthly",companyId,projectId,connection.data?.revision,month];
  const monthly=useQuery({queryKey:monthlyKey,queryFn:()=>api.post<DeliveryMonthlyEntries>(`${base}/monthly`,{projectId,expectedRevision:connection.data!.revision,month}),enabled:canManage&&!!connection.data?.credentialsConfigured&&/^\d{4}-(0[1-9]|1[0-2])$/.test(month),retry:false,staleTime:60_000,refetchOnWindowFocus:false});
  const result=monthly.data;
  const busy=actionBusy||(monthly.isFetching?"read":"");
  const error=actionError||(monthly.isError?monthly.error.message:"");
  useEffect(()=>{setSelected([]);setPreview(false);setReceipts([]);setPage(1);setError("");},[month,connection.data?.revision]);
  async function read() { setError("");setSelected([]);setPreview(false);setReceipts([]);setPage(1);await monthly.refetch(); }
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
  return <section className="space-y-4" aria-label="月度排期条目">
    <p className="text-sm text-muted-foreground">自动展示当前组织的月度排期，切换月份即可浏览；月份以轻舟排期为准，不按条目创建日期。同步条目后可安排分析、设计或编码。已排期不代表具备开发条件；不会自动派单。</p>
    {connection.isError?<p role="alert">来源配置加载失败。<Button variant="outline" onClick={()=>void connection.refetch()}>重试</Button></p>:!connection.isPending&&!connection.data?<p>尚未配置项目来源。{canManage&&<Link className="underline" to={sourceHref}>配置轻舟与 Jira 连接</Link>}</p>:null}
    <form className="flex flex-wrap items-end gap-3" onSubmit={e=>{e.preventDefault();void read();}}>
      <label className="space-y-2 text-sm"><span className="block">排期月份</span><input type="month" required aria-label="排期月份" value={month} disabled={!!busy} onChange={e=>{setMonth(e.target.value);setError("");setSelected([]);setPreview(false);setParams(previous=>{const next=new URLSearchParams(previous);next.set("month",e.target.value);return next;});}} className="rounded-md border border-border bg-background p-2" /></label>
      <Button type="submit" disabled={!!busy||!connection.data?.credentialsConfigured||!month||!canManage}>{busy==="read"?"正在读取…":monthly.isError?"重试读取":"刷新条目"}</Button>
      {canManage&&<Link className="text-sm underline" to={sourceHref}>组织来源配置</Link>}
    </form>
    {connection.data&&!connection.data.credentialsConfigured&&<p className="text-sm">来源凭据未就绪，请先在组织来源配置中保存轻舟账号。</p>}
    {!canManage&&<p className="text-sm text-muted-foreground">在线查询需要管理员读取来源。可切换“已纳管条目”查看已同步的交付记录。</p>}
    {busy==="read"&&<p role="status" className="text-sm">正在读取组织月度排期…</p>}
    {error&&<p role="alert" className="text-sm text-destructive">{error}</p>}
    {canManage&&connection.data?.credentialsConfigured&&<DeliveryMonthlyBulkSync key={`${month}:${connection.data.revision}`} month={month} disabled={!!busy&&actionBusy!=="monthAll"} onBusyChange={value=>setBusy(value?"monthAll":"")} readMonth={async()=>{
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
    }}/>}
    {result&&<>
      <div className="flex flex-wrap items-center justify-between gap-3"><p className="text-sm" role="status">{result.month} · 显示 {items.length} / {result.items.length} 个条目 · 读取于 {new Date(result.collectedAt).toLocaleString()}</p></div>
      <section className="space-y-2" aria-label="条目进度筛选">
        <h3 className="text-sm font-medium">条目进度</h3>
        <div className="flex flex-wrap gap-3" role="group" aria-label="月度条目进度">{monthlyProgressViews.map(([key,label])=><Button key={key} variant={(params.get("mProgress")??"all")===key?"default":"outline"} disabled={!!actionBusy} aria-pressed={(params.get("mProgress")??"all")===key} onClick={()=>filter("mProgress",key==="all"?"":key)}>{label} <span className="tabular-nums">{key==="all"?progressRows.length:progressRows.filter(item=>monthlyProgress(item)===key).length}</span></Button>)}</div>
        <p className="text-xs text-muted-foreground">按轻舟条目状态归类，不代表平台交付核验通过。分析、评审及研发后续环节归为进行中；作废、关闭或未识别状态归为待确认。进度数量不受下方风险筛选影响，其余筛选条件仍生效。</p>
      </section>
      <div className="flex flex-wrap gap-2" role="group" aria-label="月度交付风险"><span className="sr-only">数量沿用其他筛选条件</span>{monthlyRiskViews.map(([key,label]) => <Button key={key} variant={(params.get("mRisk")??"all")===key?"secondary":"outline"} size="sm" disabled={!!actionBusy} aria-pressed={(params.get("mRisk")??"all")===key} onClick={()=>filter("mRisk",key==="all"?"":key)}>{label} <span className="tabular-nums">{key==="all"?riskRows.length:riskRows.filter(item=>matchesMonthlyRisk(item,key)).length}</span></Button>)}</div>
      <p className="text-xs text-muted-foreground">按上海时区识别本周到期和计划时间已过；这些信号不认定正式延期或验收结果。正常条目表示未命中上述风险信号，不代表正式验收通过。风险数量沿用其他筛选，同一条目可有多个信号。责任人缺失需在来源补齐后同步。</p>
      <section className="space-y-3 rounded-lg border border-border p-4" aria-label="月度条目筛选">
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          <label className="space-y-2 text-sm"><span className="block">关键词</span><input disabled={!!actionBusy} aria-label="月度条目搜索" value={search} onCompositionStart={()=>{searchComposing.current=true;}} onCompositionEnd={e=>{searchComposing.current=false;setSearch(e.currentTarget.value);filter("mq",e.currentTarget.value);}} onChange={e=>{setSearch(e.currentTarget.value);if(!searchComposing.current)filter("mq",e.currentTarget.value);}} placeholder="编号、标题或负责人" maxLength={200} className={field+" w-full"}/></label>
          <div className="space-y-2 text-sm" role="group" aria-label="来源负责人筛选"><span className="block">来源负责人</span><SearchableSelect disabled={!!actionBusy} value={params.get("mOwner")??""} groups={[{id:"owners",options:[{key:"all",value:"",label:"全部负责人"},...monthlySourceOptions(result.items,"owner")]}]} onValueChange={value=>filter("mOwner",value)} placeholder="全部负责人" searchPlaceholder="搜索负责人" emptyMessage="没有匹配的负责人" loadingMessage="正在加载负责人…" renderValue={option=>option?.label??"所选负责人（本月未返回）"} triggerClassName="w-full"/></div>
          <div className="space-y-2 text-sm"><span className="block">来源状态</span><SourceStatusMultiSelect label="月度来源状态" disabled={!!actionBusy} options={monthlySourceOptions(result.items,"sourceStatus")} values={monthlySelectedStatuses(params)} onChange={values=>setParams(previous=>{const next=new URLSearchParams(previous);next.delete("mStatus");values.forEach(value=>next.append("mStatus",value));return next;},{replace:true})}/></div>
          <label className="space-y-2 text-sm"><span className="block">同步情况</span><select disabled={!!actionBusy} aria-label="月度同步情况" value={params.get("mSync")??""} onChange={e=>filter("mSync",e.target.value)} className={field+" w-full"}><option value="">全部同步情况</option><option value="unsynced">尚未同步</option><option value="saved">已纳管</option></select></label>
          <label className="space-y-2 text-sm"><span className="block">交付链准入</span><select disabled={!!actionBusy} aria-label="月度交付链准入" value={params.get("mAdmission")??""} onChange={e=>filter("mAdmission",e.target.value)} className={field+" w-full"}><option value="">全部准入情况</option><option value="unconfigured">未配置准入规则</option><option value="verified">可进入或已进入交付链</option><option value="unchecked">已纳管，开始节点条件待核验</option><option value="unsynced">待同步并核对</option></select></label>
          <label className="space-y-2 text-sm"><span className="block">工单情况</span><select disabled={!!actionBusy} aria-label="月度工单情况" value={params.get("mWork")??""} onChange={e=>filter("mWork",e.target.value)} className={field+" w-full"}><option value="">全部工单情况</option><option value="has">已有工单</option><option value="none">暂无工单</option></select></label>
        </div>
        <label className="flex flex-wrap items-center gap-2 text-sm">排序<select aria-label="月度条目排序" className={field} value={params.get("mSort")??"risk"} disabled={!!actionBusy} onChange={e=>filter("mSort",e.target.value)}><option value="risk">风险优先</option><option value="deadline">计划结束时间</option><option value="start">计划开始时间</option></select></label>
        <div className="flex flex-wrap items-center justify-between gap-3"><p className="text-xs text-muted-foreground">{activeFilters?`已启用 ${activeFilters} 项筛选；同类状态任选其一，其他条件同时满足。`:"筛选当前项目的整月排期；可组合使用。"} 修改筛选会清空批量选择。</p><Button type="button" variant="ghost" disabled={!activeFilters||!!actionBusy} onClick={clearFilters}>清除筛选</Button></div>
      </section>
      <div className="flex flex-wrap items-center gap-3"><Button type="button" variant="outline" disabled={!!busy||!selected.length} onClick={()=>{setPreview(true);setReceipts([]);}}>预览批量同步（{selected.length}）</Button><span className="text-xs text-muted-foreground">手动勾选最多 20 个条目；整月同步请使用上方一键同步。只同步来源，不派单。</span></div>
      {preview&&<section className="space-y-3 rounded-md border border-border p-3" aria-label="批量同步预览"><h3 className="font-medium">将同步 {month} 的 {selected.length} 个条目</h3><p className="break-words text-sm">{selected.join("、")}</p><p className="text-sm text-muted-foreground">逐条读取轻舟及 Jira 并保存来源版本，成功项保留，失败项可单独点击“同步并查看”重试。不创建执行任务。</p><div className="flex items-center justify-between gap-3"><Button type="button" variant="ghost" disabled={!!busy} onClick={()=>setPreview(false)}>关闭预览</Button><Button type="button" disabled={!!busy||!!receipts.length} onClick={()=>void batch()}>{busy==="batch"?"正在逐条同步…":"开始只读同步"}</Button></div>{receipts.map(r=><p key={r.demandNo} className={r.ok?"text-sm":"text-sm text-destructive"}>{r.demandNo} · {r.ok?"成功":"失败"} · {r.message}</p>)}</section>}
      <p className="text-xs text-muted-foreground md:hidden">可横向滚动查看完整排期与操作。</p>
      <div className="overflow-x-auto" tabIndex={0} role="region" aria-label="月度排期表，可横向滚动"><table className="w-full min-w-4xl text-left text-sm"><caption className="sr-only">轻舟月度计划条目</caption><thead><tr className="border-b border-border"><th className="p-3"><span className="sr-only">选择条目</span></th>{["条目","来源负责人","计划时间／工单","管理关注与准入","下一步与操作"].map(label=><th key={label} className="p-3">{label}</th>)}</tr></thead><tbody>{items.slice((currentPage-1)*20,currentPage*20).map(i=><tr key={i.demandNo} className="border-b border-border"><td className="p-3"><input type="checkbox" aria-label={`选择 ${i.demandNo}`} checked={selected.includes(i.demandNo)} disabled={!!busy||(!selected.includes(i.demandNo)&&selected.length>=20)} onChange={e=>{setSelected(previous=>e.target.checked?[...previous,i.demandNo]:previous.filter(key=>key!==i.demandNo));setPreview(false);setReceipts([]);}} /></td><td className="p-3"><p className="font-medium">{i.demandNo}</p><p>{i.title||"来源未提供标题"}</p><p className="text-xs text-muted-foreground">{i.sourceStatus||"已纳入月度计划"}</p></td><td className="p-3">{i.owner||"来源未提供"}</td><td className="p-3"><p>{i.startDate||"待明确"} ～ {i.endDate||"待明确"}</p><p>{i.workCount} 个工单</p></td><td className="space-y-2 p-3"><div className="flex flex-wrap gap-1">{monthlyRiskViews.filter(([key])=>key!=="all"&&matchesMonthlyRisk(i,key)).map(([key,label])=><span key={key} className="rounded-md bg-muted px-2 py-1 text-xs">{label}</span>)}</div><p>{i.chainAdmission?DELIVERY_CHAIN_ADMISSION_LABELS[i.chainAdmission.state]:i.snapshotId?"待核验交付链条件":"待同步并核对"}</p><details className="text-xs text-muted-foreground"><summary className="cursor-pointer">查看准入依据</summary>{i.chainAdmission?.checks.map(check=><p key={check.key}>{check.passed?"已满足":"未满足"} · {check.label}</p>)}<p>{i.chainAdmission?.reasons.join("；")|| (i.snapshotId?"基于已纳管版本与开始节点配置；派发前仍复核席位与 Jira 条件":"同步后查看交付链开始节点的准入条件")}</p></details></td><td className="space-y-2 p-3"><p className="text-xs text-muted-foreground">{monthlyNextAction(i)}</p><div className="flex flex-wrap gap-2"><Button type="button" variant="outline" disabled={!!busy} onClick={()=>void sync(i.demandNo)}>{busy===i.demandNo?"正在同步…":"同步并查看"}</Button>{i.snapshotId&&<Button type="button" variant="ghost" asChild><Link to={monthlyDetailHref(params,projectId,i.snapshotId,month)}>查看已纳管交付</Link></Button>}</div></td></tr>)}</tbody></table></div>
      {items.length>20&&<div className="flex items-center justify-between"><Button type="button" variant="outline" disabled={currentPage===1||!!busy} onClick={()=>setPage(currentPage-1)}>上一页</Button><span className="text-sm">第 {currentPage} / {pageCount} 页 · {items.length} 个条目</span><Button type="button" variant="outline" disabled={currentPage*20>=items.length||!!busy} onClick={()=>setPage(currentPage+1)}>下一页</Button></div>}
      {!items.length&&<p>{result.items.length?"没有匹配的条目，请调整或清除筛选条件。":"该月份没有返回当前组织的计划条目，可切换月份，或在来源配置的“更多操作”中补录指定条目。"}</p>}
      <p className="text-xs text-muted-foreground">默认风险优先，可切换计划结束或开始时间排序，未提供时间的条目置后。月度列表只包含组织排期条目，不包含完整未排期需求。计划时间来自本月返回的排期树，可能只覆盖本月；跨月条目可在“来源与历史”补充月份核对。列表准入反映已保存版本，不根据来源状态文字推断分析或评审通过。</p>
    </>}
  </section>;
}
