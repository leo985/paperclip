import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { DeliveryPlan, DeliverySnapshotInput } from "@paperclipai/shared";
import { useCompany } from "@/context/CompanyContext";
import { useBreadcrumbs } from "@/context/BreadcrumbContext";
import { useManagementAccess } from "@/hooks/useManagementAccess";
import { projectsApi } from "@/api/projects";
import { deliveryIntakeApi } from "@/api/delivery-intake";
import { DeliveryWorkTree } from "@/components/DeliveryWorkTree";
import { DeliveryOnlineSource } from "@/components/DeliveryOnlineSource";
import { DeliveryVersionComparison } from "@/components/DeliveryVersionComparison";
import { Button } from "@/components/ui/button";
import { useSearchParams } from "react-router-dom";
import { Link, useNavigate } from "@/lib/router";

export function DeliverySourcePlan({plan}:{plan:DeliveryPlan}) {
  return <section className="space-y-4" aria-label="条目核对结果"><header><h2 className="text-lg font-semibold">{plan.demandNo} · {plan.title}</h2><p className="text-sm text-muted-foreground">来源状态：{plan.status} · {plan.sourceMode==="online_readonly"?"在线只读版本":"手工快照"} · 无自动执行授权</p></header>
    <div className="grid gap-3 md:grid-cols-3">{[["主工单",plan.mains.length],["子工单",plan.items.filter(i=>i.parentKey).length],["排期步骤（已去重）",plan.scheduleCount]].map(([label,value])=><div key={label} className="rounded-lg border border-border p-3"><span className="text-sm text-muted-foreground">{label}</span><p className="text-2xl font-semibold">{value}</p></div>)}</div>
    <div className="flex flex-wrap gap-4 text-sm">{plan.roles.map(r=><span key={r.label}>{r.label}：{r.name||"来源未提供"}</span>)}</div>
    <section className="space-y-2"><h3 className="font-semibold">待核对差异（{plan.differences.length}）</h3><p className="text-sm text-muted-foreground">差异仅供核对；不会修改轻舟、Jira 或自动推定工单替代关系。完成状态不等于交付证据核验通过。</p>{plan.differences.length? <ul className="list-disc space-y-2 pl-5 text-sm">{plan.differences.map(d=><li key={d.key+d.code}><strong>{d.key}</strong>：{d.message}</li>)}</ul>:<p className="text-sm">{plan.sourceMode==="online_readonly"?"本次在线读取未发现结构差异；正式交付证据仍需单独核验。":"所提供快照间未发现结构差异；尚未在线核验最新状态。"}</p>}</section>
    <DeliveryWorkTree key={plan.fingerprint} plan={plan} />
  </section>;
}
export function DeliverySources() {
  const navigate = useNavigate();
  const {selectedCompanyId}=useCompany();const {setBreadcrumbs}=useBreadcrumbs();const {canManage}=useManagementAccess();
  const canImport=canManage; const qc=useQueryClient();
  const [params,setParams] = useSearchParams();
  const projectId=params.get("projectId")??"";
  const demandNo=params.get("demandNo")??undefined;
  const setProjectId=(value:string)=>{ const next=new URLSearchParams(params);next.set("projectId",value);next.delete("demandNo");next.delete("snapshotId"); setParams(next); };
  const [page,setPage]=useState(1);const [bundle,setBundle]=useState<DeliverySnapshotInput|null>(null);const [plan,setPlan]=useState<DeliveryPlan|null>(null);const [error,setError]=useState("");const [message,setMessage]=useState("");const [busy,setBusy]=useState(false);const [reading,setReading]=useState(false);const [showImport,setShowImport]=useState(false);
  const projects=useQuery({queryKey:["delivery-projects",selectedCompanyId],queryFn:()=>projectsApi.list(selectedCompanyId!),enabled:!!selectedCompanyId});
  const list=(projects.data??[]).filter(p=>!p.archivedAt);const selected=list.find(p=>p.id===projectId)??(list.length===1?list[0]:undefined);
  const history=useQuery({queryKey:["delivery-snapshots",selectedCompanyId,selected?.id,demandNo,page],queryFn:()=>deliveryIntakeApi.list(selectedCompanyId!,selected!.id,page,demandNo),enabled:!!selectedCompanyId&&!!selected});
  useEffect(()=>{setBreadcrumbs([{label:"需求条目",href:"/delivery"},{label:"来源与历史"}]);},[setBreadcrumbs]);
  useEffect(()=>{setPage(1);setBundle(null);setPlan(null);setError("");setMessage("");},[selectedCompanyId]);
  function reset(){setPlan(null);setError("");setMessage("");}
  async function readFile(file:File|undefined){reset();setBundle(null);if(!file)return;setReading(true);try{if(file.size>1500000)throw Error("快照文件不能超过 1.5 MB");const value=JSON.parse(await file.text());if(value.format!=="zhiyan-delivery-snapshot-v1"||typeof value.demandJson!=="string"||typeof value.analysisJson!=="string"||typeof value.jiraJson!=="string"||!Array.isArray(value.scheduleJsons))throw Error("格式不正确，请使用帮助中的快照封装格式，原始响应应保存为字符串");setBundle({projectId:"",sourceOrigin:value.sourceOrigin,demandNo:value.demandNo,collectedAt:value.collectedAt,demandJson:value.demandJson,analysisJson:value.analysisJson,...(value.detailJson === undefined ? {} : {detailJson:value.detailJson}),scheduleJsons:value.scheduleJsons,jiraJson:value.jiraJson});}catch(e){setError(e instanceof Error?e.message:"读取失败");}finally{setReading(false);}}
  async function act(save:boolean){if(!selectedCompanyId||!selected||!bundle)return;setBusy(true);setError("");setMessage("");try{const input={...bundle,projectId:selected.id};if(save&&plan){const r=await deliveryIntakeApi.save(selectedCompanyId,input,plan.fingerprint);setMessage(r.existing?"此版本已纳管，未重复保存。":"已保存只读快照；未创建执行任务。");setPage(1);await qc.invalidateQueries({queryKey:["delivery-snapshots",selectedCompanyId]});}else setPlan(await deliveryIntakeApi.preview(selectedCompanyId,input));}catch(e){setError(e instanceof Error?e.message:"操作失败，请重试");}finally{setBusy(false);}}
  return <div className="space-y-5"><header className="space-y-2"><Link className="text-sm underline" to={"/delivery?"+new URLSearchParams({...(projectId?{projectId}:{}),...(params.get("snapshotId")?{snapshotId:params.get("snapshotId")!}:{})})}>返回需求条目</Link><h1 className="text-2xl font-semibold">来源与历史</h1><p className="text-sm text-muted-foreground">配置组织来源后，按月份浏览组织条目。单条补录和历史版本核对用于补充来源，不授予执行权限。</p></header>
    {projects.isPending?<p>正在加载项目…</p>:projects.isError?<p role="alert">项目加载失败，请刷新重试。</p>:!list.length?<p>请先在项目管理中配置项目。</p>:<label className="block space-y-2 text-sm">所属项目<select aria-label="所属项目" className="block w-full rounded-md border border-border bg-background p-2" value={selected?.id??""} disabled={busy||reading} onChange={e=>{setProjectId(e.target.value);setPage(1);setBundle(null);reset();}}><option value="">请选择项目</option>{list.map(p=><option key={p.id} value={p.id}>{p.name}</option>)}</select></label>}
    {selected&&<>{canImport&&selectedCompanyId&&<DeliveryOnlineSource key={selectedCompanyId+selected.id} companyId={selectedCompanyId} projectId={selected.id} initialDemandNo={demandNo} onSaved={()=>navigate("/delivery?"+new URLSearchParams({projectId:selected.id,...(params.get("month")?{month:params.get("month")!}:{})}))} onPlan={p=>{setPlan(p);setBundle(null);}}/>}<section className="space-y-3 rounded-lg border border-border p-4"><div className="flex items-center justify-between"><h2 className="font-semibold">已纳管快照</h2>{canImport&&<Button variant="outline" onClick={()=>setShowImport(!showImport)}>{showImport?"收起导入":"导入条目快照"}</Button>}</div><p className="text-sm text-muted-foreground">手工快照采集时间为上传人声明；在线版本反映读取时状态。只读版本不能用于自动派单。相同来源内容重复导入会复用已有版本。</p>
    {history.isPending?<p>正在加载…</p>:history.isError?<p role="alert" className="text-destructive">快照加载失败。<Button variant="outline" onClick={()=>history.refetch()}>重试</Button></p>:!history.data?.items.length?<p>此项目尚未纳管条目，请由管理员在线同步或导入完整快照。</p>:<div className="space-y-2">{history.data.items.map(s=><button key={s.id} className="block w-full rounded-md border border-border p-3 text-left hover:bg-accent" onClick={()=>{setPlan(s.plan);setBundle(null);setMessage("正在查看已保存版本；采集时间："+new Date(s.collectedAt).toLocaleString());setError("");}}><strong>{s.demandNo} · {s.plan.title}</strong><p className="text-sm text-muted-foreground">{s.plan.sourceMode==="online_readonly"?"在线读取":"手工采集"}：{new Date(s.collectedAt).toLocaleString()} · 主单 {s.plan.mains.length} / 子单 {s.plan.items.filter(i=>i.parentKey).length} · 差异 {s.plan.differences.length}</p></button>)}</div>}
    <div className="flex items-center justify-between"><Button variant="outline" disabled={page===1||history.isFetching} onClick={()=>setPage(page-1)}>上一页</Button><span className="text-sm">第 {page} 页</span><Button variant="outline" disabled={!history.data?.hasMore||history.isFetching} onClick={()=>setPage(page+1)}>下一页</Button></div></section>
    {selectedCompanyId&&history.data&&<DeliveryVersionComparison key={selectedCompanyId+selected.id+page} companyId={selectedCompanyId} snapshots={history.data.items} canManage={canImport}/>}
    {canImport&&showImport&&<section className="space-y-3 rounded-lg border border-border p-4"><h2 className="font-semibold">导入完整来源快照</h2><p className="text-sm text-muted-foreground">包含轻舟条目、分析主单清单、排期树及完整 Jira 工单响应。文件不会作为脚本执行。</p><label className="block text-sm">选择快照 JSON 文件<input type="file" accept=".json,application/json" disabled={busy||reading} onChange={e=>void readFile(e.target.files?.[0])} className="block w-full py-2"/></label>{bundle&&<p className="text-sm">待核对：{bundle.demandNo} · {bundle.collectedAt}</p>}<div className="flex items-center justify-between"><Button variant="outline" disabled={busy||reading} onClick={()=>{setShowImport(false);setBundle(null);reset();}}>取消</Button><div className="flex gap-2"><Button variant="outline" disabled={!bundle||busy||reading} onClick={()=>void act(false)}>预览并核对</Button><Button disabled={!bundle||!plan||busy||reading} onClick={()=>void act(true)}>{busy?"处理中…":"保存只读纳管"}</Button></div></div></section>}
    {error&&<p role="alert" className="text-destructive">{error}</p>}{message&&<p role="status" className="text-sm">{message}</p>}{plan&&<DeliverySourcePlan plan={plan}/>}</>}
  </div>;
}
