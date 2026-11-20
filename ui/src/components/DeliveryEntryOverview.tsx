import { deliveryRecordLabel, type DeliveryEntryDetail, type DeliveryWorkflow } from "@paperclipai/shared";
import { Link } from "@/lib/router";
import { compareDeliveryPriority, deliveryCounts, type DashboardIssue } from "@/lib/delivery-dashboard";
import { deliveryMainIssueKeys } from "@/lib/delivery-entry-stages";
import { managementToday } from "@/lib/delivery-monthly-filters";
import { DeliveryProgressBar } from "./DeliveryProgressBar";
import { Button } from "./ui/button";

// Older snapshots lack the Jira status category saved in monthlyChildIssues.
const completedStatuses = new Set(["已完成", "完成", "已关闭", "关闭", "已发版", "已发布", "已验收", "done", "closed", "resolved", "released", "accepted"]);

function sourceProgress(detail: DeliveryEntryDetail) {
  const today = managementToday();
  const soon = new Date(Date.parse(today) + 7 * 86_400_000).toISOString().slice(0, 10);
  const { plan } = detail.snapshot;
  const seen = new Set<string>();
  return plan.items.flatMap(item => {
    if (!item.parentKey || seen.has(item.key)) return [];
    seen.add(item.key);
    const fact = plan.monthlyChildIssues?.issues[item.key];
    const status = item.status.trim();
    if (fact?.cancelled ?? /作废|取消|^cancel(?:led|ed)$|^void(?:ed)?$/i.test(status)) return [];
    const completed = fact?.done ?? completedStatuses.has(status.toLowerCase());
    const dueDate = fact?.dueDate ?? null;
    const risk: DashboardIssue["risk"] = completed ? "done" : !dueDate ? "unscheduled" :
      dueDate < today ? "overdue" : dueDate <= soon ? "due_soon" : "on_track";
    return [{ ...item, completed, dueDate, risk, inMonth: true }];
  });
}

