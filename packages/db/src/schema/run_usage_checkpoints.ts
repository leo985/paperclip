import { integer, jsonb, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { agents } from "./agents.js";
import { heartbeatRuns } from "./heartbeat_runs.js";

/** Latest accepted cumulative observation. Cost events hold only its deltas. */
export const runUsageCheckpoints = pgTable("run_usage_checkpoints", {
  runId: uuid("run_id").primaryKey().references(() => heartbeatRuns.id),
  companyId: uuid("company_id").notNull().references(() => companies.id),
  agentId: uuid("agent_id").notNull().references(() => agents.id),
  sequence: integer("sequence").notNull(),
  inputTokens: integer("input_tokens").notNull(),
  outputTokens: integer("output_tokens").notNull(),
  cachedInputTokens: integer("cached_input_tokens").notNull(),
  model: text("model").notNull(),
  observedAt: timestamp("observed_at", { withTimezone: true }).notNull(),
  scope: jsonb("scope").$type<{ issueId: string | null; projectId: string | null; billingCode: string | null }>().notNull(),
  finalDigest: text("final_digest"),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});
