import type { CompactIssue } from "@paperclipai/shared";
import type { RegisteredSeat } from "@/api/dsp7-seats";
import { managementConclusion, managementExecution, managementSeat } from "./issue-management";

export function managementRows(issues: CompactIssue[], seats: RegisteredSeat[], liveIds: Set<string>, unavailable: boolean | "loading" = false) {
  return issues.map(issue => {
    const seat = managementSeat(issue, seats);
    const alerts = seat?.presence?.alerts.filter(a => a.taskId === issue.id) ?? [];
    const execution = managementExecution(issue, seat, liveIds.has(issue.id), unavailable);
    const conclusion = managementConclusion(issue, execution, alerts.length > 0);
    return { issue, seat, alerts, execution, conclusion };
  }).sort((a, b) => a.conclusion.rank - b.conclusion.rank || +new Date(a.issue.updatedAt) - +new Date(b.issue.updatedAt) || a.issue.id.localeCompare(b.issue.id));
}
export type ManagementRow = ReturnType<typeof managementRows>[number];

export function filterManagementRows(rows: ManagementRow[], scope: string, projectId: string | null, userId?: string) {
  return rows.filter(({ issue, seat }) => issue.originKind !== "routine_execution"
    && (!projectId || projectId === "all" || (projectId === "__none__" ? !issue.projectId : issue.projectId === projectId))
    && (scope === "company" || !!userId && issue.assigneeUserId === userId || !!seat?.isMine && issue.assigneeAgentId === seat.agentId));
}
