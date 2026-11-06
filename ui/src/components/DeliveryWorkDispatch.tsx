import { SourceStatusMultiSelect } from "./SourceStatusMultiSelect";
import { useId, useState } from "react";
import type { DeliveryAdmission, DeliveryPlan } from "@paperclipai/shared";
import { Link } from "@/lib/router";
import { Button } from "@/components/ui/button";
import { deliveryDispatchRows, matchesDispatchView, deliveryTaskStates, deliveryRunStates, workStatusOptions, workStatusValue, sourceWorkEnded, type DeliveryLinkedTask, type DispatchView } from "@/lib/delivery-work-dispatch";

const views: [DispatchView, string][] = [["pending", "待安排"], ["linked", "已接入"], ["ended", "来源已结束"], ["all", "全部子单"]];
export function DeliveryWorkDispatch({ plan, tasks, admission, projectId, snapshotId, canManage }: {
  plan: DeliveryPlan; tasks: DeliveryLinkedTask[]; admission: DeliveryAdmission | null; projectId: string; snapshotId: string; canManage: boolean;
}) {
  const [view, setView] = useState<DispatchView>("pending");
  const [search, setSearch] = useState("");
  const [sourceStatuses,setSourceStatuses] = useState<string[]>([]);
  const id = useId();
  const rows = deliveryDispatchRows(plan, tasks);
  const query = search.trim().toLocaleLowerCase();
  const parents = [...new Set(rows.map(row => row.item.parentKey!))];
  const groups = parents.map(key => {
    const main = plan.items.find(item => item.key === key);
    const title = main?.title || plan.mains.find(item => item.key === key)?.title || "来源未返回主工单详情";
    const children = rows.filter(row => row.item.parentKey === key);
    const visible = children.filter(row => matchesDispatchView(row, view) && (!sourceStatuses.length || sourceStatuses.includes(workStatusValue(row.item.status))) && (!query || `${key} ${title} ${row.item.key} ${row.item.title} ${row.item.type} ${row.item.assignee} ${row.item.status}`.toLocaleLowerCase().includes(query)));
    return { key, title, main, children, visible };
  }).filter(group => group.visible.length);
  const visibleCount = groups.reduce((count, group) => count + group.visible.length, 0);
  return <section className="space-y-4" aria-label="子工单安排执行">
    <div className="space-y-2"><h2 className="font-semibold">子工单安排执行</h2><p className="text-sm text-muted-foreground">默认仅展示尚未接入平台、来源未结束的设计与编码子单。“全部子单”可查看其他类型及历史工单；来源状态以当前保存版本为准。</p></div>
    <div className="flex flex-wrap items-center justify-between gap-3">
      <div className="flex flex-wrap gap-2" role="group" aria-label="子工单范围">{views.map(([key,label]) => <Button key={key} type="button" variant={view===key?"secondary":"outline"} aria-pressed={view===key} onClick={()=>setView(key)}>{label}（{rows.filter(row=>matchesDispatchView(row,key)).length}）</Button>)}</div>
      <div className="flex items-center gap-2 text-sm"><span>来源状态</span><SourceStatusMultiSelect label="子工单来源状态" options={workStatusOptions(plan.items.filter(item=>!!item.parentKey))} values={sourceStatuses} onChange={values=>{setSourceStatuses(values);if(view==="pending"&&plan.items.some(item=>values.includes(workStatusValue(item.status))&&sourceWorkEnded(item.status)))setView("all");}}/></div>
      <label className="space-y-2 text-sm" htmlFor={id}><span className="sr-only">筛选待安排子工单</span><input id={id} aria-label="子工单执行搜索" placeholder="编号、标题、类型、状态或负责人" value={search} maxLength={200} onChange={e=>setSearch(e.target.value)} className="rounded-md border border-border bg-background p-2"/></label>
    </div>
    <p className="text-xs text-muted-foreground" role="status">当前显示 {visibleCount} / {rows.length} 个子工单。已接入与来源已结束可能重叠；准入核验不代表已经派发。</p>
    {groups.map(group=><details key={group.key} open className="rounded-lg border border-border">
      <summary className="cursor-pointer space-y-1 bg-muted p-3"><span className="font-medium">{group.key} · {group.title}</span><span className="ml-3 text-xs text-muted-foreground">主工单 · 来源：{group.main?.status||"未提供"} · 负责人：{group.main?.assignee||"未提供"} · 显示 {group.visible.length}/{group.children.length} 个子单</span></summary>
      <div className="overflow-x-auto"><table className="w-full text-left text-sm"><caption className="sr-only">{group.key} 子工单执行安排</caption><thead><tr className="border-b border-border">{["子工单／类型", "来源状态／排期", "来源负责人", "平台任务／运行", "操作"].map(label=><th key={label} scope="col" className="p-3">{label}</th>)}</tr></thead><tbody>{group.visible.map(row=><tr key={row.item.key} className="border-b border-border">
        <td className="p-3"><p className="font-medium">{row.item.key} · {row.item.type}</p><p className="text-muted-foreground">{row.item.title}</p></td>
        <td className="p-3"><p>{row.item.status||"来源未提供"}</p><p className="text-xs text-muted-foreground">{row.item.scheduled?"已排期":"未在所采集排期中"}</p></td>
        <td className="p-3">{row.item.assignee||"未指派"}</td>
        <td className="p-3">{row.linked.length?row.linked.map(task=><div key={task.id} className="space-y-1"><Link className="underline" to={`/issues/${task.id}`}>{task.title}</Link><p className="text-xs text-muted-foreground">任务：{deliveryTaskStates[task.status]??task.status} · 运行：{task.runStatus?deliveryRunStates[task.runStatus]??task.runStatus:"尚无关联运行"}</p></div>):<span className="text-muted-foreground">尚未接入平台</span>}</td>
        <td className="p-3">{row.linked.length?<div className="flex flex-wrap gap-2">{row.linked.map((task,index)=><Button key={task.id} variant="outline" asChild><Link to={`/issues/${task.id}`}>{["done","cancelled"].includes(task.status)?"查看任务记录":"查看与继续处理"}{row.linked.length>1?`（${index+1}）`:""}</Link></Button>)}</div>:row.ended?<span className="text-muted-foreground">来源已结束，不派发</span>:!row.supported?<span className="text-muted-foreground">此类型暂不支持从此处派发</span>:!canManage?<span className="text-muted-foreground">需管理员安排执行</span>:/编码/.test(row.item.type)&&!admission?.ready?<span className="text-muted-foreground">编码待准入核验</span>:<Button variant="outline" asChild><Link to={"/jira-intake?"+new URLSearchParams({projectId,snapshotId,jiraKey:row.item.key})}>选择席位并派发</Link></Button>}</td>
      </tr>)}</tbody></table></div>
    </details>)}
    {!visibleCount&&<div className="space-y-2 rounded-lg border border-border p-4"><p>{query||sourceStatuses.length?"没有匹配的子工单，请调整搜索或来源状态。":view==="pending"?"暂无待安排的设计或编码子单。已接入及来源已结束的工单已收起。":"当前范围暂无子工单。"}</p>{view!=="all"&&<Button variant="ghost" onClick={()=>setView("all")}>查看全部子单</Button>}</div>}
    <p className="text-xs text-muted-foreground">来源状态与上方范围同时生效；在待安排范围选择已完成、已发版等结束状态时，自动切换“全部子单”。已接入工单通过原任务查看对话、人工决策和恢复，不重复创建任务。来源未结束不代表允许开工；派发时仍核验最新 Jira 状态、席位授权及开发准入。其他类型的派发能力不因切换“全部子单”而开放。</p>
  </section>;
}
