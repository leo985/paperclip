import type { DeliveryCounts } from "@/lib/delivery-dashboard";

export const deliveryProgressSegments = [
  { state: "done", color: "bg-delivery-done", backgroundColor: "var(--status-task-done)" },
  { state: "overdue", color: "bg-destructive", backgroundColor: "var(--destructive)" },
  { state: "due_soon", color: "bg-delivery-soon", backgroundColor: "var(--status-task-icon-todo)" },
  { state: "on_track", color: "bg-delivery-open", backgroundColor: "var(--chart-2)" },
  { state: "waiting_for_deadline", color: "bg-border", backgroundColor: "var(--border)" },
] as const;

export function DeliveryProgressBar({ counts, label, large = false, emptyLabel }: {
  counts: DeliveryCounts;
  label: string;
  large?: boolean;
  emptyLabel: string;
}) {
  return <div
    role="progressbar"
    aria-label={label}
    aria-valuemin={counts.total ? 0 : undefined}
    aria-valuemax={counts.total || undefined}
    aria-valuenow={counts.total ? counts.done : undefined}
    aria-valuetext={counts.total ? `已完成 ${counts.done} / ${counts.total}，逾期 ${counts.overdue}，7 天内到期 ${counts.due_soon}` : emptyLabel}
    className={`flex w-full overflow-hidden rounded-full bg-muted ${large ? "h-4" : "h-2.5"}`}
  >
    {deliveryProgressSegments.map(({ state, backgroundColor }) => counts[state] > 0 &&
      <span key={state} aria-hidden="true" style={{ flexGrow: counts[state], backgroundColor }} className="basis-0" />)}
  </div>;
}
