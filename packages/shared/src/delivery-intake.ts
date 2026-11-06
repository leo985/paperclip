import type { DeliveryAdmission, DeliveryChainAdmission } from "./delivery-connections.js";

/** Read-only snapshot contract. Saving never grants an execution authorization. */
export interface DeliverySnapshotInput {
  projectId: string;
  sourceOrigin: string;
  demandNo: string;
  collectedAt: string;
  demandJson: string;
  analysisJson: string;
  /** Optional for legacy manual snapshots; raw UC_PROJ2_DEMAND_DETAIL response. */
  detailJson?: string;
  scheduleJsons: string[];
  jiraJson: string;
}
export interface DeliveryWorkItem {
  key: string;
  parentKey: string | null;
  title: string;
  type: string;
  status: string;
  assignee: string;
  scheduled: boolean;
}
export interface DeliveryPlan {
  demandId: string;
  demandNo: string;
  title: string;
  status: string;
  /** Source facts only; never grants admission or formal delivery verification. */
  sourceAnalysis?: {
    sourceStatus: string;
    analysisSaved: boolean | null;
    reviewStages: { role: string; status: string }[];
  };
  roles: { label: string; name: string }[];
  mains: { key: string; sourceId: string; title: string }[];
  items: DeliveryWorkItem[];
  scheduleCount: number;
  differences: { code: string; key: string; message: string }[];
  fingerprint: string;
  sourceMode: "manual_snapshot" | "online_readonly";
  executionAllowed: false;
}
export interface DeliverySnapshot {
  id: string;
  projectId: string;
  sourceOrigin: string;
  demandNo: string;
  collectedAt: string;
  createdAt: string;
  plan: DeliveryPlan;
}

export interface DeliverySnapshotComparison {
  baselineId: string;
  snapshotId: string;
  demandNo: string;
  baselineCollectedAt: string;
  collectedAt: string;
  sourceModeChanged: boolean;
  changes: { key: string; field: string; before: string | null; after: string | null }[];
  executionAllowed: false;
}

/** Aggregates saved source versions; none of these reads grant execution. */
export interface DeliveryEntryList {
  items: DeliverySnapshot[];
  hasMore: boolean;
}
export interface DeliveryEntryDetail {
  snapshot: DeliverySnapshot;
  admission: DeliveryAdmission;
  chainAdmission?: DeliveryChainAdmission;
  analyses: { id: string; title: string; state: string; revision: number; activeRunId: string | null; updatedAt: string }[];
  tasks: { id: string; jiraKey: string; title: string; status: string; runStatus: string | null; updatedAt: string }[];
}
