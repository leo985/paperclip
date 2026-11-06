import type { HeartbeatRun } from "@paperclipai/shared";

/** Only the allowlisted run context identity is used; bodies and excerpts stay out of summaries. */
export function runIssueId(run: Pick<HeartbeatRun, "contextSnapshot">) {
  const context = run.contextSnapshot;
  const value = context?.issueId ?? context?.taskId;
  return typeof value === "string" && value.trim() ? value : null;
}
