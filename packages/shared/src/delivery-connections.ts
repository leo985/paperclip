import type { DeliveryEntryCheck, DeliveryTemplateSnapshot } from "./delivery-templates.js";
import type { DeliveryStage } from "./delivery-workflows.js";

export interface DeliveryChainAdmission {
  state: "unconfigured" | "blocked" | "ready" | "admitted";
  ready: boolean;
  template: DeliveryTemplateSnapshot | null;
  startStage: DeliveryStage | null;
  checks: { key: DeliveryEntryCheck; label: string; passed: boolean }[];
  reasons: string[];
}
export const DELIVERY_CHAIN_ADMISSION_LABELS = {unconfigured:"未配置准入",blocked:"准入条件未满足",ready:"可进入交付链",admitted:"已准入"} as const;
export interface DeliveryConnection {
  id: string; projectId: string; jiraAgentId: string | null; jiraBaseUrl: string; jiraCredentialsConfigured: boolean; jiraConnectionMode: "project" | "legacy_seat"; organizationId: string; revision: number;
  credentialsConfigured: boolean; lastCheckStatus: string; lastCheckedAt: string | null;
  /** Saved Qingzhou login name, visible to organization administrators. */
  qingzhouUsername?: string;
  /** When set, monthly intake uses the product's expected delivery month across organizations. */
  subProductAttribution?: string | null;
}

export interface DeliveryAdmission {
  ready: boolean;
  reasons: string[];
  analysisExecutionId: string | null;
  evidence: { analysisReference: string; designReference: string; designRequired: boolean; note: string; checkedBy: string; checkedAt: string } | null;
}
export interface DeliveryMonthlyEntries {
  month: string;
  collectedAt: string;
  items: {
    demandNo: string; title: string; owner: string; sourceStatus: string;
    /** Qingzhou requirementer_show; older monthly responses may omit this field. */
    analysisOwner?: string;
    expectedDeliveryDate?: string;
    workCountKnown?: boolean;
    inSchedule?: boolean;
    inExpectedDeliveryMonth?: boolean;
    startDate: string; endDate: string; workCount: number;
    snapshotId: string | null; admission: DeliveryAdmission | null;
    chainAdmission?: DeliveryChainAdmission | null;
  }[];
  executionAllowed: false;
}

export interface DeliveryMonthlySyncRun {
  id: string;
  month: string;
  status: "running" | "succeeded" | "partial" | "failed" | "interrupted";
  startedAt: string;
  finishedAt: string | null;
  total: number | null;
  succeeded: number;
  failed: number;
  message: string | null;
}

export interface DeliveryMonthlySyncSchedule {
  enabled: boolean;
  time: string;
  timezone: "Asia/Shanghai";
  nextRunAt: string | null;
  lastRun: DeliveryMonthlySyncRun | null;
}

export type DeliveryMonthlySyncState = DeliveryMonthlySyncSchedule & { leaseUntil?: string };

export interface DeliverySourceOrganization {
  id: string; name: string; code: string; kinds: ("researchGroup" | "testGroup")[];
}
export interface DeliverySourceOrganizations {
  items: DeliverySourceOrganization[]; collectedAt: string;
}

/** Basic source lookup, independent of monthly schedules and saved snapshots. */
export interface DeliveryDemandLookup {
  demandNo: string; title: string; sourceStatus: string;
  owner: string; analysisOwner: string; collectedAt: string;
  snapshotId: string | null;
  savedEntries?: Array<{ projectId: string; projectName: string; snapshotId: string }>;
}
