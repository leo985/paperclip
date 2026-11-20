import { useId, useState } from "react";
import {
  DELIVERY_STAGE_LABELS,
  type DeliveryAutomaticPlan,
  type DeliveryPlan,
  type DeliveryStageRecord,
  type DeliveryWorkflow,
} from "@paperclipai/shared";

type PlanNode = DeliveryAutomaticPlan["nodes"][number];
export type PlanExecutionStages = ReadonlyMap<string, Pick<DeliveryStageRecord, "state" | "branchBlocked" | "executionMode">>;

// Diagram coordinates use the same spacing units as the underlying grid.
const columnWidth = 56;
const rowHeight = 24;
const nodeInset = 4;

const planStatuses = {
  pending: { label: "未开始", color: "var(--status-task-icon-backlog)" },
  running: { label: "进行中", color: "var(--status-task-icon-in_progress)" },
  completed: { label: "已完成", color: "var(--status-task-icon-done)" },
  verification: { label: "待核验", color: "var(--status-task-icon-in_review)" },
  historical: { label: "Jira 已完成 · 待核验", color: "var(--status-task-icon-in_review)" },
  blocked: { label: "已阻塞", color: "var(--status-task-icon-blocked)" },
  cancelled: { label: "已取消", color: "var(--muted-foreground)" },
  unknown: { label: "状态待确认", color: "var(--muted-foreground)" },
};

function planStatus(task: PlanNode | null, status: string, sourceDone: boolean) {
  if (task?.revalidate) return planStatuses.verification;
  if (task?.mode === "reuse" && (task.verificationNote || task.executor === "成果待核验"))
    return planStatuses.historical;
  if (/^(已挂起|挂起|已阻塞|阻塞|已退回|退回|打回|评审不通过|审查不通过|blocked|on hold|rejected)$/i.test(status))
    return planStatuses.blocked;
  if ((task?.mode === "reuse" && task.evidenceVersion) || sourceDone ||
      /^(已完成|完成|已关闭|关闭|已解决|已发版|已发布|已上线|done|closed|resolved|released)$/i.test(status))
    return planStatuses.completed;
  if (/^(处理中|进行中|设计中|编码中|开发中|评审中|审查中|测试中|执行中|in progress|in_progress|running)$/i.test(status))
    return planStatuses.running;
  if (/^(待受理|待处理|未开始|待开始|待设计|待编码|待开发|待评审|待设计评审|待代码评审|待审查|待测试|待执行|待办|新建|todo|to do|pending|open|queued)$/i.test(status))
    return planStatuses.pending;
  return planStatuses.unknown;
}

function executionStatus(stage: NonNullable<ReturnType<PlanExecutionStages["get"]>>, workflowState?: DeliveryWorkflow["state"]) {
  if (stage.state === "done") return planStatuses.completed;
  if (workflowState === "cancelled") return planStatuses.cancelled;
  if (stage.branchBlocked || stage.state === "interrupted") return planStatuses.blocked;
  if (stage.state === "pending" || stage.state === "queued") return planStatuses.pending;
  if (stage.state === "review" && stage.executionMode !== "human")
    return { ...planStatuses.running, label: "进行中 · 待核验" };
  if (stage.state === "waiting") return { ...planStatuses.running, label: "进行中 · 等待答复" };
  return planStatuses.running;
}

function placeNodes(nodes: PlanNode[], afterParentKey?: string) {
  const taskKeys = new Set(nodes.map(node => node.jiraKey ?? "analysis"));
  const externalKeys = new Set(nodes.flatMap(node => node.dependsOn.filter(key => !taskKeys.has(key))));
  if (afterParentKey) externalKeys.add(afterParentKey);
  const columns = new Map<string, number>();
  const external = [...externalKeys].map<{ key: string; dependencies: string[]; task: null }>(key =>
    ({ key, dependencies: [], task: null }));
  const tasks = nodes.map(task => ({
    key: task.jiraKey ?? "analysis",
    task,
    dependencies: afterParentKey && !task.dependsOn.some(key => taskKeys.has(key))
      ? [...new Set([...task.dependsOn, afterParentKey])]
      : task.dependsOn,
  }));
  return [...external, ...tasks].map((node, row) => {
    const column = Math.max(-1, ...node.dependencies.map(key => columns.get(key) ?? -1)) + 1;
    columns.set(node.key, column);
    return { ...node, column, row };
  });
}

