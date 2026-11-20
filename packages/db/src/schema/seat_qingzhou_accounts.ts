import { integer, pgTable, text, timestamp, uuid, uniqueIndex } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { agents } from "./agents.js";
import { companySecrets } from "./company_secrets.js";

export const seatQingzhouAccounts = pgTable("seat_qingzhou_accounts", {
  id: uuid("id").primaryKey().defaultRandom(),
  companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
  seatId: uuid("seat_id").notNull().references(() => agents.id, { onDelete: "cascade" }),
  username: text("username"),
  credentialSecretId: uuid("credential_secret_id").references(() => companySecrets.id),
  revision: integer("revision").notNull().default(1),
  lastCheckStatus: text("last_check_status").notNull().default("not_checked"),
  lastCheckedAt: timestamp("last_checked_at", { withTimezone: true }),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, table => ({ identity: uniqueIndex("seat_qingzhou_accounts_seat_idx").on(table.companyId, table.seatId) }));
