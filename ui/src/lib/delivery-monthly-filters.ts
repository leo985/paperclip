import type { DeliveryMonthlyEntries } from "@paperclipai/shared";

type Item = DeliveryMonthlyEntries["items"][number];
export const monthlyFilterKeys = ["mq", "mOwner", "mStatus", "mProgress", "mSync", "mAdmission", "mWork", "mRisk", "mSort"] as const;
export const monthlyProgressViews = [
  ["all", "全部进度"], ["completed", "已完成"], ["in_progress", "进行中"], ["not_started", "未开始"], ["unknown", "待确认"],
] as const;
export type MonthlyProgress = Exclude<typeof monthlyProgressViews[number][0], "all">;
/** Qingzhou demand progress, independent of platform execution and acceptance. */
export function monthlyProgress(item: Item): MonthlyProgress {
  const status = item.sourceStatus.trim();
  if (/^(全部交付|已交付|已完成|完成|已发布|已发版|已上线|已验收|已解决|done|resolved|released)$/i.test(status)) return "completed";
  if (/^(未开始|待开始|待办|待受理|待处理|待需求分析|待分析|新建|草稿|open|todo|to do|pending|queued)$/i.test(status)) return "not_started";
  if (/^(部分交付|进行中|处理中|需求分析中|分析中|分析完成待评审|待需求评审|待评审|评审中|需求评审通过|评审通过|待拆分|待排期|待设计|设计中|待开发|开发中|编码中|待测试|测试中|待验收|验收中|待上线|待发布|需求评审不通过|评审不通过|研发打回|需求打回|JIRA工单被打回|已挂起|挂起|in_progress|in progress|running|blocked|on hold)$/i.test(status)) return "in_progress";
  return "unknown";
}
export const monthlyRiskViews = [
  ["all", "全部条目"], ["normal", "正常条目"], ["past_plan", "计划已过待核实"], ["due_week", "本周到期"],
  ["missing_owner", "责任人缺失"], ["admission", "准入待核验"], ["entry_unconfigured", "准入未配置"], ["missing_date", "计划日期缺失"],
] as const;
export type MonthlyRisk = Exclude<typeof monthlyRiskViews[number][0], "all" | "normal">;
const shanghaiDate = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit" });
export function managementToday(now = new Date()) { return shanghaiDate.format(now); }
function dayNumber(value: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const ms = Date.parse(value + "T00:00:00Z");
  return Number.isFinite(ms) && new Date(ms).toISOString().slice(0, 10) === value ? ms / 86400000 : null;
}
/** Dates are source schedule signals, never proof of delay, completion or acceptance. */
export function monthlyRisks(item: Item, now = new Date()): MonthlyRisk[] {
  const today = dayNumber(managementToday(now))!;
  const end = dayNumber(item.endDate);
  const weekday = (new Date(today * 86400000).getUTCDay() + 6) % 7;
  const flags: MonthlyRisk[] = [];
  if (end !== null && end < today) flags.push("past_plan");
  if (end !== null && end >= today && end <= today + 6 - weekday) flags.push("due_week");
  if (!item.owner.trim()) flags.push("missing_owner");
  if (item.chainAdmission?.state === "unconfigured") flags.push("entry_unconfigured");
  else if (!item.chainAdmission?.ready) flags.push("admission");
  if (end === null) flags.push("missing_date");
  return flags;
}
/** Normal means no current management signals, not formal delivery acceptance. */
export function matchesMonthlyRisk(item: Item, view: string, now = new Date()) {
  if (!view || view === "all") return true;
  const risks = monthlyRisks(item, now);
  return view === "normal" ? risks.length === 0 : risks.includes(view as MonthlyRisk);
}
export function monthlyNextAction(item: Item, now = new Date()) {
  const risks = monthlyRisks(item, now);
  if (risks.includes("missing_owner")) return "在来源中补齐责任人后同步，明确谁负责推进。";
  if (risks.includes("past_plan")) return "核对最新来源和正式交付结论，确认计划是否需要调整。";
  if (!item.snapshotId) return "同步条目，核对分析、设计和工单条件。";
  if (item.chainAdmission?.state === "unconfigured") return "在交付链设置中配置开始节点的准入检查项。";
  if (!item.chainAdmission?.ready) return "查看交付链开始节点的准入检查结果，补齐未满足条件。";
  return "查看关联工单与交付核验，按需安排下一阶段。";
}
function riskScore(item: Item, now: Date) {
  const risks = monthlyRisks(item, now);
  return (risks.includes("past_plan") ? 16 : 0) + (risks.includes("missing_owner") ? 8 : 0)
    + (risks.includes("due_week") ? 4 : 0) + (risks.some(risk => risk === "admission" || risk === "entry_unconfigured") ? 2 : 0) + (risks.includes("missing_date") ? 1 : 0);
}
// JSON encoding keeps absent source fields distinct from any real source value.
export const sourceFilterValue = (value: string) => JSON.stringify(value.trim());
export function monthlyAdmission(item: Item) {
  return item.chainAdmission?.ready ? "verified" : item.chainAdmission?.state === "unconfigured" ? "unconfigured" : item.snapshotId ? "unchecked" : "unsynced";
}
export const monthlySelectedStatuses = (params: URLSearchParams) => [...new Set(params.getAll("mStatus").filter(Boolean))];
export function filterMonthlyEntries(items: Item[], params: URLSearchParams, now = new Date()) {
  const statuses = monthlySelectedStatuses(params);
  const q = (params.get("mq") ?? "").trim().toLocaleLowerCase();
  return items.filter(item => {
    const owner = params.get("mOwner");
    const sync = params.get("mSync"), admission = params.get("mAdmission"), work = params.get("mWork");
    return (!q || `${item.demandNo} ${item.title} ${item.owner}`.toLocaleLowerCase().includes(q))
      && (!owner || sourceFilterValue(item.owner) === owner)
      && (!statuses.length || statuses.includes(sourceFilterValue(item.sourceStatus)))
      && (!params.get("mProgress") || params.get("mProgress") === "all" || monthlyProgress(item) === params.get("mProgress"))
      && (sync !== "saved" || !!item.snapshotId) && (sync !== "unsynced" || !item.snapshotId)
      && (!["verified", "unchecked", "unsynced", "unconfigured"].includes(admission ?? "") || monthlyAdmission(item) === admission)
      && (work !== "has" || item.workCount > 0) && (work !== "none" || item.workCount === 0)
      && matchesMonthlyRisk(item, params.get("mRisk") ?? "", now);
  }).sort((a, b) => {
    const sort = params.get("mSort") ?? "risk";
    const risk = sort === "risk" ? riskScore(b, now) - riskScore(a, now) : 0;
    const date = sort === "start" ? "startDate" : "endDate";
    const aDay = dayNumber(a[date]), bDay = dayNumber(b[date]);
    return risk || (aDay ?? Infinity) - (bDay ?? Infinity) || a.demandNo.localeCompare(b.demandNo);
  });
}
export function monthlySourceOptions(items: Item[], field: "owner" | "sourceStatus") {
  return [...new Set(items.map(item => item[field].trim()))].sort((a, b) => a.localeCompare(b, "zh-CN"))
    .map(value => ({ key: sourceFilterValue(value), value: sourceFilterValue(value), label: value || "来源未提供" }));
}
export function monthlyDetailHref(params: URLSearchParams, projectId: string, snapshotId: string, month: string) {
  const next = new URLSearchParams(params);
  next.set("projectId", projectId); next.set("snapshotId", snapshotId); next.set("month", month);
  next.delete("view"); next.delete("tab");
  return "/delivery?" + next;
}