export function DeliveryPlanDependencyChart({
  nodes,
  source,
  afterParentKey,
  execution,
  workflowState,
}: {
  nodes: PlanNode[];
  source: Pick<DeliveryPlan, "items" | "monthlyChildIssues">;
  afterParentKey?: string;
  execution?: PlanExecutionStages;
  workflowState?: DeliveryWorkflow["state"];
}) {
  const arrow = useId();
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const placed = placeNodes(nodes, afterParentKey);
  const byKey = new Map(placed.map(node => [node.key, node]));
  const sourceByKey = new Map(source.items.map(item => [item.key, item]));
  const columns = Math.max(...placed.map(node => node.column)) + 1;
  const selected = selectedKey ? byKey.get(selectedKey) : undefined;
  const successors = selected ? placed.filter(node => node.dependencies.includes(selected.key)) : [];
  const label = (key: string) => key === "analysis" ? "需求分析" : key;

  return (
    <figure className="space-y-2">
      <figcaption className="flex flex-wrap items-baseline gap-x-3 gap-y-1 text-sm">
        <span className="font-medium">计划依赖</span>
        <span className="text-muted-foreground">从左到右推进，同列节点可并行</span>
        <span className="flex flex-wrap gap-3" aria-label="节点状态图例">
          {[planStatuses.pending, planStatuses.running, planStatuses.completed].map(status => (
            <span key={status.label} className="flex items-center gap-1">
              <span aria-hidden="true" className="size-2 rounded-full" style={{ backgroundColor: status.color }} />
              {status.label}
            </span>
          ))}
        </span>
      </figcaption>
      <div className="max-h-(--sz-70vh) w-fit max-w-full overflow-auto rounded-md border border-border bg-muted/30">
        <div
          className="relative isolate grid w-max"
          style={{
            gridTemplateColumns: `repeat(${columns}, calc(var(--spacing) * ${columnWidth}))`,
            gridTemplateRows: `repeat(${placed.length}, calc(var(--spacing) * ${rowHeight}))`,
          }}
        >
          <svg
            aria-hidden="true"
            className="pointer-events-none absolute inset-0 size-full text-muted-foreground"
            viewBox={`0 0 ${columns * columnWidth} ${placed.length * rowHeight}`}
            fill="none"
          >
            <defs>
              <marker id={arrow} viewBox="0 0 4 4" refX="4" refY="2" markerWidth="2" markerHeight="2"
                markerUnits="userSpaceOnUse" orient="auto">
                <path d="M 0 0 L 4 2 L 0 4" fill="context-stroke" />
              </marker>
            </defs>
            {placed.flatMap(node => node.dependencies.map(key => {
              const previous = byKey.get(key);
              if (!previous || previous.column >= node.column) return null;
              const startX = (previous.column + 1) * columnWidth - nodeInset;
              const startY = (previous.row + 0.5) * rowHeight;
              const endX = node.column * columnWidth + nodeInset;
              const endY = (node.row + 0.5) * rowHeight;
              const turnX = (previous.column + 1) * columnWidth;
              const connected = !selected || selected.key === node.key || selected.key === key;
              return <path key={`${key}:${node.key}`} d={`M ${startX} ${startY} H ${turnX} V ${endY} H ${endX}`}
                className={!connected ? "opacity-25" : selected ? "text-primary" : undefined}
                stroke="currentColor" strokeWidth={selected && connected ? 0.65 : 0.4} markerEnd={`url(#${arrow})`} />;
            }))}
          </svg>
          {placed.map(({ key, task, column, row, dependencies }) => {
            const date = source.monthlyChildIssues?.issues[key];
            const issue = sourceByKey.get(key);
            const rawStatus = issue?.status?.trim() ?? "";
            const runningStage = execution?.get(key);
            const status = runningStage ? executionStatus(runningStage, workflowState)
              : task || rawStatus ? planStatus(task, rawStatus, !!date?.done && !date.cancelled) : null;
            const type = task
              ? issue?.type || DELIVERY_STAGE_LABELS[task.stage]
              : key === "analysis" ? "条目共享环节" : "前置主工单";
            const dateLabel = date?.deadlineSource === "main" ? "主单排期"
              : date?.deadlineSource === "demand" ? "条目期望" : "期望结束";
            return (
              <button
                key={key}
                type="button"
                style={{ gridColumn: column + 1, gridRow: row + 1, borderInlineStartColor: status?.color }}
                className={`relative mx-4 my-2 flex min-w-0 flex-col justify-center rounded-md border border-s-4 bg-background px-2 text-left text-xs focus-visible:ring-2 focus-visible:ring-ring ${selected?.key === key ? "border-primary" : "border-border"}`}
                title={task?.title || label(key)}
                aria-pressed={selected?.key === key}
                onClick={() => setSelectedKey(selected?.key === key ? null : key)}
              >
                <span className="flex w-full items-baseline gap-1">
                  <span className={key === "analysis" ? "shrink-0 font-medium" : "shrink-0 font-mono font-medium"}>{label(key)}</span>
                  <span className="truncate text-muted-foreground">{type}</span>
                </span>
                {status && (
                  <span className="flex items-center gap-1 font-medium" style={{ color: status.color }}
                    title={runningStage ? "交付链执行状态" : rawStatus ? "Jira 状态 · " + rawStatus : undefined}>
                    <span aria-hidden="true" className="size-2 shrink-0 rounded-full" style={{ backgroundColor: "currentColor" }} />
                    {status.label}
                  </span>
                )}
                {task?.mode === "seat" && !task.seatId && task.jiraAssignee !== undefined && (
                  <span className="w-full truncate text-muted-foreground">待匹配 · Jira 经办人 {task.jiraAssignee || "未分配"}</span>
                )}
                {task && (date?.dueDate ? (
                  <span className="text-muted-foreground">{dateLabel} <time dateTime={date.dueDate}>{date.dueDate}</time></span>
                ) : <span className="text-muted-foreground">结束日期待定</span>)}
                <span className="sr-only">前置 {dependencies.map(label).join("、") || "无"}</span>
              </button>
            );
          })}
        </div>
      </div>
      {selected && (
        <p role="status" className="text-sm">
          <span className="font-medium">{label(selected.key)}</span>
          {" · 前置 "}{selected.dependencies.map(label).join("、") || "无"}
          {" · 后续 "}{successors.map(node => label(node.key)).join("、") || "无"}
        </p>
      )}
    </figure>
  );
}
