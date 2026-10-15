import { i18n } from "./index";

/** Translate application-owned display text only. Never pass user content,
 * API values, code, commands, task descriptions or run transcripts here.
 * A missing entry returns the original text to keep third-party labels intact.
 */
export function uiText(text: string): string {
  return i18n.t(text, {
    ns: "interface",
    keySeparator: false,
    nsSeparator: false,
    defaultValue: text,
  });
}

const statusLabels: Record<string, string> = {
  backlog: "Backlog", todo: "Todo", in_progress: "In progress", in_review: "In review",
  blocked: "Blocked", done: "Done", cancelled: "Cancelled", canceled: "Cancelled",
  active: "Active", idle: "Idle", running: "Running", paused: "Paused", error: "Error",
  terminated: "Terminated", queued: "Queued", succeeded: "Succeeded", failed: "Failed",
  timed_out: "Timed out", scheduled_retry: "Scheduled retry", waiting: "Waiting",
  interrupted: "Interrupted", revision_requested: "Revision requested",
  pending: "Pending", approved: "Approved", rejected: "Rejected", expired: "Expired",
  revoked: "Revoked", enabled: "Enabled", disabled: "Disabled", archived: "Archived",
  critical: "Critical", high: "High", medium: "Medium", low: "Low",
  draft: "Draft", open: "Open", closed: "Closed", completed: "Completed",
  planned: "Planned", achieved: "Achieved", abandoned: "Abandoned", unknown: "Unknown",
};

export function localizedStatus(input: string | number | null | undefined): string {
  const value = input == null ? "" : String(input);
  return uiText(statusLabels[value] ?? value.replace(/[_-]/g, " ").replace(/^\w/, c => c.toUpperCase()));
}

/** Localize an application-owned template while preserving each runtime value verbatim. */
export function uiTextFormat(text: string, values: unknown[]): string {
  return uiText(text).replace(/__PCVAR(\d+)__/g, (token, index: string) => Number(index) < values.length ? String(values[Number(index)]) : token);
}

/** Translate known system roles only; custom roles keep their original value. */
export function localizedRole(value: string | null | undefined): string {
  const roles: Record<string, string> = { owner: "Organization owner", admin: "Organization administrator", operator: "Development member", member: "Development member", viewer: "Observer", ceo: "Chief executive officer", cto: "Chief technology officer", cmo: "Chief marketing officer", cfo: "Chief financial officer", security: "Security", engineer: "Engineer", designer: "Designer", pm: "Product manager", qa: "Quality assurance", devops: "DevOps", researcher: "Researcher", general: "General" };
  return value && roles[value] ? uiText(roles[value]) : value ?? "";
}
