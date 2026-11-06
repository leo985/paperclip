import type { DeliveryEntryDetail, DeliveryPlan, DeliveryWorkItem } from "@paperclipai/shared";
export type DeliveryLinkedTask = DeliveryEntryDetail["tasks"][number];
export type DispatchView = "pending" | "linked" | "ended" | "all";
export const supportsDeliveryDispatch = (item: DeliveryWorkItem) => ["编码", "前端编码", "系统设计", "系统设计补充"].includes(item.type);
// Only explicit source terminal states are hidden by default. Parent completion
// and missing source status never imply that the child has finished.
export const sourceWorkEnded = (status: string) => /^(已完成|已关闭|已发布|已发版|完成|关闭|已解决|已取消|取消|已作废|作废|done|closed|resolved|released|cancelled|canceled|void)$/i.test(status.trim());
export function deliveryDispatchRows(plan: DeliveryPlan, tasks: DeliveryLinkedTask[]) {
  return plan.items.filter(item => !!item.parentKey).map(item => {
    const linked = tasks.filter(task => task.jiraKey === item.key);
    const ended = sourceWorkEnded(item.status);
    const supported = supportsDeliveryDispatch(item);
    return { item, linked, ended, supported, pending: supported && !ended && !linked.length };
  });
}
export function matchesDispatchView(row: ReturnType<typeof deliveryDispatchRows>[number], view: DispatchView) {
  return view === "all" || (view === "pending" && row.pending) || (view === "linked" && !!row.linked.length) || (view === "ended" && row.ended);
}
export const deliveryTaskStates: Record<string, string> = { backlog:"待安排",todo:"待执行",in_progress:"处理中",in_review:"待评审",blocked:"存在阻塞",done:"已完成",cancelled:"已取消" };
export const deliveryRunStates: Record<string, string> = { queued:"排队中",running:"运行中",scheduled_retry:"等待重试",succeeded:"运行结束",failed:"运行失败",cancelled:"运行已停止",timed_out:"运行超时" };

export const workStatusValue = (status: string) => JSON.stringify(status.trim());
export function workStatusOptions(items: DeliveryWorkItem[]) {
  return [...new Set(items.map(item => item.status.trim()))].sort((a,b)=>a.localeCompare(b,"zh-CN"))
    .map(status=>({value:workStatusValue(status),label:status||"来源未提供"}));
}
