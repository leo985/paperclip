import { describe, expect, it } from "vitest";
import {
  shouldAutoCheckoutIssueForWake,
} from "../services/heartbeat.ts";

describe("shouldAutoCheckoutIssueForWake", () => {
  it.each(["backlog", "todo", "in_progress", "blocked", "in_review", "done", "cancelled"])("keeps validation checkout scoped for %s", status => {
    expect(shouldAutoCheckoutIssueForWake({
      contextSnapshot: { wakeReason: "Harness 隔离验证授权启动", harnessValidationDispatchId: "dispatch" },
      issueStatus: status, issueAssigneeAgentId: "agent", isDependencyReady: true, agentId: "agent",
    })).toBe(["backlog", "todo", "in_progress"].includes(status));
  });
  it("preserves ordinary blocked task checkout", () => {
    expect(shouldAutoCheckoutIssueForWake({
      contextSnapshot: { wakeReason: "issue_assigned" }, issueStatus: "blocked",
      issueAssigneeAgentId: "agent", isDependencyReady: true, agentId: "agent",
    })).toBe(true);
  });

  it("auto-checks out an assigned todo issue for an actionable wake", () => {
    expect(shouldAutoCheckoutIssueForWake({
      contextSnapshot: { wakeReason: "issue_assigned" },
      issueStatus: "todo",
      issueAssigneeAgentId: "agent-1",
      isDependencyReady: true,
      agentId: "agent-1",
    })).toBe(true);
  });

  it("leaves an idle review issue in review without an actionable wake", () => {
    expect(shouldAutoCheckoutIssueForWake({
      contextSnapshot: {},
      issueStatus: "in_review",
      issueAssigneeAgentId: "agent-1",
      isDependencyReady: true,
      agentId: "agent-1",
    })).toBe(false);
  });

  it("does not auto-checkout pending execution-review state even if the row status is todo", () => {
    const reviewerAgentId = "11111111-1111-4111-8111-111111111111";
    const coderAgentId = "22222222-2222-4222-8222-222222222222";
    expect(shouldAutoCheckoutIssueForWake({
      contextSnapshot: { wakeReason: "issue_recovery_action_restored" },
      issueStatus: "todo",
      issueAssigneeAgentId: reviewerAgentId,
      issueExecutionState: {
        status: "pending",
        currentStageId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        currentStageIndex: 0,
        currentStageType: "review",
        currentParticipant: { type: "agent", agentId: reviewerAgentId },
        returnAssignee: { type: "agent", agentId: coderAgentId },
        reviewRequest: null,
        completedStageIds: [],
        lastDecisionId: null,
        lastDecisionOutcome: null,
      },
      isDependencyReady: true,
      agentId: reviewerAgentId,
    })).toBe(false);
  });
});
