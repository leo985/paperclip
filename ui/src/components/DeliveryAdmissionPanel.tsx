import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import type { DeliveryAdmission, DeliverySnapshot } from "@paperclipai/shared";
import { api } from "@/api/client";
import { Link } from "@/lib/router";
import { Button } from "@/components/ui/button";
import { sourceCodingCompleted } from "@/lib/delivery-entry-stages";

export function DeliveryAdmissionPanel({companyId,snapshot,admission,canManage,compact=false,overviewHref}:{companyId:string;snapshot:DeliverySnapshot;admission?:DeliveryAdmission;canManage:boolean;compact?:boolean;overviewHref?:string}) {
  const qc=useQueryClient();const [analysisReference,setAnalysis]=useState(""),[designReference,setDesign]=useState(""),[designRequired,setRequired]=useState(true),[note,setNote]=useState(""),[busy,setBusy]=useState(false),[error,setError]=useState("");
  const params={projectId:snapshot.projectId,demandNo:snapshot.demandNo,snapshotId:snapshot.id};
  const href=(path:string,extra:Record<string,string>={})=>path+"?"+new URLSearchParams({...params,...extra});
  const historicalCoding=sourceCodingCompleted(snapshot.plan);
  const status=admission?.ready?"已登记核验":historicalCoding?"未登记（历史编码已完成）":"待核验";
  if(compact) return <section className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border p-4" aria-label="编码阶段准入摘要"><p className="text-sm">编码阶段准入：{status}</p><Link className="text-sm underline" to={overviewHref??href("/delivery",{tab:"overview"})+"#delivery-admission"}>到条目总览查看核验</Link></section>;
  async function save() {
    setBusy(true);setError("");
    try { await api.post(`/companies/${companyId}/delivery-intake/entries/${snapshot.id}/admission`,{fingerprint:snapshot.plan.fingerprint,analysisReference,designRequired,designReference:designRequired?designReference:"",note});await qc.invalidateQueries({queryKey:["delivery-entry",companyId,snapshot.id]});await qc.invalidateQueries({queryKey:["delivery-monthly",companyId,snapshot.projectId]}); }
    catch(e){setError(e instanceof Error?e.message:"保存核验失败");}finally{setBusy(false);}
  }
  const field="block w-full rounded-md border border-border bg-background p-2";
  return <section id="delivery-admission" className="space-y-3 rounded-lg border border-border p-4" aria-label="编码阶段准入核验"><h2 className="font-semibold">编码阶段准入 · {status}</h2>
    <p className="text-sm text-muted-foreground">用于启动新的编码任务前核对有效分析结论和必要设计评审，同一来源版本统一登记，不按阶段重复填写。可引用轻舟／Jira 的正式结论，核验登记不代替正式审批。</p>
    {historicalCoding&&<p className="text-sm">来源编码工单已完成，可直接查看已有工单、代码评审及交付记录，无需为历史工单重新执行需求分析。后续新增编码任务仍需核验准入条件。</p>}
    {(!historicalCoding||admission?.ready)&&admission?.reasons.map(reason=><p className="text-sm" key={reason}>{reason}</p>)}
    {admission?.evidence&&<div className="space-y-2 text-sm"><p>核验人：{admission.evidence.checkedBy} · {new Date(admission.evidence.checkedAt).toLocaleString()}</p><p><a href={admission.evidence.analysisReference} target="_blank" rel="noreferrer" className="underline">查看正式分析通过结论</a></p>{admission.evidence.designRequired?<p><a href={admission.evidence.designReference} target="_blank" rel="noreferrer" className="underline">查看正式设计评审通过结论</a></p>:<p>无需设计评审，理由见核验说明。</p>}<p className="whitespace-pre-wrap">{admission.evidence.note}</p></div>}
    <div className="flex flex-wrap gap-3"><Button type="button" variant="outline" asChild><Link to={href("/analysis-executions")}>查看需求分析与结论</Link></Button><Button type="button" variant="outline" asChild><Link to={historicalCoding?href("/delivery",{tab:"work"}):href("/jira-intake")}>{historicalCoding?"查看已有工单与交付":admission?.ready?"选择工单与席位，派单执行":"安排设计／查看工单（编码待准入）"}</Link></Button></div>
    {canManage&&<details className="text-sm"><summary className="cursor-pointer font-medium">{admission?.evidence?"更新正式结论核验":"登记已有正式分析／设计结论"}</summary><form className="mt-3 space-y-3" onSubmit={e=>{e.preventDefault();void save();}}><fieldset disabled={busy} className="space-y-3"><legend className="sr-only">正式结论核验登记</legend>
      <label className="block space-y-2">正式分析通过结论链接<input type="url" required className={field} value={analysisReference} onChange={e=>setAnalysis(e.target.value)} placeholder="轻舟或 Jira 中可核验的分析版本与通过结论" /></label>
      <label className="flex items-center gap-2"><input type="checkbox" checked={designRequired} onChange={e=>setRequired(e.target.checked)} />需要设计评审</label>
      {designRequired&&<label className="block space-y-2">正式设计评审通过结论链接<input type="url" required className={field} value={designReference} onChange={e=>setDesign(e.target.value)} /></label>}
      <label className="block space-y-2">核验说明{!designRequired&&"（须说明无需设计评审的理由）"}<textarea required maxLength={2000} rows={3} className={field} value={note} onChange={e=>setNote(e.target.value)} placeholder="说明已核对的产物版本、通过结论与适用范围" /></label>
      <p className="text-xs text-muted-foreground">由管理员核对正式流程后登记引用，系统不会仅凭链接自动认定审批通过。绑定当前来源版本及分析修订，版本变化后需重新核验。</p><div className="flex justify-end"><Button type="submit">{busy?"正在保存…":"记录已核验结论"}</Button></div>
    </fieldset></form></details>}{error&&<p role="alert" className="text-sm text-destructive">{error}</p>}
  </section>;
}
