import { integer, pgTable, primaryKey, text, uuid } from "drizzle-orm/pg-core";
import { heartbeatRuns } from "./heartbeat_runs.js";
import { costEvents } from "./cost_events.js";
export const runUsageObservations = pgTable("run_usage_observations", {
  runId: uuid("run_id").notNull().references(() => heartbeatRuns.id),
  sequence: integer("sequence").notNull(),
  digest: text("digest").notNull(),
  eventId: uuid("event_id").notNull().references(() => costEvents.id),
}, table => ({ identity: primaryKey({ columns: [table.runId, table.sequence] }) }));