export function DeliveryEntryOverview({ detail, workflow, onOpenWork, onOpenWorkflow }: {
  detail: DeliveryEntryDetail;
  workflow?: DeliveryWorkflow;
  onOpenWork: () => void;
  onOpenWorkflow: (taskId?: string) => void;
}) {
  const { snapshot, chainAdmission } = detail;
  const items = sourceProgress(detail);
  const counts = deliveryCounts(items);
  const mainKeys = deliveryMainIssueKeys(snapshot.plan);
  const deliveryRisks = items.filter(item => item.risk === "overdue" || item.risk === "due_soon").sort(compareDeliveryPriority);
  const activeWorkflow = workflow?.state === "completed" || workflow?.state === "cancelled" ? undefined : workflow;
  const nodes = activeWorkflow?.stages ?? [];
  const nodeActions = nodes.flatMap(node => {
    const label = node.branchBlocked && node.state !== "done" ? "待处理" :
      node.state === "review" ? "待核验" :
      node.state === "interrupted" ? "交付链中断" :
      node.state === "waiting" ? "待人工决定" :
      node.state === "pending" && node.startMode === "confirmation" && !node.startApprovedBy && !node.runId &&
      (node.dependsOn ?? []).every(id => nodes.some(upstream => upstream.taskId === id && upstream.state === "done")) ? "待确认启动" : null;
    return label ? [{ node, label }] : [];
  });
  const linkedNodeIds = new Set(nodes.map(node => node.taskId));
  const analysisActions = detail.analyses.filter(item => !linkedNodeIds.has(item.id) && ["waiting", "interrupted"].includes(item.state));
  const taskActions = detail.tasks.filter(task =>
    !linkedNodeIds.has(task.id) && !["done", "cancelled"].includes(task.status) &&
    (task.status === "blocked" || ["failed", "timed_out"].includes(task.runStatus ?? "")));
  const reviewAcceptance = activeWorkflow?.state === "acceptance";
  const chainBlocked = activeWorkflow?.state === "blocked" && !nodeActions.length;
  const entryBlocked = !workflow && chainAdmission && !chainAdmission.ready;
  const differences = snapshot.plan.differences.length;
  const needsAttention = entryBlocked || reviewAcceptance || chainBlocked || differences > 0 ||
    deliveryRisks.length > 0 || nodeActions.length > 0 || analysisActions.length > 0 || taskActions.length > 0;

  return <>
    <section className="space-y-4 rounded-xl border border-border bg-card p-5" aria-label="条目交付进度">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="space-y-1">
          <h2 className="text-lg font-semibold">条目交付进度</h2>
          <p className="text-xs text-muted-foreground">统计关联主工单下的 Jira 子工单，已取消工单不计入。</p>
        </div>
        <Button variant="outline" size="sm" onClick={onOpenWork}>查看工单与执行</Button>
      </div>
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <strong className="font-mono text-3xl font-semibold tracking-tight tabular-nums">
          {counts.total ? `${Math.round(counts.done / counts.total * 100)}%` : "—"}
        </strong>
        <span className="text-sm text-muted-foreground">{counts.total ? "子工单完成率" : "暂无可统计子工单"}</span>
      </div>
      <DeliveryProgressBar counts={counts} label="条目子工单完成进度" emptyLabel="暂无可统计子工单" large />
      <dl className="flex flex-wrap gap-x-6 gap-y-3">
        {([
          ["应完成", counts.total], ["已完成", counts.done], ["剩余", counts.total - counts.done],
          ["已逾期", counts.overdue], ["7 天内到期", counts.due_soon],
          ["其他待交付", counts.on_track], ["缺截止日", counts.waiting_for_deadline],
        ] as const).map(([label, count], index) => (index < 3 || count > 0) && <div key={label}>
          <dt className="text-xs text-muted-foreground">{label}</dt>
          <dd className="font-mono text-xl font-semibold tabular-nums">{count}</dd>
        </div>)}
      </dl>
      {mainKeys.length > 1 && <ul aria-label="各主工单完成进度" className="divide-y divide-border border-t border-border">
        {mainKeys.map(key => {
          const progress = deliveryCounts(items.filter(item => item.parentKey === key));
          return <li key={key} className="flex flex-wrap items-center justify-between gap-2 py-2 text-sm">
            <span className="font-medium">{key}</span>
            <span className="text-muted-foreground">{progress.total ? `已完成 ${progress.done} / ${progress.total}` : "暂无可统计子工单"}</span>
          </li>;
        })}
      </ul>}
    </section>
    {needsAttention && <section className="space-y-3 rounded-xl border border-border bg-card p-5" aria-label="需要处理">
      <h2 className="text-lg font-semibold">需要处理</h2>
      <ul className="divide-y divide-border text-sm">
        {deliveryRisks.map(item => <li className="py-2" key={item.key}>
          <button type="button" className="text-left underline underline-offset-4" onClick={onOpenWork}>
            <span className={item.risk === "overdue" ? "font-medium text-destructive" : "font-medium"}>
              {item.risk === "overdue" ? "已逾期" : "7 天内到期"}
            </span> · {item.key} · {item.type} · {item.dueDate}
          </button>
        </li>)}
        {nodeActions.map(({ node, label }) => <li className="py-2" key={node.taskId}>
          <button type="button" className="text-left underline underline-offset-4" onClick={() => onOpenWorkflow(node.taskId)}>
            {label} · {node.jiraKey ?? node.parentKey ?? snapshot.demandNo} · {deliveryRecordLabel(node)}
          </button>
        </li>)}
        {reviewAcceptance && <li className="py-2"><button type="button" className="underline underline-offset-4" onClick={() => onOpenWorkflow()}>办理正式验收</button></li>}
        {chainBlocked && <li className="py-2"><button type="button" className="underline underline-offset-4" onClick={() => onOpenWorkflow()}>查看交付链阻塞</button></li>}
        {analysisActions.map(analysis => <li className="py-2" key={analysis.id}>
          <Link className="underline" to={"/analysis-executions?" + new URLSearchParams({ projectId: snapshot.projectId, executionId: analysis.id })}>
            {analysis.state === "waiting" ? "等待人工决定" : "分析中断"} · {analysis.title}
          </Link>
        </li>)}
        {taskActions.map(task => <li className="py-2" key={task.id}><Link className="underline" to={`/issues/${task.id}`}>{task.jiraKey} · {task.title} · 查看执行异常</Link></li>)}
        {differences > 0 && <li className="py-2"><button type="button" className="underline underline-offset-4" onClick={onOpenWork}>核对 {differences} 项来源差异</button></li>}
        {entryBlocked && <li className="space-y-1 py-2">
          <Link className="font-medium underline" to="/delivery-chain">处理交付链准入</Link>
          {chainAdmission.reasons.map(reason => <p key={reason}>{reason}</p>)}
        </li>}
      </ul>
    </section>}
  </>;
}
