import type { SeatMonthlyReport } from "@paperclipai/shared";

export type DashboardIssue = SeatMonthlyReport["issues"][number];
export type DashboardFilter = "all" | "attention" | "remaining" | "interrupted" | "unassigned" | DashboardIssue["risk"];
export type DeliveryCounts = ReturnType<typeof deliveryCounts>;
export const UNASSIGNED = "unassigned";
const inMonth = (issue: Pick<DashboardIssue, "inMonth" | "risk">) => issue.inMonth ?? issue.risk !== "unscheduled";

export function deliveryCounts(issues: ReadonlyArray<Pick<DashboardIssue, "risk" | "inMonth" | "completed" | "interrupted">>) {
  const counts = { total: 0, done: 0, overdue: 0, due_soon: 0, on_track: 0, unscheduled: 0, waiting_for_deadline: 0, interrupted: 0 };
  for (const issue of issues) {
    if (issue.risk === "unscheduled") counts.unscheduled++;
    if (!inMonth(issue)) continue;
    counts.total++;
    if (issue.completed ?? issue.risk === "done") counts.done++;
    else if (issue.risk === "unscheduled") counts.waiting_for_deadline++;
    else counts[issue.risk]++;
    if (issue.interrupted) counts.interrupted++;
  }
  return counts;
}

export function groupDeliveryEmployees(seats: SeatMonthlyReport["seats"], issues: DashboardIssue[]) {
  const employees = new Map<string, { id: string; name: string; seats: string[]; issues: DashboardIssue[] }>();
  const unassigned = { id: UNASSIGNED, name: "未分配负责人", seats: [], issues: [] as DashboardIssue[] };
  const employeeBySeat = new Map<string, string>();
  for (const seat of seats) {
    // Older servers supply the display name only. Keep those seats separate
    // until a stable identity can confirm that two names belong to one person.
    const id = seat.ownerUserId ? `user:${seat.ownerUserId}` : seat.ownerUserId === undefined && seat.ownerName ? `seat:${seat.id}` : null;
    if (!id) continue;
    const employee = employees.get(id) ?? { id, name: seat.ownerName ?? "姓名待核对", seats: [], issues: [] };
    employee.seats.push(seat.name);
    employees.set(id, employee);
    employeeBySeat.set(seat.id, id);
  }
  for (const issue of issues) {
    const ids = new Set(issue.seatIds.map(id => employeeBySeat.get(id)));
    ids.delete(undefined);
    if (!ids.size) unassigned.issues.push(issue);
    for (const id of ids) if (id) employees.get(id)!.issues.push(issue);
  }
  return { employees: [...employees.values()], unassigned };
}

export function needsDeliveryAttention(issue: DashboardIssue) {
  return inMonth(issue) && (Boolean(issue.interrupted) || issue.risk === "overdue" || issue.risk === "due_soon");
}

export function matchesDeliveryFilter(issue: DashboardIssue, filter: DashboardFilter, unassigned: Set<string>) {
  if (filter === "all") return inMonth(issue);
  if (filter === "done") return inMonth(issue) && (issue.completed ?? issue.risk === "done");
  if (filter === "remaining") return inMonth(issue) && !(issue.completed ?? issue.risk === "done");
  if (filter === "attention") return needsDeliveryAttention(issue);
  if (filter === "interrupted") return Boolean(issue.interrupted);
  if (filter === "unassigned") return unassigned.has(issue.id);
  return issue.risk === filter;
}

const riskRank: Record<DashboardIssue["risk"], number> = { overdue: 0, due_soon: 2, on_track: 3, done: 4, unscheduled: 5 };
const priority = (issue: Pick<DashboardIssue, "interrupted" | "risk">) => issue.interrupted && issue.risk !== "overdue" ? 1 : riskRank[issue.risk];

type PrioritizedIssue = Pick<DashboardIssue, "interrupted" | "risk" | "dueDate" | "key">;
export function compareDeliveryPriority(a: PrioritizedIssue, b: PrioritizedIssue) {
  return priority(a) - priority(b) ||
    (a.dueDate ?? "9999").localeCompare(b.dueDate ?? "9999") || a.key.localeCompare(b.key);
}

// Group after filtering; the most urgent child determines its group's position.
export function groupDeliveryMainIssues(issues: DashboardIssue[]) {
  const groups = new Map<string, { id: string; parentKey: string | null; projectName: string; issues: DashboardIssue[] }>();
  for (const issue of [...issues].sort(compareDeliveryPriority)) {
    const parentKey = issue.parentKey?.trim() || null;
    const id = JSON.stringify([issue.projectId, parentKey]);
    const group = groups.get(id) ?? { id, parentKey, projectName: issue.projectName, issues: [] };
    group.issues.push(issue);
    groups.set(id, group);
  }
  return [...groups.values()];
}
