import { pgTable, uuid, text, timestamp, integer, boolean, jsonb, bigint, bigserial, index, uniqueIndex } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { companies } from "./companies.js";
import { agents } from "./agents.js";
import { issues } from "./issues.js";
import { heartbeatRuns } from "./heartbeat_runs.js";

export const managedSessions = pgTable("dsp7_managed_sessions", {
  id: uuid("id").primaryKey().defaultRandom(), companyId: uuid("company_id").notNull().references(()=>companies.id,{onDelete:"cascade"}),
  taskId: uuid("task_id").notNull().references(()=>issues.id,{onDelete:"cascade"}), seatId: uuid("seat_id").notNull().references(()=>agents.id,{onDelete:"cascade"}),
  runId: uuid("run_id").notNull().references(()=>heartbeatRuns.id,{onDelete:"cascade"}), nativeSessionId: uuid("native_session_id").notNull(),
  machineId: uuid("machine_id").notNull(), machineFingerprint: text("machine_fingerprint").notNull(), ownerUserId: text("owner_user_id"),
  simulated: boolean("simulated").notNull().default(false), startedAt: timestamp("started_at",{withTimezone:true}).notNull().defaultNow(),
  lastReceivedAt: timestamp("last_received_at",{withTimezone:true}).notNull().defaultNow(), endedAt: timestamp("ended_at",{withTimezone:true}),
  coverage: text("coverage").notNull().default("from_start"), syncState: text("sync_state").notNull().default("collecting"),
  collectionPaused: boolean("collection_paused").notNull().default(false), uploadPaused: boolean("upload_paused").notNull().default(false),
  deletedAt: timestamp("deleted_at",{withTimezone:true}), finalizedAt: timestamp("finalized_at",{withTimezone:true}),
  lastObservation: jsonb("last_observation").$type<Record<string,unknown>>().notNull().default({}),
}, t=>({native:uniqueIndex("dsp7_ms_native_uq").on(t.companyId,t.seatId,t.machineId,t.nativeSessionId), task:index("dsp7_ms_task_idx").on(t.companyId,t.taskId),seat:index("dsp7_ms_seat_idx").on(t.companyId,t.seatId,t.startedAt),retention:index("dsp7_ms_retention_idx").on(t.startedAt,t.id).where(sql`${t.deletedAt} is null`)}));
export const managedBindings = pgTable("dsp7_managed_bindings",{
  id:uuid("id").primaryKey().defaultRandom(), sessionId:uuid("session_id").notNull().references(()=>managedSessions.id,{onDelete:"cascade"}), companyId:uuid("company_id").notNull().references(()=>companies.id,{onDelete:"cascade"}),
  runId:uuid("run_id").notNull().references(()=>heartbeatRuns.id,{onDelete:"cascade"}), createdAt:timestamp("created_at",{withTimezone:true}).notNull().defaultNow(),
},t=>({binding:uniqueIndex("dsp7_mb_run_uq").on(t.sessionId,t.runId)}));
export const managedStreams = pgTable("dsp7_managed_streams",{
  id:uuid("id").primaryKey().defaultRandom(),sessionId:uuid("session_id").notNull().references(()=>managedSessions.id,{onDelete:"cascade"}),companyId:uuid("company_id").notNull().references(()=>companies.id,{onDelete:"cascade"}),
  streamId:text("stream_id").notNull(),ackSequence:bigint("ack_sequence",{mode:"number"}).notNull().default(0),
},t=>({stream:uniqueIndex("dsp7_mstream_uq").on(t.sessionId,t.streamId)}));
export const managedEvents = pgTable("dsp7_managed_events",{
  id:uuid("id").primaryKey().defaultRandom(),sessionId:uuid("session_id").notNull().references(()=>managedSessions.id,{onDelete:"cascade"}),companyId:uuid("company_id").notNull().references(()=>companies.id,{onDelete:"cascade"}),
  streamId:text("stream_id").notNull(),sequence:bigint("sequence",{mode:"number"}).notNull(),eventId:uuid("event_id").notNull(),eventType:text("event_type").notNull(),
  occurredAt:timestamp("occurred_at",{withTimezone:true}).notNull(),observedAt:timestamp("observed_at",{withTimezone:true}).notNull(), receivedAt:timestamp("received_at",{withTimezone:true}).notNull().defaultNow(),
  sourceGeneration:text("source_generation").notNull(),sourceOffset:bigint("source_offset",{mode:"number"}).notNull(),digest:text("digest").notNull(),
  payload:jsonb("payload").$type<Record<string,unknown>>().notNull(),
},t=>({seq:uniqueIndex("dsp7_me_seq_uq").on(t.sessionId,t.streamId,t.sequence),event:uniqueIndex("dsp7_me_event_uq").on(t.sessionId,t.eventId),time:index("dsp7_me_time_idx").on(t.sessionId,t.eventType,t.occurredAt)}));
export const managedContents = pgTable("dsp7_managed_contents",{
  position:bigserial("position",{mode:"number"}).notNull(),
  id:uuid("id").primaryKey().defaultRandom(),sessionId:uuid("session_id").notNull().references(()=>managedSessions.id,{onDelete:"cascade"}),companyId:uuid("company_id").notNull().references(()=>companies.id,{onDelete:"cascade"}),
  streamId:text("stream_id").notNull(),contentId:text("content_id").notNull(),revision:text("revision").notNull(),sequence:bigint("sequence",{mode:"number"}).notNull(),
  occurredAt:timestamp("occurred_at",{withTimezone:true}).notNull(),manifest:jsonb("manifest").$type<Record<string,unknown>>().notNull(),complete:boolean("complete").notNull().default(false),
},t=>({content:uniqueIndex("dsp7_mc_uq").on(t.sessionId,t.streamId,t.contentId),page:index("dsp7_mc_page_idx").on(t.sessionId,t.id)}));
export const managedParts = pgTable("dsp7_managed_parts",{
  id:uuid("id").primaryKey().defaultRandom(),sessionId:uuid("session_id").notNull().references(()=>managedSessions.id,{onDelete:"cascade"}),companyId:uuid("company_id").notNull().references(()=>companies.id,{onDelete:"cascade"}),
  streamId:text("stream_id").notNull(),contentId:text("content_id").notNull(),revision:text("revision").notNull(),partIndex:integer("part_index").notNull(),data:text("data").notNull(),encoding:text("encoding").notNull(),
},t=>({part:uniqueIndex("dsp7_mp_uq").on(t.sessionId,t.streamId,t.contentId,t.revision,t.partIndex)}));
/** Server-time presence evidence. No conversation bodies or client-reported workload counts. */
export const managedSeatSamples = pgTable("dsp7_managed_seat_samples",{
  id:uuid("id").primaryKey().defaultRandom(),companyId:uuid("company_id").notNull().references(()=>companies.id,{onDelete:"cascade"}),seatId:uuid("seat_id").notNull().references(()=>agents.id,{onDelete:"cascade"}),
  ownerUserId:text("owner_user_id"),at:timestamp("at",{withTimezone:true}).notNull().defaultNow(),state:text("state").notNull(),taskId:uuid("task_id"),
  backlog:integer("backlog").notNull().default(0),through:timestamp("through",{withTimezone:true}).notNull().defaultNow(),
},t=>({seat:index("dsp7_msample_time_idx").on(t.companyId,t.seatId,t.at)}));
export const managedQuality = pgTable("dsp7_managed_quality",{
  id:uuid("id").primaryKey().defaultRandom(),companyId:uuid("company_id").notNull().references(()=>companies.id,{onDelete:"cascade"}),seatId:uuid("seat_id").notNull().references(()=>agents.id,{onDelete:"cascade"}),
  taskId:uuid("task_id").notNull().references(()=>issues.id,{onDelete:"cascade"}),ownerUserId:text("owner_user_id"),jiraKey:text("jira_key").notNull(),observedAt:timestamp("observed_at",{withTimezone:true}).notNull().defaultNow(),
  windowDays:integer("window_days").notNull().default(14),defects:jsonb("defects").$type<Array<{key:string;createdAt:string;severity:string}>>().notNull().default([]),source:text("source").notNull(),
},t=>({task:uniqueIndex("dsp7_mquality_task_uq").on(t.companyId,t.taskId),seat:index("dsp7_mquality_seat_idx").on(t.companyId,t.seatId)}));
/** Immutable first business transitions, unaffected by later reopen/reassignment. */
export const managedTaskFacts = pgTable("dsp7_managed_task_facts",{
  id:uuid("id").primaryKey().defaultRandom(),companyId:uuid("company_id").notNull().references(()=>companies.id,{onDelete:"cascade"}),taskId:uuid("task_id").notNull().references(()=>issues.id,{onDelete:"cascade"}),
  seatId:uuid("seat_id").notNull().references(()=>agents.id,{onDelete:"cascade"}),ownerUserId:text("owner_user_id"),kind:text("kind").notNull(),at:timestamp("at",{withTimezone:true}).notNull().defaultNow(),simulated:boolean("simulated").notNull().default(false),
},t=>({kind:uniqueIndex("dsp7_mfact_kind_uq").on(t.companyId,t.taskId,t.kind),time:index("dsp7_mfact_time_idx").on(t.companyId,t.seatId,t.at)}));
export const managedJiraWorkloads = pgTable("dsp7_managed_jira_workloads",{
  id:uuid("id").primaryKey().defaultRandom(),companyId:uuid("company_id").notNull().references(()=>companies.id,{onDelete:"cascade"}),seatId:uuid("seat_id").notNull().references(()=>agents.id,{onDelete:"cascade"}),ownerUserId:text("owner_user_id"),
  at:timestamp("at",{withTimezone:true}).notNull().defaultNow(),total:integer("total").notNull(),revision:integer("revision").notNull(),scope:jsonb("scope").$type<Record<string,unknown>>().notNull(),
},t=>({time:index("dsp7_mjira_time_idx").on(t.companyId,t.seatId,t.at)}));
