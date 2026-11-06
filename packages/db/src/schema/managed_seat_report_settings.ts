import type { SeatWorkSchedule } from "@paperclipai/shared";
import { pgTable, uuid, jsonb, timestamp } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";

export const managedSeatReportSettings = pgTable("dsp7_managed_seat_report_settings", {
  companyId: uuid("company_id").primaryKey().references(() => companies.id, { onDelete: "cascade" }),
  workSchedule: jsonb("work_schedule").$type<SeatWorkSchedule>().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});
