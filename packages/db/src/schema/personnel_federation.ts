import { pgTable, uuid, text, timestamp, boolean, integer, jsonb, uniqueIndex } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { authUsers } from "./auth.js";
export const personnelSources = pgTable("personnel_sources", {
  id: uuid("id").primaryKey().defaultRandom(),
  companyId: uuid("company_id").notNull().references(() => companies.id),
  type: text("type").notNull(), name: text("name").notNull(),
  corpId: text("corp_id").notNull(), appKey: text("app_key").notNull(),
  secretId: uuid("secret_id"), syncScope: text("sync_scope").notNull(),
  enabled: boolean("enabled").notNull().default(true), autoSync: boolean("auto_sync").notNull().default(false),
  syncInterval: integer("sync_interval").notNull().default(3600),
  leaseUntil: timestamp("lease_until", { withTimezone: true }),
  lastSyncAt: timestamp("last_sync_at", { withTimezone: true }),
  lastResult: jsonb("last_result").$type<Record<string, unknown>>(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, t => ({ identity: uniqueIndex("personnel_sources_identity").on(t.companyId,t.type,t.corpId) }));
export const personnelPeople = pgTable("personnel_people", {
  id: uuid("id").primaryKey().defaultRandom(),
  sourceId: uuid("source_id").notNull().references(() => personnelSources.id),
  companyId: uuid("company_id").notNull().references(() => companies.id),
  externalId: text("external_id").notNull(), username: text("username").notNull(),
  name: text("name").notNull(), email: text("email"), phone: text("phone"),
  departmentIds: jsonb("department_ids").$type<string[]>().notNull().default([]),
  userId: text("user_id").references(() => authUsers.id),
  requirePasswordChange: boolean("require_password_change").notNull().default(false),
  managedAccount: boolean("managed_account").notNull().default(false),
  active: boolean("active").notNull().default(true),
  activationHash: text("activation_hash"), activationExpires: timestamp("activation_expires", { withTimezone: true }),
  lastSyncedAt: timestamp("last_synced_at", { withTimezone: true }).notNull().defaultNow(),
}, t => ({ identity: uniqueIndex("personnel_people_identity").on(t.sourceId,t.externalId) }));
export const personnelDepartments = pgTable("personnel_departments", {
  id: uuid("id").primaryKey().defaultRandom(),
  sourceId: uuid("source_id").notNull().references(() => personnelSources.id),
  companyId: uuid("company_id").notNull().references(() => companies.id),
  externalId: text("external_id").notNull(), name: text("name").notNull(), parentId: text("parent_id"),
  active: boolean("active").notNull().default(true),
}, t => ({ identity: uniqueIndex("personnel_departments_identity").on(t.sourceId,t.externalId) }));
