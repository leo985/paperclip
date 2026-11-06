import { pgTable, uuid, text, timestamp, jsonb, index, uniqueIndex } from "drizzle-orm/pg-core";
import type { DeliveryPlan } from "@paperclipai/shared";
import { companies } from "./companies.js";
import { projects } from "./projects.js";

export const deliverySnapshots = pgTable("delivery_snapshots", {
  id: uuid("id").primaryKey().defaultRandom(),
  companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
  projectId: uuid("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
  sourceOrigin: text("source_origin").notNull(),
  demandNo: text("demand_no").notNull(),
  fingerprint: text("fingerprint").notNull(),
  collectedAt: timestamp("collected_at", { withTimezone: true }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  createdByUserId: text("created_by_user_id").notNull(),
  plan: jsonb("plan").$type<DeliveryPlan>().notNull(),
}, table => ({
  identity: uniqueIndex("delivery_snapshots_identity_idx").on(table.companyId, table.projectId, table.sourceOrigin, table.demandNo, table.fingerprint),
  listing: index("delivery_snapshots_listing_idx").on(table.companyId, table.projectId, table.createdAt),
}));
