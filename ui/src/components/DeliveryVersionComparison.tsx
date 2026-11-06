import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import type { DeliverySnapshot } from "@paperclipai/shared";
import { deliveryIntakeApi } from "@/api/delivery-intake";
import { Button } from "@/components/ui/button";

const fields: Record<string,string> = { sourceAnalysis:"轻舟分析与评审",title:"标题",status:"来源状态",demandId:"条目身份",scheduleCount:"排期步骤数",parentKey:"所属主单",type:"工单类型",assignee:"经办人",scheduled:"是否排期",membership:"成员范围",mainSourceId:"主单来源身份" };
const fieldLabel=(field:string)=>fields[field]??(field.startsWith("role:")?field.slice(5):field.startsWith("difference:")?"核对差异 · "+field.slice(11):field);
export function DeliveryVersionComparison({ companyId, snapshots, canManage=false }: { companyId:string; snapshots:DeliverySnapshot[];canManage?:boolean }) {
  const [before,setBefore]=useState(""); const [after,setAfter]=useState(""); const [pair,setPair]=useState<{before:string;after:string}|null>(null);
  const [note,setNote]=useState("");const [saving,setSaving]=useState(false);const [feedback,setFeedback]=useState("");const [saveError,setSaveError]=useState("");
  function clearNote(){setNote("");setFeedback("");setSaveError("");}
  async function saveNote(){if(!pair||!note.trim())return;setSaving(true);setFeedback("");setSaveError("");try{await deliveryIntakeApi.note(companyId,pair.after,pair.before,note.trim());setFeedback("核对说明已记录到审计日志；未批准交付、取消或派发任务。");setNote("");}catch(e){setSaveError(e instanceof Error?e.message:"记录失败，请重试");}finally{setSaving(false);}}
  const baseline=snapshots.find(s=>s.id===before);
  const candidates=snapshots.filter(s=>s.id!==before&&(!baseline||s.projectId===baseline.projectId&&s.sourceOrigin===baseline.sourceOrigin&&s.demandNo===baseline.demandNo));
  const result=useQuery({queryKey:["delivery-version-comparison",companyId,pair?.before,pair?.after],queryFn:()=>deliveryIntakeApi.compare(companyId,pair!.after,pair!.before),enabled:!!pair,retry:false});
  const option=(s:DeliverySnapshot)=>`${s.demandNo} · ${new Date(s.collectedAt).toLocaleString()} · ${s.plan.sourceMode==="online_readonly"?"在线":"手工"} · ${s.id.slice(0,8)}`;
  const value=(v:string|null,field:string)=>v===null?"不在此版本中":field==="scheduled"?(v==="true"?"已排期":"未排期"):v||"未提供";
  return <section className="space-y-3 rounded-lg border border-border p-4" aria-label="快照版本比较">
    <h2 className="font-semibold">快照版本比较</h2>
    <p className="text-sm text-muted-foreground">选择当前页的同一条目版本，按“基准 → 对比”查看变化。移出仅代表不在该快照中，不等于取消工单；比较不会修改来源、交付证据或执行授权。</p>
    <div className="grid gap-3 md:grid-cols-2">
      <label className="space-y-2 text-sm">基准版本<select aria-label="基准版本" disabled={saving} className="block w-full rounded-md border border-border bg-background p-2" value={before} onChange={e=>{setBefore(e.target.value);setAfter("");setPair(null);clearNote();}}><option value="">请选择基准版本</option>{snapshots.map(s=><option key={s.id} value={s.id}>{option(s)}</option>)}</select></label>
      <label className="space-y-2 text-sm">对比版本<select aria-label="对比版本" disabled={!before||saving} className="block w-full rounded-md border border-border bg-background p-2" value={after} onChange={e=>{setAfter(e.target.value);setPair(null);clearNote();}}><option value="">请选择同条目的另一版本</option>{candidates.map(s=><option key={s.id} value={s.id}>{option(s)}</option>)}</select></label>
    </div>
    <Button variant="outline" disabled={!before||!after||result.isFetching} onClick={()=>{if(pair?.before===before&&pair.after===after)void result.refetch();else setPair({before,after});}}>比较版本</Button>
    {result.isFetching&&<p role="status">正在比较版本…</p>}
    {pair&&result.isError&&<p role="alert" className="text-sm text-destructive">{result.error instanceof Error?result.error.message:"版本比较失败，请重试"}</p>}
    {pair&&result.data&&<div className="space-y-3"><p role="status">共 {result.data.changes.length} 项变化 · 基准 {new Date(result.data.baselineCollectedAt).toLocaleString()} → 对比 {new Date(result.data.collectedAt).toLocaleString()}</p>{result.data.sourceModeChanged&&<p className="text-sm text-muted-foreground">来源采集方式发生变化，手工版本不具有在线新鲜度。</p>}{!result.data.changes.length?<p className="text-sm">规范化快照内容未发生变化；不代表交付已验收。</p>:<div className="overflow-x-auto"><table className="w-full text-left text-sm"><caption className="sr-only">条目快照版本变化</caption><thead><tr className="border-b border-border">{["对象","变化项","基准值","对比值"].map(x=><th key={x} className="p-2">{x}</th>)}</tr></thead><tbody>{result.data.changes.map((c,i)=><tr key={i} className="border-b border-border"><td className="p-2 font-mono">{c.key}</td><td className="p-2">{fieldLabel(c.field)}</td><td className="p-2">{value(c.before,c.field)}</td><td className="p-2">{value(c.after,c.field)}</td></tr>)}</tbody></table></div>}</div>}
    {pair&&result.isSuccess&&canManage&&<div className="space-y-2"><label className="block space-y-2 text-sm">核对说明<textarea aria-label="核对说明" maxLength={2000} disabled={saving} className="block w-full rounded-md border border-border bg-background p-2" value={note} onChange={e=>setNote(e.target.value)}/></label><p className="text-sm text-muted-foreground">记录对此版本差异的说明和后续处理安排，最多 2000 字。仅保存审计记录，不代替正式审批或差异解决状态。</p><Button variant="outline" disabled={saving||!note.trim()} onClick={()=>void saveNote()}>{saving?"正在记录…":"记录核对说明"}</Button>{feedback&&<p role="status" className="text-sm">{feedback}</p>}{saveError&&<p role="alert" className="text-sm text-destructive">{saveError}</p>}</div>}
  </section>;
}
