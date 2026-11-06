import { useState } from "react";
import type { DeliveryEntryDetail, DeliveryWorkflow } from "@paperclipai/shared";
import { Link } from "@/lib/router";
import { deliveryEntryStageRows, sourceAnalysisRoleName, sourceEntryStage, type EntryStageId } from "@/lib/delivery-entry-stages";
import { deliveryRunStates, deliveryTaskStates } from "@/lib/delivery-work-dispatch";
import { Button } from "./ui/button";
import { StatusBadge } from "./StatusBadge";
const analysisStates: Record<string,string> = {draft:"未派发",queued:"排队中",running:"分析执行中",waiting:"等待人工决定",interrupted:"中断待处理",local_completed:"本地完成，待正式发布",published:"已登记正式发布"};
const flowStates: Record<string,string> = {pending:"等待前置交付",queued:"等待席位领取",running:"执行中",waiting:"等待人工决定",review:"交付待核验",done:"交付已核验",interrupted:"中断待处理"};
export function DeliveryEntryStages({ detail, workflow, canManage, selectedStage, onSelectStage }: {detail: DeliveryEntryDetail; workflow?: DeliveryWorkflow; canManage: boolean; selectedStage?: EntryStageId; onSelectStage?: (stage: EntryStageId) => void}) {
  const [local, setLocal] = useState<EntryStageId>("analysis");
  const stages = deliveryEntryStageRows(detail, workflow);
  const aiDeliveryRunning = stages.some(stage => stage.running > 0);
  const current = stages.find(stage => stage.id === (selectedStage ?? local)) ?? stages[0]!;
  const { snapshot } = detail;
  const analysisUrl = "/analysis-executions?" + new URLSearchParams({projectId:snapshot.projectId, demandNo:snapshot.demandNo, snapshotId:snapshot.id});
  const others = snapshot.plan.items.filter(item => item.parentKey && !sourceEntryStage(item.type));
  return <section className="min-w-0 space-y-4" aria-label="条目阶段交付总览">
    <header className="space-y-1"><div className="flex flex-wrap items-center gap-2"><h2 className="font-semibold">条目交付阶段</h2>{aiDeliveryRunning&&<StatusBadge status="running" label="AI交付链运行中"/>}</div><p className="text-sm text-muted-foreground">阶段完成以 Jira 来源工单状态为准；需求分析无子工单时展示轻舟分析与评审记录。</p></header>
    <div className="grid grid-cols-2 gap-3 lg:grid-cols-4" role="group" aria-label="选择条目交付阶段">{stages.map((stage,index) => <button type="button" key={stage.id} aria-pressed={current.id===stage.id} onClick={()=>{setLocal(stage.id);onSelectStage?.(stage.id);}} className={`min-w-0 space-y-2 rounded-lg border p-4 text-left focus-visible:outline focus-visible:outline-primary ${current.id===stage.id?"border-primary bg-accent":"border-border hover:bg-accent"}`}>
      <p className="font-semibold">{index+1}. {stage.label}</p><StatusBadge status={stage.statusTone} label={stage.sourceStatus?stage.statusLabel:`平台：${stage.statusLabel}`}/>
      {stage.hasPlatformRecords&&<p className="text-xs text-muted-foreground">{stage.id==="analysis"?"平台分析":"平台交付"}：{stage.executionLabel}</p>}
      <p className="text-xs text-muted-foreground">{stage.id==="analysis"&&!stage.rows.length?"条目级分析与评审":`${stage.rows.length} 张工单`}{stage.sourceCount?` · 来源已完成 ${stage.sourceCompleted}/${stage.sourceCount}`:""}{stage.analyses.length?` · ${stage.analyses.length} 个分析修订`:""}</p>
      {stage.hasPlatformRecords?<p className="text-xs">平台记录：核验交付 {stage.verified} · 执行 {stage.running} · 待处理 {stage.attention}</p>:<p className="text-xs text-muted-foreground">完成依据：{stage.sourceCount?"Jira 工单状态":stage.id==="analysis"?"轻舟分析与评审记录":"暂无来源工单"}</p>}
    </button>)}</div>
    <section className="space-y-4 rounded-lg border border-border p-4" aria-label="所选条目阶段">
      <header className="flex flex-wrap items-center justify-between gap-3"><div><h3 className="font-semibold">{current.label} · 关联工单与任务</h3><p className="text-xs text-muted-foreground">{current.description}</p></div>{current.id==="analysis"&&<Button variant="outline" asChild><Link to={analysisUrl}>{canManage?"创建或查看分析任务":"查看分析任务"}</Link></Button>}</header>
      {current.id==="analysis"&&<div className="space-y-2 rounded-md bg-muted p-3" aria-label="轻舟需求分析与评审">
        <p className="text-sm font-medium">轻舟分析与评审 · {current.statusLabel}</p>
        <p className="text-sm">来源条目状态：{snapshot.plan.sourceAnalysis?.sourceStatus||snapshot.plan.status||"未提供"}</p>
        <p className="text-sm">分析内容：{snapshot.plan.sourceAnalysis?.analysisSaved===true?"已保存":snapshot.plan.sourceAnalysis?.analysisSaved===false?"来源返回内容为空":"未采集有效内容"}</p>
        {snapshot.plan.sourceAnalysis?.reviewStages.map((stage,index)=><p key={index} className="text-sm">评审环节：{stage.role||"未提供角色"}{sourceAnalysisRoleName(snapshot.plan,stage.role)?`（${sourceAnalysisRoleName(snapshot.plan,stage.role)}）`:"（未提供负责人）"} · {stage.status||"未提供状态"}</p>)}
        <p className="text-xs text-muted-foreground">{!snapshot.plan.sourceAnalysis?"当前快照未采集轻舟分析与评审详情，请重新同步来源。":!snapshot.plan.sourceAnalysis.reviewStages.length?"来源未返回评审环节，不能据此判断尚未评审或评审通过。":"各环节按来源记录展示，最终有效结论需结合正式流程核对。"} 无平台分析任务不代表尚未开展需求分析；保存分析不代表提交评审或评审通过。以上为来源快照，不替代开发准入或正式交付核验。</p>
      </div>}
      {current.id==="analysis"&&current.analyses.length>0&&<div className="space-y-2"><h4 className="text-sm font-medium">需求分析修订（阶段总览以最新修订为准）</h4>{current.analyses.map((analysis,index)=><article key={analysis.id} className="space-y-1 rounded-md bg-muted p-3"><Link className="text-sm font-medium underline" to={analysisUrl+"&executionId="+encodeURIComponent(analysis.id)}>{analysis.title} · 修订 {analysis.revision}{index===0?" · 最新":" · 历史"}</Link><p className="text-xs text-muted-foreground">{analysisStates[analysis.state]??analysis.state} · {new Date(analysis.updatedAt).toLocaleString("zh-CN")}</p></article>)}</div>}
      {current.unlistedRecords.map(record=><p key={record.taskId} className="text-sm"><Link className="underline" to={analysisUrl+"&executionId="+record.taskId}>查看流程关联分析任务 · {flowStates[record.state]}</Link></p>)}
      {current.rows.length>0?<div className="overflow-x-auto"><table className="w-full text-left text-sm"><caption className="sr-only">{current.label}阶段的关联工单、业务状态与平台执行</caption><thead><tr className="border-b border-border">{["工单／所属主单","来源状态／负责人","平台执行与待办","完成与交付记录","操作"].map(label=><th key={label} scope="col" className="p-3">{label}</th>)}</tr></thead><tbody>{current.rows.map(row=><tr key={row.item.key} className="border-b border-border">
        <td className="p-3"><p className="font-medium">{row.item.key} · {row.item.type}</p><p>{row.item.title}</p><p className="text-xs text-muted-foreground">主单：{row.item.parentKey||"当前来源未提供"}</p></td>
        <td className="p-3"><p>{row.item.status||"当前来源未提供"}</p><p className="text-xs text-muted-foreground">{row.item.assignee||"未提供负责人"}</p></td>
        <td className="space-y-2 p-3">{row.tasks.map(task=><div key={task.id}><Link className="underline" to={`/issues/${task.id}`}>{task.title}</Link><p className="text-xs text-muted-foreground">任务：{deliveryTaskStates[task.status]??task.status} · 运行：{task.runStatus?deliveryRunStates[task.runStatus]??task.runStatus:"未采集关联运行"}</p></div>)}{row.records.map(record=><div key={record.taskId}><p>{flowStates[record.state]}</p>{record.message&&<p className="text-xs text-muted-foreground">{record.message}</p>}<Link className="text-xs underline" to={`/seats?seat=${record.seatId}`}>查看执行席位</Link></div>)}{!row.tasks.length&&!row.records.length&&<span className="text-muted-foreground">尚未接入平台执行</span>}</td>
        <td className="p-3">{row.completed&&<p>已完成（Jira）</p>}{row.records.length?row.records.map(record=><div key={record.taskId} className="space-y-1"><p>{record.state==="done"?"平台交付已核验":record.receipt?"已上报平台交付，待核验":"尚无平台核验交付"}</p>{record.receipt&&<a className="text-xs underline" href={record.receipt.jiraReference} target="_blank" rel="noreferrer">交付证据 · {record.receipt.artifacts.length} 个产物</a>}{record.review&&<a className="block text-xs underline" href={record.review.reference} target="_blank" rel="noreferrer">正式评审结论 · {record.review.decision==="approve"?"通过":"退回"}</a>}</div>):!row.completed&&<span className="text-xs text-muted-foreground">以 Jira 来源状态为准</span>}</td>
        <td className="p-3"><div className="flex flex-col gap-2">{[...new Set([...row.tasks.map(t=>t.id),...row.records.map(r=>r.taskId)])].map((id,index)=><Link key={id} className="underline" to={`/issues/${id}`}>执行过程与对话{row.tasks.length>1?`（${index+1}）`:""}</Link>)}{!row.tasks.length&&!row.records.length&&<span className="text-xs text-muted-foreground">{row.ended?"查看来源历史": "待安排接入"}</span>}</div></td>
      </tr>)}</tbody></table></div>:<p className="text-sm text-muted-foreground">{current.id==="analysis"?"当前来源未关联需求分析子工单；条目级分析与评审见上方。":`当前来源未关联${current.label}工单。`}{current.analyses.length?"已关联的分析任务见上方。":"尚无任务不代表本阶段已完成。"}</p>}
      {current.id==="testing"&&<p className="text-xs text-muted-foreground">测试阶段包含用例编写、人工用例评审和功能测试；各子工单保留独立身份，按前置交付与评审结论推进。</p>}
      {current.id!=="analysis"&&<Button variant="outline" asChild><Link to={"/delivery?"+new URLSearchParams({projectId:snapshot.projectId,snapshotId:snapshot.id,tab:"work",stage:current.id})}>查看全部工单与安排执行</Link></Button>}
      <p className="text-xs text-muted-foreground">同一阶段的 Jira 来源工单全部完成即显示阶段已完成，无需平台执行或核验记录。平台运行与交付记录仅供补充查看，正式验收单独展示。</p>
    </section>
    {others.length>0&&<details className="text-sm"><summary className="cursor-pointer">其他未归类子工单（{others.length}）</summary><ul className="mt-2 space-y-2">{others.map(item=><li key={item.key}>{item.key} · {item.type} · {item.title} · {item.status||"状态未提供"}</li>)}</ul></details>}
    <p className="text-sm text-muted-foreground">正式验收：{workflow?.state==="completed"?"已登记正式验收":workflow?.state==="acceptance"?"待主需求负责人按正式流程验收":"尚未登记正式验收"}{workflow?.acceptance&&<> · <a className="underline" href={workflow.acceptance.reference} target="_blank" rel="noreferrer">查看结论</a></>}</p>
  </section>;
}
