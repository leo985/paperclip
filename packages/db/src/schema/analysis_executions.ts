import {
  pgTable,
  uuid,
  text,
  integer,
  jsonb,
  timestamp,
  index,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import type {
  AnalysisSnapshot,
  AnalysisDelivery,
  AnalysisExecution,
} from "@paperclipai/shared";
import { companies } from "./companies.js";
import { projects } from "./projects.js";
import { agents } from "./agents.js";
import { issues } from "./issues.js";
import { heartbeatRuns } from "./heartbeat_runs.js";
export const analysisExecutions = pgTable(
  "analysis_executions",
  {
    id: uuid("id")
      .primaryKey()
      .references(() => issues.id, { onDelete: "cascade" }),
    companyId: uuid("company_id")
      .notNull()
      .references(() => companies.id, { onDelete: "cascade" }),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id),
    seatId: uuid("seat_id")
      .notNull()
      .references(() => agents.id),
    ownerUserId: text("owner_user_id").notNull(),
    revision: integer("revision").notNull().default(1),
    supersedesId: uuid("supersedes_id"),
    requestId: uuid("request_id").notNull(),
    createdBy: text("created_by").notNull(),
    title: text("title").notNull(),
    brief: text("brief").notNull(),
    demandNo: text("demand_no"),
    state: text("state").notNull().default("draft"),
    dispatchId: uuid("dispatch_id"),
    activeRunId: uuid("active_run_id").references(() => heartbeatRuns.id),
    capabilityId: text("capability_id"),
    registryRevision: integer("registry_revision"),
    snapshot: jsonb("snapshot").$type<AnalysisSnapshot>(),
    delivery: jsonb("delivery").$type<AnalysisDelivery>(),
    qingzhouWriteback: jsonb("qingzhou_writeback").$type<NonNullable<AnalysisExecution["qingzhouWriteback"]>>(),
    publication:
      jsonb("publication").$type<
        NonNullable<AnalysisExecution["publication"]>
      >(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    request: uniqueIndex("analysis_execution_request_uq").on(
      t.companyId,
      t.requestId,
    ),
    list: index("analysis_execution_list_idx").on(
      t.companyId,
      t.projectId,
      t.createdAt,
    ),
  }),
);
export const analysisDecisions = pgTable(
  "analysis_decisions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id")
      .notNull()
      .references(() => companies.id, { onDelete: "cascade" }),
    executionId: uuid("execution_id")
      .notNull()
      .references(() => analysisExecutions.id, { onDelete: "cascade" }),
    runId: uuid("run_id")
      .notNull()
      .references(() => heartbeatRuns.id),
    key: text("key").notNull(),
    kind: text("kind").notNull(),
    text: text("text").notNull(),
    inputDigest: text("input_digest").notNull(),
    contentDigest: text("content_digest").notNull(),
    status: text("status").notNull().default("open"),
    answer: text("answer"),
    answeredBy: text("answered_by"),
    answeredAt: timestamp("answered_at", { withTimezone: true }),
    ackedAt: timestamp("acked_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    version: uniqueIndex("analysis_decision_version_uq").on(
      t.executionId,
      t.runId,
      t.key,
      t.contentDigest,
    ),
    list: index("analysis_decision_list_idx").on(
      t.companyId,
      t.executionId,
      t.createdAt,
    ),
  }),
);
