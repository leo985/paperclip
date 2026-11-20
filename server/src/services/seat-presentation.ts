/** Shared identity and heartbeat display rules for seat pickers and management. */
export function seatDisplayName(agentName: string, seat: Record<string, unknown> | undefined): string {
  return typeof seat?.name === "string" && seat.name.trim() ? seat.name : agentName;
}

export function isSeatOnline(presence: Record<string, unknown> | undefined, now = Date.now()): boolean {
  const seen = Date.parse(String(presence?.lastSeenAt));
  return Number.isFinite(seen) && seen <= now + 5000 && now - seen < 90000;
}
