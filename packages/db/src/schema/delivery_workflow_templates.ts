import {
  pgTable,
  uuid,
  text,
  integer,
  jsonb,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import type { DeliveryTemplateDefinition } from "@paperclipai/shared";
import { companies } from "./companies.js";
import { projects } from "./projects.js";
export const deliveryWorkflowTemplates = pgTable(
  "delivery_workflow_templates",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id")
      .notNull()
      .references(() => companies.id, { onDelete: "cascade" }),
    projectId: uuid("project_id").references(() => projects.id, {
      onDelete: "cascade",
    }),
    scopeKey: text("scope_key").notNull(),
    revision: integer("revision").notNull(),
    definition: jsonb("definition")
      .$type<DeliveryTemplateDefinition>()
      .notNull(),
    createdBy: text("created_by").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => ({
    revision: uniqueIndex("delivery_workflow_templates_scope_revision_uq").on(
      table.companyId,
      table.scopeKey,
      table.revision,
    ),
  }),
);
