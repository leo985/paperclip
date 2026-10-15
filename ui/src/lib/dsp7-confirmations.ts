/** Display-only workflow receipts. This never grants execution permission. */
export function isDsp7ConfirmationMessage(body: string): boolean {
  return /^#?JCONF-[A-Z0-9-]+(?:\s|$)/.test(body.trim().replace(/^\\#/, "#"));
}

type Receipt = { status: string; message: string; confirmation: string; runId?: string | null };
const statuses = new Set(["submitted", "invalid", "approved", "rejected", "waiting_terminal", "resuming", "completed"]);

export function readDsp7Receipts(description: string | null | undefined): Record<string, Receipt> {
  const raw = description?.match(/<!-- DSP7-CONFIRMATION-STATUS (.*?) -->/)?.[1];
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    if (parsed.version !== 1 || parsed.source !== "dsp7_bridge" || !parsed.comments || typeof parsed.comments !== "object") return {};
    return Object.fromEntries(Object.entries(parsed.comments).filter(([, value]) => {
      const receipt = value as Receipt | null;
      return receipt && statuses.has(receipt.status) && typeof receipt.message === "string" && typeof receipt.confirmation === "string" && (receipt.runId == null || typeof receipt.runId === "string");
    })) as Record<string, Receipt>;
  } catch { return {}; }
}

export function projectDsp7Comment<T extends { id: string; body: string; authorUserId?: string | null; authorAgentId?: string | null; clientStatus?: string; deletedAt?: unknown }>(
  comment: T, description: string | null | undefined, enabled: boolean,
) {
  const receipt = readDsp7Receipts(description)[comment.id];
  if ((!enabled && !receipt) || !comment.authorUserId || comment.authorAgentId || comment.deletedAt || !isDsp7ConfirmationMessage(comment.body)) return null;
  const label = receipt?.message ?? (comment.clientStatus === "pending" ? "正在提交审批" : "已提交，等待核验");
  const run = receipt?.runId ? ` · Run ${receipt.runId.slice(0, 8)}` : "";
  return {
    ...comment,
    body: `${comment.body}\n\n审批状态：${label}${run}`,
    clientStatus: undefined,
    queueState: undefined,
    queueTargetRunId: null,
    queueReason: undefined,
    followUpRequested: false,
  };
}
