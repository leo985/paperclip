import { SourceStatusMultiSelect } from "./SourceStatusMultiSelect";
import { Fragment, useEffect, useId, useMemo, useState } from "react";
import { ChevronDown, ChevronRight, CornerDownRight } from "lucide-react";
import type { DeliveryPlan, DeliveryWorkItem } from "@paperclipai/shared";
import { workStatusOptions, workStatusValue } from "@/lib/delivery-work-dispatch";
import { Button } from "@/components/ui/button";

// Source status is a display statistic, never an execution or acceptance gate.
const completed = (status: string) => /^(已完成|已关闭|已发布|已发版|完成|关闭|done|closed|resolved|released)$/i.test(status.trim());
export function DeliveryWorkTree({ plan }: { plan: DeliveryPlan }) {
  const id = useId();
  const [search, setSearch] = useState("");
  const [sourceStatuses,setSourceStatuses] = useState<string[]>([]);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  useEffect(() => { setExpanded({}); setSearch(""); setSourceStatuses([]); }, [plan.fingerprint]);
  const groups = useMemo(() => {
    const children = new Map<string, DeliveryWorkItem[]>();
    for (const item of plan.items) if (item.parentKey) children.set(item.parentKey, [...(children.get(item.parentKey) ?? []), item]);
    return plan.items.filter(item => !item.parentKey).map(main => {
      const items = children.get(main.key) ?? [];
      return { main, items, done: items.filter(item => completed(item.status)).length, defaultOpen: items.length > 0 && (!completed(main.status) || items.some(item => !completed(item.status))) };
    });
  }, [plan.items]);
  const query = search.trim().toLocaleLowerCase();
  const matches = (item: DeliveryWorkItem) => `${item.key} ${item.title} ${item.type} ${item.assignee} ${item.status}`.toLocaleLowerCase().includes(query);
  const matchesStatus = (item: DeliveryWorkItem) => !sourceStatuses.length || sourceStatuses.includes(workStatusValue(item.status));
  const visible = groups.map(group => ({ ...group, visibleItems: group.items.filter(item=>matchesStatus(item)&&(!query||matches(group.main)||matches(item))) })).filter(group => group.visibleItems.length || ((!query||matches(group.main))&&matchesStatus(group.main)));
  const orphaned = plan.items.filter(item => item.parentKey && !groups.some(group => group.main.key === item.parentKey) && matchesStatus(item) && (!query || matches(item)));
  function expandAll(open: boolean) { setExpanded(Object.fromEntries(groups.map(group => [group.main.key, open]))); }
  function childRow(item: DeliveryWorkItem) {
    return <tr key={item.key} className="border-b border-border">
      <td className="p-3"><div className="flex items-center gap-2 pl-8"><CornerDownRight aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" /><span className="whitespace-nowrap font-mono">{item.key}</span></div></td>
      <td className="p-3"><p>{item.type}</p><p className="text-muted-foreground">{item.title}</p></td>
      <td className="whitespace-nowrap p-3">{item.status || "来源未提供"}</td><td className="p-3">{item.assignee || "未指派"}</td><td className="whitespace-nowrap p-3">{item.scheduled ? "已排期" : "未在排期中"}</td>
    </tr>;
  }
  return <section className="space-y-3" aria-label="主子工单树">
    <div className="flex flex-wrap items-center justify-between gap-3">
      <label className="flex flex-wrap items-center gap-2 text-sm">筛选工单<input aria-label="树形工单搜索" className="rounded-md border border-border bg-background p-2" placeholder="编号、标题、类型、状态或经办人" value={search} onChange={event => setSearch(event.target.value)} /></label>
      <div className="flex items-center gap-2 text-sm"><span>来源状态</span><SourceStatusMultiSelect label="树形工单来源状态" options={workStatusOptions(plan.items)} values={sourceStatuses} onChange={setSourceStatuses}/></div>
      <div className="flex gap-2"><Button type="button" variant="outline" disabled={!!query || !!sourceStatuses.length || !groups.length} onClick={() => expandAll(true)}>全部展开</Button><Button type="button" variant="outline" disabled={!!query || !!sourceStatuses.length || !groups.length} onClick={() => expandAll(false)}>全部收起</Button></div>
    </div>
    <p className="text-xs text-muted-foreground">{query || sourceStatuses.length ? "筛选时自动展开匹配分支并保留主工单；清空后恢复展开状态。" : "默认展开仍有待办的主工单，全部完成的分支默认收起。"}子单完成数按来源状态统计，不代表正式验收通过。</p>
    <div className="overflow-x-auto"><table className="w-full text-left text-sm"><caption className="sr-only">主子工单与排期核对</caption><thead><tr className="border-b border-border">{["工单", "类型 / 标题", "来源状态", "经办人", "排期"].map(label => <th key={label} scope="col" className="p-3">{label}</th>)}</tr></thead>
      {visible.map(group => {
        const open = group.items.length > 0 && (!!query || !!sourceStatuses.length || (expanded[group.main.key] ?? group.defaultOpen));
        const controls = `${id}-${group.main.key}-children`;
        return <Fragment key={group.main.key}><tbody><tr className="border-b border-border bg-muted">
          <th scope="row" className="p-3 text-left font-normal"><div className="flex items-center gap-2"><Button type="button" variant="ghost" size="icon" disabled={!group.items.length} aria-label={`${open ? "收起" : "展开"} ${group.main.key} 的子工单`} aria-expanded={open} aria-controls={controls} onClick={() => setExpanded(previous => ({ ...previous, [group.main.key]: !open }))}>{open ? <ChevronDown aria-hidden="true" className="size-4" /> : <ChevronRight aria-hidden="true" className="size-4" />}</Button><span className="whitespace-nowrap font-mono font-medium">{group.main.key}</span></div></th>
          <td className="p-3"><p className="font-medium">{group.main.title}</p><p className="text-xs text-muted-foreground">主工单 · {group.main.type} · {group.items.length ? `子单 ${group.done}/${group.items.length} 已完成` : "暂无子工单"}</p></td>
          <td className="whitespace-nowrap p-3">{group.main.status || "来源未提供"}</td><td className="p-3">{group.main.assignee || "未指派"}</td><td className="p-3">—</td>
        </tr></tbody><tbody id={controls} hidden={!open}>{group.visibleItems.map(childRow)}</tbody></Fragment>;
      })}
      {!!orphaned.length && <tbody><tr><th colSpan={5} className="p-3 text-left">未匹配主工单的子单（请核对来源）</th></tr>{orphaned.map(childRow)}</tbody>}
    </table></div>
    {!visible.length && !orphaned.length && <p className="text-sm text-muted-foreground">{query || sourceStatuses.length ? "没有匹配的工单，请调整关键词或来源状态。" : "该来源版本暂无工单。"}</p>}
  </section>;
}
