import type { DeliverySnapshot } from "@paperclipai/shared";
import { deliveryMainIssueKeys } from "@/lib/delivery-entry-stages";

export function deliveryMainIssueId(snapshotId: string, key: string) {
  return `delivery-main-${snapshotId}-${encodeURIComponent(key)}`;
}

/** Keep the entry, Jira parents and their children as distinct source entities. */
export function DeliveryEntryMainIssues({ snapshot }: { snapshot: DeliverySnapshot }) {
  const { plan } = snapshot;
  const keys = deliveryMainIssueKeys(plan);
  return <section className="space-y-3" aria-label="关联主工单">
    <header className="space-y-1"><h2 className="font-semibold">关联主工单</h2><p className="text-sm text-muted-foreground">条目 {snapshot.demandNo} → Jira 主工单 → 各阶段子工单。主工单状态与负责人按当前来源快照展示。</p></header>
    {keys.length ? <ul className="grid gap-3 md:grid-cols-2">{keys.map(key => {
      const main = plan.mains.find(item => item.key === key);
      const source = plan.items.find(item => item.key === key && !item.parentKey);
      const children = plan.items.filter(item => item.parentKey === key);
      return <li key={key} id={deliveryMainIssueId(snapshot.id, key)} className="space-y-2 rounded-lg border border-border p-4">
        <h3 className="font-semibold">{key} · {source?.type || "主工单"}</h3>
        <p className="text-sm">{source?.title || main?.title || "来源未返回主工单详情"}</p>
        <div className="flex flex-wrap gap-3 text-sm"><p>来源状态：{source?.status || "未提供"}</p><p>负责人：{source?.assignee || "未提供"}</p><p>关联子工单：{children.length} 张</p></div>
        {!source && <p className="text-xs text-muted-foreground">当前来源仅包含主工单关联，尚未采集其状态和负责人；请同步来源后核对。</p>}
      </li>;
    })}</ul> : <p className="text-sm text-muted-foreground">当前来源未关联 Jira 主工单，请同步来源后核对；条目编号不等于 Jira 主工单编号。</p>}
  </section>;
}
