import { pgTable, uuid, text, timestamp, integer, index, uniqueIndex } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { issues } from "./issues.js";

export const managementFollowUps = pgTable("management_follow_ups", {
  id: uuid("id").primaryKey().defaultRandom(),
  companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
  issueId: uuid("issue_id").notNull().references(() => issues.id, { onDelete: "cascade" }),
  ownerUserId: text("owner_user_id"),
  remindAt: timestamp("remind_at", { withTimezone: true }),
  version: integer("version").notNull().default(1),
  updatedBy: text("updated_by").notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, t => ({
  issue: uniqueIndex("management_follow_up_issue_uq").on(t.companyId, t.issueId),
  owner: index("management_follow_up_owner_idx").on(t.companyId, t.ownerUserId, t.remindAt),
}));
