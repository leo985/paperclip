import type { DeliveryWorkflowInbox, AnalysisPendingAction, AttentionItem } from "@paperclipai/shared";
import type { RegisteredSeat } from "@/api/dsp7-seats";
import type { ManagementRow } from "./management-work";

export const WORKBENCH_TABS = ["pending", "following", "organization", "notifications", "diagnostics"] as const;
export type WorkbenchTab = typeof WORKBENCH_TABS[number];
export type WorkbenchActionKind = "question" | "review" | "approval" | "recovery" | "local" | "assignment" | "work";
export interface WorkbenchAction {
  id: string;
  kind: WorkbenchActionKind;
  title: string;
  reason: string;
  actionLabel: string;
  href: string;
  createdAt: string;
  ownerUserId: string | null;
  taskId?: string;
  row?: ManagementRow;
  affectedTasks?: ManagementRow[];
}

export function workbenchTab(params: URLSearchParams, canManage: boolean): WorkbenchTab {
  const requested = params.get("tab");
  if (requested === "organization" || requested === "diagnostics") return canManage ? requested : "pending";
  if (requested === "following" || requested === "notifications" || requested === "pending") return requested;
  return canManage && params.get("scope") === "company" ? "organization" : "pending";
}

/** Preserve company routing in Navigate and retain old project/filter/deep-link context. */
export function legacyInboxTarget(pathname: string, search: string, hash = "") {
  const params = new URLSearchParams(search);
  const previous = pathname.split("/").pop();
  if (!params.has("tab")) params.set("tab", previous === "recent" || previous === "unread" || previous === "all" ? "notifications" : params.get("scope") === "company" ? "organization" : "pending");
  if (previous === "blocked" && !params.has("action")) params.set("action", "recovery");
  if (!params.has("action") && params.has("attention")) {
    const legacy = params.get("attention");
    const mapped = legacy === "waiting" ? "question" : legacy === "local" ? "local" : legacy === "unassigned" ? "assignment" : legacy === "error" || legacy === "offline" ? "recovery" : "all";
    params.set("action", mapped);
  }
  if (["mine", "recent", "unread", "all", "blocked"].includes(previous ?? "")) params.set("legacyTab", previous!);
  return `/dashboard?${params}${hash}`;
}

const sourceKind: Partial<Record<AttentionItem["sourceKind"], WorkbenchActionKind>> = {
  approval: "approval", decision: "review", issue_thread_interaction: "question",
  join_request: "approval", recovery_action: "recovery", review: "review", blocker_attention: "recovery",
};

