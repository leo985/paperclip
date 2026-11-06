export interface DeliveryPhaseTiming {
  name: string | null;
  executingMs: number; waitingMs: number; unknownMs: number;
  /** Cost events are run-scoped; do not split token totals by elapsed time. */
  tokenAttribution: "unavailable";
}
export type DeliveryDomain = "analysis" | "development" | "qa" | "unknown";
export interface DeliveryUsage {
  runs: number; measuredRuns: number; finalRuns: number;
  inputTokens: number | null; outputTokens: number | null; cachedInputTokens: number | null;
  /** Cost event deltas, never CLI model estimates. */
  reportedCostCents: number | null; unpricedRuns: number;
}
export interface DeliveryTaskInsight {
  taskId: string; identifier: string | null; title: string; projectId: string | null;
  seatId: string | null; ownerUserId: string | null; historicalOwners: string[];
  status: string; isLeaf: boolean; simulated: boolean; domains: DeliveryDomain[];
  state: "executing" | "waiting" | "unknown" | "stopped" | "not_observed";
  stateSince: string | null;
  phase: { name: string; status: string; at: string; gateEvidence: boolean } | null;
  phaseTimings?: DeliveryPhaseTiming[];
  conversation: { sessions: number; gaps: number; finalized: number; unavailable: number };
  executingMs: number; waitingMs: number; unknownMs: number;
  usage: DeliveryUsage;
  linkedDefects: number | null;
}
export interface DeliverySeatInsight {
  seatId: string; name: string; ownerUserId: string | null; ownerName: string | null;
  currentOpen: number; started: number; delivered: number; cancelled: number; runs: number;
  executingMs: number; waitingMs: number; unknownMs: number; idleMs: number | null;
  usage: DeliveryUsage;
  quality: { linkedDefects: number | null; matureEligible: number; measuredMature: number; affectedMature: number; observedDefectRate: number | null; coverage: number | null; attributedBugRate: null };
}
export interface DeliveryInsights {
  methodologyVersion: "delivery-insights-v1"; generatedAt: string; timezone: "Asia/Shanghai";
  from: string; to: string; simulatedExcluded: true;
  tasks: DeliveryTaskInsight[]; totalTasks: number; page: number; pageSize: number;
  seats: DeliverySeatInsight[];
  totals: { currentOpen: number; started: number; delivered: number; cancelled: number; usage: DeliveryUsage };
  options: { seats: { id: string; name: string }[]; owners: { id: string; name: string }[] };
  completeness: { sessionsWithGaps: number; tasksWithoutSessions: number; unclassifiedTasks: number; tracker: "not_integrated"; confirmedDefectAttribution: "not_integrated" };
  notes: string[];
}
export interface DeliveryAcceptance {
  snapshotId: string; demandNo: string; title: string; sourceMode: string; collectedAt: string;
  mainCount: number; childCount: number; differences: number;
  checks: { key: string; label: string; status: "recorded" | "attention" | "unverified"; detail: string }[];
  readyForAcceptance: null; formalAcceptance: "unverified";
  sourceUrl: "https://proj.fingard.com:1888";
}
