import {
  pgTable,
  uuid,
  text,
  jsonb,
  timestamp,
  index,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import type {
  DeliveryWorkflowConfig,
  DeliveryStageRecord,
  DeliveryWorkflow,
} from "@paperclipai/shared";
import { companies } from "./companies.js";
import { projects } from "./projects.js";
import { deliverySnapshots } from "./delivery_snapshots.js";
export const deliveryWorkflows = pgTable(
  "delivery_workflows",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id")
      .notNull()
      .references(() => companies.id, { onDelete: "cascade" }),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id),
    snapshotId: uuid("snapshot_id")
      .notNull()
      .references(() => deliverySnapshots.id),
    demandNo: text("demand_no").notNull(),
    fingerprint: text("fingerprint").notNull(),
    requestId: uuid("request_id").notNull(),
    createdBy: text("created_by").notNull(),
    state: text("state")
      .$type<DeliveryWorkflow["state"]>()
      .notNull()
      .default("active"),
    config: jsonb("config").$type<DeliveryWorkflowConfig>().notNull(),
    stages: jsonb("stages").$type<DeliveryStageRecord[]>().notNull(),
    message: text("message"),
    acceptance: jsonb("acceptance").$type<DeliveryWorkflow["acceptance"]>(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    request: uniqueIndex("delivery_workflow_request_uq").on(
      t.companyId,
      t.requestId,
    ),
    identity: uniqueIndex("delivery_workflow_entry_uq").on(
      t.companyId,
      t.projectId,
      t.demandNo,
    ),
    queue: index("delivery_workflow_queue_idx").on(t.state, t.updatedAt),
  }),
);
