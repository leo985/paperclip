import { boolean, index, jsonb, pgTable, text, timestamp, uuid, uniqueIndex } from "drizzle-orm/pg-core";
import type { HarnessExecutionRoute } from "@paperclipai/shared";
import { companies } from "./companies.js";
import { agents } from "./agents.js";
import { issues } from "./issues.js";
import { heartbeatRuns } from "./heartbeat_runs.js";

export const seatExecutionPermits = pgTable("seat_execution_permits", {
  id: uuid("id").primaryKey().defaultRandom(),
  companyId: uuid("company_id").notNull().references(() => companies.id),
  agentId: uuid("agent_id").notNull().references(() => agents.id),
  runId: uuid("run_id").notNull().references(() => heartbeatRuns.id),
  taskId: uuid("task_id").notNull().references(() => issues.id),
  machineId: uuid("machine_id").notNull(),
  leaseHash: text("lease_hash").notNull(),
  issuedAt: timestamp("issued_at", { withTimezone: true }).notNull().defaultNow(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  renewedAt: timestamp("renewed_at", { withTimezone: true }).notNull().defaultNow(),
  revokedAt: timestamp("revoked_at", { withTimezone: true }),
  stopReason: text("stop_reason"),
  treeProofRequired: boolean("tree_proof_required").notNull().default(false),
  treeStopVerifiedAt: timestamp("tree_stop_verified_at", { withTimezone: true }),
  treeStopProof: jsonb("tree_stop_proof").$type<Record<string, unknown>>(),
  executionRoute: jsonb("execution_route").$type<HarnessExecutionRoute>(),
  ledgerScope: jsonb("ledger_scope").$type<{ issueId: string; projectId: string | null; billingCode: string | null }>(),
  processExitObservedAt: timestamp("process_exit_observed_at", { withTimezone: true }),
}, table => ({
  runIdentity: uniqueIndex("seat_execution_permits_run_idx").on(table.runId),
  scope: index("seat_execution_permits_agent_idx").on(table.companyId, table.agentId, table.expiresAt),
}));
