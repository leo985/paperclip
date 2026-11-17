/** Validation starts explicitly from backlog; blocked work needs its own recovery. */
export const HARNESS_VALIDATION_READY_STATUSES = ["backlog", "todo", "in_progress"];

export function nativeWakeCheckoutStatuses(context: Record<string, unknown> | null | undefined) {
  return context?.harnessValidationDispatchId != null
    ? ["todo", "backlog"]
    : ["todo", "backlog", "blocked"];
}
