import { jsonb, pgTable, text, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import type { DeliverySavedAutomaticPlan } from "@paperclipai/shared";
import { companies } from "./companies.js";
import { deliverySnapshots } from "./delivery_snapshots.js";
import { projects } from "./projects.js";

export const deliveryPlanPreviews = pgTable("delivery_plan_previews", {
  id: uuid("id").primaryKey().defaultRandom(),
  companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
  projectId: uuid("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
  sourceOrigin: text("source_origin").notNull(),
  demandNo: text("demand_no").notNull(),
  snapshotId: uuid("snapshot_id").notNull().references(() => deliverySnapshots.id, { onDelete: "cascade" }),
  preview: jsonb("preview").$type<DeliverySavedAutomaticPlan>().notNull(),
}, table => ({
  entry: uniqueIndex("delivery_plan_previews_entry_idx").on(table.companyId, table.projectId, table.sourceOrigin, table.demandNo),
}));
