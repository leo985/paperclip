import { describe, expect, it } from "vitest";
import type { CompactIssue } from "@paperclipai/shared";
import type { RegisteredSeat } from "@/api/dsp7-seats";
import { managementConclusion, managementExecution, managementSeat, managementViewMatches, seatReadiness } from "./issue-management";
import { filterManagementRows, managementRows } from "./management-work";
import { runIssueId } from "./management-runs";

const issue = { id: "task-1", status: "in_progress", title: "权限管理", projectId: "project-1", assigneeAgentId: "seat-1", assigneeUserId: null, updatedAt: new Date("2026-10-27"), originKind: "issue" } as unknown as CompactIssue;
function seat(overrides: Partial<RegisteredSeat> = {}): RegisteredSeat {
  return {
    agentId: "seat-1", name: "研发电脑", online: true, isMine: true, usable: true,
    owner: { id: "user-1", name: "研发负责人", email: "dev@example.com" },
    runtime: { revision: 1 } as RegisteredSeat["runtime"],
    dispatch: { enabled: true, projectId: "project-1", workspaceId: "workspace-1", jiraPatConfigured: true, readyStatuses: ["开发中"], issueTypes: ["编码"] } as RegisteredSeat["dispatch"],
    presence: { state: "idle", activeTaskId: null, checks: [], alerts: [], tasks: [{ taskId: issue.id, jiraKey: "DEV-1", status: "in_progress", mode: "formal", ready: true, automatic: true, stoppedRunId: "old-run" }] } as unknown as RegisteredSeat["presence"],
    ...overrides,
  } as RegisteredSeat;
}

describe("shared management conclusions", () => {
  it("does not call a business in-progress task running without execution evidence", () => {
    const execution = managementExecution(issue, undefined, false);
    expect(execution.kind).toBe("unknown");
    expect(managementConclusion(issue, execution).group).toBe("unknown");
    expect(managementViewMatches("running", issue, execution)).toBe(false);
    expect(managementViewMatches("attention", issue, execution)).toBe(true);
  });
  it("puts an interrupted idle-seat task in attention rather than running or queued", () => {
    const rows = managementRows([issue], [seat()], new Set());
    expect(rows[0].execution.kind).toBe("error");
    expect(rows[0].conclusion.group).toBe("attention");
    expect(managementViewMatches("running", issue, rows[0].execution)).toBe(false);
    expect(managementViewMatches("pending", issue, rows[0].execution)).toBe(false);
  });
  it("allows a current online active execution to supersede an old stopped run", () => {
    const current = seat(); current.presence = { ...current.presence!, state: "busy", activeTaskId: issue.id, runId: "new-run" };
    expect(managementExecution(issue, current, true).kind).toBe("running");
    expect(managementRows([issue], [current], new Set([issue.id]))[0].conclusion.group).toBe("running");
  });
  it("keeps a business blocker or task reminder out of the healthy-running group", () => {
    const current = seat(); current.presence = { ...current.presence!, state: "busy", activeTaskId: issue.id, alerts: [{ id: "alert-1", taskId: issue.id, jiraKey: "DEV-1", level: "warning", message: "需要核对", elapsedMinutes: 20 }] };
    const rows = managementRows([issue], [current], new Set([issue.id]));
    expect(rows).toHaveLength(1); expect(rows[0].alerts).toHaveLength(1);
    expect(rows[0].execution.kind).toBe("running"); expect(rows[0].conclusion.group).toBe("attention");
    expect(managementViewMatches("running", issue, rows[0].execution, true)).toBe(false);
    expect(managementConclusion({ ...issue, status: "blocked" }, rows[0].execution).group).toBe("attention");
  });
  it("treats offline data and read failures as uncertainty rather than proof of stopped processes", () => {
    expect(managementExecution(issue, seat({ online: false }), true).kind).toBe("offline");
    expect(managementExecution(issue, seat(), false, true).kind).toBe("unknown");
    expect(managementConclusion(issue, managementExecution(issue, seat({ online: false }), false)).nextAction).toContain("不证明进程已停止");
  });
  it("detects ended tasks that still have live execution, without reopening them", () => {
    const ended = { ...issue, status: "done" as const };
    expect(managementExecution(ended, undefined, true).label).toBe("结束状态待核对");
    expect(managementConclusion(ended, managementExecution(ended, seat(), false)).group).toBe("settled");
    expect(ended.status).toBe("done");
  });
  it("selects the current seat over a stale registration and respects scope and project filters", () => {
    const stale = seat({ agentId: "seat-old" }), current = seat();
    current.presence = { ...current.presence!, activeTaskId: issue.id, state: "busy" };
    expect(managementSeat(issue, [stale, current])?.agentId).toBe("seat-1");
    const rows = managementRows([issue, { ...issue, id: "other", projectId: null, assigneeAgentId: "other-seat" }], [current], new Set());
    expect(filterManagementRows(rows, "mine", "project-1", "user-1").map(r => r.issue.id)).toEqual([issue.id]);
    expect(filterManagementRows(rows, "company", "__none__").map(r => r.issue.id)).toEqual(["other"]);
    const reassigned = managementRows([{ ...issue, assigneeAgentId: "new-owner-seat" }], [stale], new Set());
    expect(filterManagementRows(reassigned, "mine", null, "user-1")).toHaveLength(0);
  });
  it("keeps direct human assignments in Mine without requiring a seat", () => {
    const rows = managementRows([{ ...issue, assigneeAgentId: null, assigneeUserId: "user-1" }], [], new Set());
    expect(filterManagementRows(rows, "mine", null, "user-1")).toHaveLength(1);
    expect(filterManagementRows(rows, "mine", null, "other-user")).toHaveLength(0);
  });
  it("does not equate online/idle with configured readiness", () => {
    const value = seat({ dispatch: null });
    expect(seatReadiness(value).ready).toBe(false); expect(seatReadiness(value).reasons).toContain("平台接单规则未启用");
    expect(seatReadiness(seat()).ready).toBe(true);
    const paused = seat(); paused.presence = { ...paused.presence!, acceptingWork: false };
    expect(seatReadiness(paused).ready).toBe(false);
  });
  it("extracts only explicit run task identities and ignores arbitrary result text", () => {
    expect(runIssueId({ contextSnapshot: { issueId: "task-1", taskId: "fallback" } })).toBe("task-1");
    expect(runIssueId({ contextSnapshot: { taskId: "legacy" } })).toBe("legacy");
    expect(runIssueId({ contextSnapshot: { summary: "task-1", issueId: 42 } })).toBeNull();
    expect(runIssueId({ contextSnapshot: null })).toBeNull();
  });
});
