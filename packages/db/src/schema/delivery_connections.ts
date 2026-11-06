import { index, integer, pgTable, text, timestamp, uuid, uniqueIndex } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { projects } from "./projects.js";
import { agents } from "./agents.js";
import { companySecrets } from "./company_secrets.js";

export const deliveryConnections = pgTable("delivery_connections", {
  id: uuid("id").primaryKey().defaultRandom(),
  companyId: uuid("company_id").notNull().references(() => companies.id),
  projectId: uuid("project_id").notNull().references(() => projects.id),
  jiraAgentId: uuid("jira_agent_id").references(() => agents.id),
  jiraBaseUrl: text("jira_base_url"),
  jiraSecretId: uuid("jira_secret_id").references(() => companySecrets.id),
  organizationId: text("organization_id").notNull(),
  credentialSecretId: uuid("credential_secret_id").notNull().references(() => companySecrets.id),
  revision: integer("revision").notNull().default(1),
  lastCheckStatus: text("last_check_status").notNull().default("not_checked"),
  lastCheckedAt: timestamp("last_checked_at", { withTimezone: true }),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, table => ({
  projectIdentity: uniqueIndex("delivery_connections_project_idx").on(table.companyId, table.projectId),
  company: index("delivery_connections_company_idx").on(table.companyId),
}));
