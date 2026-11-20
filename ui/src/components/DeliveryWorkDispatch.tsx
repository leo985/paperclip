import { SourceStatusMultiSelect } from "./SourceStatusMultiSelect";
import { useId, useState } from "react";
import { deliveryRecordLabel, type DeliveryAdmission, type DeliveryJiraReviewResults, type DeliveryPlan, type DeliveryStageRecord } from "@paperclipai/shared";
import { Link } from "@/lib/router";
import { Button } from "@/components/ui/button";
import { deliveryDispatchRows, matchesDispatchView, deliveryTaskStates, deliveryRunStates, workStatusOptions, workStatusValue, sourceWorkEnded, type DeliveryLinkedTask, type DispatchView } from "@/lib/delivery-work-dispatch";

import { DeliveryEvidence, type DeliveryEvidenceState } from "./DeliveryMaterials";

const views: [DispatchView, string][] = [["pending", "待安排"], ["linked", "已接入"], ["ended", "来源已结束"], ["all", "全部子单"]];
export function DeliveryWorkDispatch({ plan, tasks, admission, projectId, snapshotId, records, jiraReviewResults, jiraAttachments, workflowState = "ready" }: {
  plan: DeliveryPlan; tasks: DeliveryLinkedTask[]; admission: DeliveryAdmission | null; projectId: string; snapshotId: string; canManage: boolean;
  records?: DeliveryStageRecord[];
  jiraReviewResults?: DeliveryJiraReviewResults["results"];
  jiraAttachments?: DeliveryJiraReviewResults["attachments"];
  workflowState?: DeliveryEvidenceState;
}) {
  const [view, setView] = useState<DispatchView>("all");
  const [search, setSearch] = useState("");
  const [sourceStatuses,setSourceStatuses] = useState<string[]>([]);
  const id = useId();
  const rows = deliveryDispatchRows(plan, tasks);
  const jiraAttachmentsByChild = new Map(jiraAttachments?.map(result => [result.jiraKey, result.files]));
  const jiraReviewByChild = new Map(jiraReviewResults?.map(result => [result.jiraKey, result]));
  const evidenceByChild = new Map<string, DeliveryStageRecord[]>();
  const unmatchedEvidence: DeliveryStageRecord[] = [];
  for (const record of records ?? []) {
    if (record.stage === "analysis") continue;
    const child = rows.find(({ item }) => item.key === record.jiraKey && (!record.parentKey || record.parentKey === item.parentKey));
    if (!child) {
      unmatchedEvidence.push(record);
      continue;
    }
    const evidence = evidenceByChild.get(child.item.key);
    if (evidence) evidence.push(record);
    else evidenceByChild.set(child.item.key, [record]);
  }
  const query = search.trim().toLocaleLowerCase();
  const parents = [...new Set([...plan.items.filter(item => !item.parentKey).map(item => item.key), ...plan.mains.map(item => item.key), ...rows.map(row => row.item.parentKey!)])];
  const groups = parents.map(key => {
    const main = plan.items.find(item => item.key === key);
    const title = main?.title || plan.mains.find(item => item.key === key)?.title || "来源未返回主工单详情";
    const children = rows.filter(row => row.item.parentKey === key);
    const visible = children.filter(row => matchesDispatchView(row, view) && (!sourceStatuses.length || sourceStatuses.includes(workStatusValue(row.item.status))) && (!query || `${key} ${title} ${row.item.key} ${row.item.title} ${row.item.type} ${row.item.assignee} ${row.item.status}`.toLocaleLowerCase().includes(query)));
    return { key, title, main, children, visible };
  }).filter(group => group.visible.length || (view === "all" && !sourceStatuses.length && !query && !group.children.length));
  const visibleCount = groups.reduce((count, group) => count + group.visible.length, 0);
  const unmatchedTasks = tasks.filter(task => !plan.items.some(item => item.key === task.jiraKey) && !parents.includes(task.jiraKey));
  return <section className="space-y-4" aria-label="主子工单与执行">
    <div className="space-y-2"><h2 className="font-semibold">主子工单与执行</h2><p className="text-sm text-muted-foreground">按主工单查看子工单的执行、交付材料和核验结论。</p></div>
    <div className="flex flex-wrap items-center justify-between gap-3">
      <div className="flex flex-wrap gap-2" role="group" aria-label="子工单范围">{views.map(([key,label]) => <Button key={key} type="button" variant={view===key?"secondary":"outline"} aria-pressed={view===key} onClick={()=>setView(key)}>{label}（{rows.filter(row=>matchesDispatchView(row,key)).length}）</Button>)}</div>
      <div className="flex items-center gap-2 text-sm"><span>来源状态</span><SourceStatusMultiSelect label="子工单来源状态" options={workStatusOptions(plan.items.filter(item=>!!item.parentKey))} values={sourceStatuses} onChange={values=>{setSourceStatuses(values);if(view==="pending"&&plan.items.some(item=>values.includes(workStatusValue(item.status))&&sourceWorkEnded(item.status)))setView("all");}}/></div>
      <label className="space-y-2 text-sm" htmlFor={id}><span className="sr-only">筛选待安排子工单</span><input id={id} aria-label="子工单执行搜索" placeholder="编号、标题、类型、状态或负责人" value={search} maxLength={200} onChange={e=>setSearch(e.target.value)} className="rounded-md border border-border bg-background p-2"/></label>
    </div>
    <p className="text-xs text-muted-foreground" role="status">当前显示 {visibleCount} / {rows.length} 个子工单。已接入与来源已结束可能重叠；准入核验不代表已经派发。</p>
    {groups.map(group=><details key={group.key} aria-label={`主工单 ${group.key}`} open className="rounded-lg border border-border">
      <summary className="cursor-pointer space-y-1 bg-muted p-3"><span className="font-medium">{group.key} · {group.title}</span><span className="ml-3 text-xs text-muted-foreground">主工单 · 来源：{group.main?.status||"未提供"} · 负责人：{group.main?.assignee||"未提供"} · 子单 {group.children.filter(row => row.ended).length}/{group.children.length} 来源已结束 · 显示 {group.visible.length}/{group.children.length} 个子单</span></summary>
      {tasks.filter(task => task.jiraKey === group.key).map(task => <div key={task.id} className="p-3 text-sm"><Link className="underline" to={`/issues/${task.id}`}>{task.title} · 查看主工单平台任务</Link><p>任务：{deliveryTaskStates[task.status] ?? task.status} · 运行：{task.runStatus ? deliveryRunStates[task.runStatus] ?? task.runStatus : "尚无关联运行"}</p></div>)}
      <div className="overflow-x-auto"><table className="w-full text-left text-sm"><caption className="sr-only">{group.key} 子工单执行安排</caption><thead><tr className="border-b border-border">{["子工单／类型", "来源状态／排期", "来源负责人", "平台任务／运行", "交付材料与核验", "操作"].map(label=><th key={label} scope="col" className="p-3">{label}</th>)}</tr></thead><tbody>{group.visible.map(row => {
        const evidence = evidenceByChild.get(row.item.key);
        const jiraReview = jiraReviewByChild.get(row.item.key);
        const attachments = jiraAttachmentsByChild.get(row.item.key);
        return <tr key={row.item.key} className="border-b border-border align-top">
        <td className="p-3"><p className="font-medium">{row.item.key} · {row.item.type}</p><p className="text-muted-foreground">{row.item.title}</p></td>
        <td className="p-3"><p>{row.item.status||"来源未提供"}</p><p className="text-xs text-muted-foreground">{row.item.scheduled?"已排期":"未在所采集排期中"}</p></td>
        <td className="p-3">{row.item.assignee||"未指派"}</td>
        <td className="p-3">{row.linked.length?row.linked.map(task=><div key={task.id} className="space-y-1"><Link className="underline" to={`/issues/${task.id}`}>{task.title}</Link><p className="text-xs text-muted-foreground">任务：{deliveryTaskStates[task.status]??task.status} · 运行：{task.runStatus?deliveryRunStates[task.runStatus]??task.runStatus:"尚无关联运行"}</p></div>):<span className="text-muted-foreground">尚未接入平台</span>}</td>
        <td className="space-y-2 p-3">
          {jiraReview && <div className="space-y-1">
            <a className="font-medium underline" href={jiraReview.url} target="_blank" rel="noreferrer">Jira 来源结论</a>
            <p className="whitespace-pre-wrap break-words">{jiraReview.description}</p>
          </div>}
          {!!attachments?.length && <div className="space-y-1">
            <p className="font-medium">Jira 来源附件</p>
            <ul className="space-y-1" aria-label="Jira 来源附件">
              {attachments.map(file => <li key={file.url}>
                <a className="break-all underline" href={file.url} target="_blank" rel="noreferrer">{file.filename}</a>
              </li>)}
            </ul>
          </div>}
          {evidence ? <div className="space-y-3">{evidence.map(record => <DeliveryEvidence
            key={record.taskId}
            record={record}
            showTask={!row.linked.some(task => task.id === record.taskId)}
          />)}</div> : <span className="text-muted-foreground">{workflowState === "ready" ? "尚未登记平台交付证据" : "流程交付回执待核实"}</span>}
        </td>
        <td className="p-3">{row.linked.length?<div className="flex flex-wrap gap-2">{row.linked.map((task,index)=><Button key={task.id} variant="outline" asChild><Link to={`/issues/${task.id}`}>{["done","cancelled"].includes(task.status)?"查看任务记录":"查看与继续处理"}{row.linked.length>1?`（${index+1}）`:""}</Link></Button>)}</div>:row.ended?<span className="text-muted-foreground">Jira 已结束，无需再次执行</span>:<Button variant="outline" asChild><Link to={"/delivery?"+new URLSearchParams({projectId,snapshotId,tab:"work"})+"#delivery-workflow"}>交付计划</Link></Button>}</td>
      </tr>; })}</tbody></table></div>
    </details>)}
    {!groups.length&&<div className="space-y-2 rounded-lg border border-border p-4"><p>{query||sourceStatuses.length?"没有匹配的子工单，请调整搜索或来源状态。":view==="pending"?"暂无待安排的交付链子单。已接入及来源已结束的工单已收起。":"当前范围暂无子工单。"}</p>{view!=="all"&&<Button variant="ghost" onClick={()=>setView("all")}>查看全部子单</Button>}</div>}
    {unmatchedEvidence.length > 0 && <section className="space-y-3" aria-label="当前来源未匹配的交付证据">
      <h3 className="font-medium">当前来源未匹配的交付证据</h3>
      {unmatchedEvidence.map(record => <div key={record.taskId} className="space-y-2 rounded-lg border border-border p-3 text-sm">
        <p>{[record.parentKey, record.jiraKey, deliveryRecordLabel(record)].filter(Boolean).join(" · ")}</p>
        <DeliveryEvidence record={record} showTask />
      </div>)}
    </section>}
    {!!unmatchedTasks.length && <section className="space-y-2" aria-label="当前来源未匹配的平台任务"><h3 className="font-medium">当前来源未匹配的平台任务</h3>{unmatchedTasks.map(task => <div key={task.id} className="text-sm"><Link className="underline" to={`/issues/${task.id}`}>{task.jiraKey} · {task.title}</Link><p>任务：{deliveryTaskStates[task.status] ?? task.status} · 运行：{task.runStatus ? deliveryRunStates[task.runStatus] ?? task.runStatus : "尚无关联运行"}</p></div>)}</section>}
    <p className="text-xs text-muted-foreground">子单结束数量按来源状态统计，不代表正式验收通过。来源状态与上方范围同时生效；在待安排范围选择已完成、已发版等结束状态时，自动切换“全部子单”。已接入工单通过原任务查看记录；条目统一通过交付链实例启动，节点满足前置后自动派发或生成负责人的人工待办。查看计划不会派发或启动任务。</p>
  </section>;
}
