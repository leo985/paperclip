export interface SeatRunControl {
  runId: string;
  mode: "legacy" | "observed_cost" | "not_applicable";
  stopStatus: "running" | "pending" | "verified";
  meteringStatus: "unknown" | "partial_observation" | "final_reported";
  tokens: { inputTokens: number; outputTokens: number; cachedInputTokens: number } | null;
  costStatus: "unpriced" | "reported";
  observedAt: string | null;
  route: { kind: string; repository: string; profile: string; commit: string } | null;
}