/** Pure projection: being abnormal is not enough to create an actionable todo. */
export function workbenchActions(input: {
  rows: ManagementRow[];
  seats: RegisteredSeat[];
  analysis: AnalysisPendingAction[];
  platform: AttentionItem[];
  delivery?: DeliveryWorkflowInbox;
  scope: "mine" | "company";
  userId?: string;
  projectId?: string | null;
  executionEvidenceReady: boolean;
}) {
  const { rows, seats, analysis, platform, scope, userId, projectId, executionEvidenceReady } = input;
  const actions: WorkbenchAction[] = [];
  const rowById = new Map(rows.map(row => [row.issue.id, row]));
  const covered = new Set<string>();
  const projectMatches = (id: string | null | undefined) => !projectId || projectId === "all" || (projectId === "__none__" ? !id : id === projectId);
  const ownerFor = (row: ManagementRow) => row.issue.assigneeUserId ?? (row.issue.assigneeAgentId === row.seat?.agentId ? row.seat?.owner?.id : null) ?? null;
  const taskHref = (row: ManagementRow) => `/issues/${row.issue.identifier ?? row.issue.id}`;
  const addTask = (row: ManagementRow, kind: WorkbenchActionKind, label: string) => {
    actions.push({ id: `task:${row.issue.id}`, kind, title: row.issue.title, reason: row.execution.reason,
      actionLabel: label, href: taskHref(row), createdAt: String(row.issue.updatedAt),
      ownerUserId: ownerFor(row), taskId: row.issue.id, row });
    covered.add(row.issue.id);
  };

  const managed = new Set(input.delivery?.managedTaskIds ?? []);
  for (const item of input.delivery?.actions ?? []) {
    if(!projectMatches(item.projectId) || scope === "mine" && item.ownerUserId !== userId)continue;
    actions.push({id:item.id,kind:item.kind==="work"?"work":item.kind==="answer"?"question":item.kind==="confirm-start"?"local":item.kind==="accept"?"approval":item.kind,
      title:item.title,reason:item.reason,actionLabel:item.actionLabel,href:item.href,createdAt:item.createdAt,ownerUserId:item.ownerUserId,taskId:item.taskId,row:item.taskId?rowById.get(item.taskId):undefined});
    if(item.taskId)covered.add(item.taskId);
  }
  const versions = new Set<string>();
  for (const item of analysis) {
    if (!projectMatches(item.projectId) || scope === "mine" && item.ownerUserId !== userId) continue;
    const version = `${item.taskId}:${item.runId}:${item.key}`;
    if (versions.has(version)) continue;
    versions.add(version);
    const row = rowById.get(item.taskId);
    actions.push({ id: `analysis:${item.id}`, kind: item.kind, title: item.title, reason: item.prompt,
      actionLabel: item.kind === "review" ? "评审分析结果" : "回答业务问题", href: `/issues/${row?.issue.identifier ?? item.taskId}`,
      createdAt: item.createdAt, ownerUserId: item.ownerUserId, taskId: item.taskId, row });
    covered.add(item.taskId);
  }
  for (const item of platform) {
    const kind = sourceKind[item.sourceKind];
    const taskId = item.relatedIssue?.id;
    if(taskId && managed.has(taskId))continue;
    const row = taskId ? rowById.get(taskId) : undefined;
    const addressee = item.resolverAudience?.addresseeUserId;
    // An explicit recipient overrides task ownership. Unassigned organization approvals
    // belong to the organization view, never to every administrator's personal inbox.
    if (!kind || !projectMatches(item.project?.id ?? row?.issue.projectId)) continue;
    if (scope === "mine" && ((taskId && !row) || (addressee ? addressee !== userId : !row))) continue;
    if (item.resolverAudience?.addresseeAgentId && !addressee) continue;
    if (taskId && covered.has(taskId) && ["review", "blocker_attention"].includes(item.sourceKind)) continue;
    const href = item.subject.href ?? (row ? taskHref(row) : null);
    if (!href) continue;
    actions.push({ id: `platform:${item.id}`, kind, title: item.subject.title ?? row?.issue.title ?? "组织待处理事项",
      reason: item.detail?.kind === "generic" ? item.detail.summaryExcerpt ?? item.whyNow : item.whyNow,
      actionLabel: kind === "approval" ? "查看并审批" : kind === "recovery" ? "核对恢复条件" : "查看待决定事项",
      href, createdAt: item.createdAt, ownerUserId: addressee ?? (row ? ownerFor(row) : null), taskId, row });
    if (taskId) covered.add(taskId);
  }
  // Unknown/loading states are watch items. An offline seat creates one incident,
  // even when it affects several active tasks. Nothing here starts/stops a process.
  if (executionEvidenceReady) {
    const offline = new Map<string, ManagementRow[]>();
    for (const row of rows) {
      if (covered.has(row.issue.id) || managed.has(row.issue.id)) continue;
      const { execution, issue, seat } = row;
      if (execution.kind === "offline") {
        if (seat && (scope === "company" || seat.isMine || seat.owner?.id === userId) && ["in_progress", "in_review", "blocked"].includes(issue.status)) {
          offline.set(seat.agentId, [...(offline.get(seat.agentId) ?? []), row]);
        }
        continue;
      }
      if (execution.kind === "local" && (scope === "company" || seat?.isMine || seat?.owner?.id === userId)) addTask(row, "local", "检查本机连接");
      else if (execution.kind === "error") addTask(row, "recovery", "查看原因与恢复条件");
      else if (execution.kind === "waiting" && !issue.deliveryStages?.includes("analysis")) addTask(row, "question", "查看待决定问题");
      else if (issue.status === "blocked") addTask(row, "recovery", "核对阻塞并处理");
      else if (scope === "company" && !issue.assigneeAgentId && !issue.assigneeUserId && !["done", "cancelled"].includes(issue.status)) addTask(row, "assignment", "安排任务负责人");
    }
    for (const [seatId, affectedTasks] of offline) {
      const seat = seats.find(s => s.agentId === seatId)!;
      actions.push({ id: `seat:${seatId}:offline`, kind: "recovery", title: `检查 ${seat.name} 的连接`,
        reason: `席位离线，影响 ${affectedTasks.length} 个活动任务。请核对电脑与连接；离线不证明进程已停止。`,
        actionLabel: "检查席位连接", href: `/seats?seat=${seatId}`, createdAt: seat.presence?.lastSeenAt ?? String(affectedTasks[0].issue.updatedAt),
        ownerUserId: seat.owner?.id ?? null, affectedTasks });
    }
  }
  const unique = [...new Map(actions.map(action => [action.id, action])).values()];
  return unique.sort((a, b) => +new Date(a.createdAt) - +new Date(b.createdAt) || a.id.localeCompare(b.id));
}
