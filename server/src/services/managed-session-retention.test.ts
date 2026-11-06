import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import {
  agents, companies, createDb, heartbeatRuns, issues, managedContents,
  managedEvents, managedParts, managedSessions, managedStreams, type Db,
} from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "../__tests__/helpers/embedded-postgres.js";
import { expireSessionBodies } from "./managed-sessions.js";

const support = await getEmbeddedPostgresTestSupport();
(support.supported ? describe : describe.skip)("managed session background retention", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>, db: Db;
  const companyId = randomUUID(), seatId = randomUUID(), taskId = randomUUID(), runId = randomUUID();
  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("ms-retention-");
    db = createDb(database.connectionString);
    await db.insert(companies).values({ id: companyId, name: "Retention test", issuePrefix: "RET" });
    await db.insert(agents).values({ id: seatId, companyId, name: "Seat", role: "engineer", adapterType: "process" });
    await db.insert(issues).values({ id: taskId, companyId, title: "Retention fixture" });
    await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId: seatId });
  });
  afterAll(async () => { await database?.cleanup(); });

  async function session(days: number) {
    const id = randomUUID();
    await db.insert(managedSessions).values({ id, companyId, seatId, taskId, runId,
      machineId: randomUUID(), machineFingerprint: "test", nativeSessionId: randomUUID(),
      startedAt: new Date(Date.now() - days * 86_400_000), lastObservation: { content: "private observation" } });
    await db.insert(managedStreams).values({ sessionId: id, companyId, streamId: "s", ackSequence: 2 });
    await db.insert(managedContents).values({ sessionId: id, companyId, streamId: "s", contentId: "c", revision: "1", sequence: 1, occurredAt: new Date(), manifest: {}, complete: true });
    await db.insert(managedParts).values({ sessionId: id, companyId, streamId: "s", contentId: "c", revision: "1", partIndex: 0, data: "private body", encoding: "utf8" });
    await db.insert(managedEvents).values(["content.part", "phase"].map((eventType, i) => ({ sessionId: id, companyId, streamId: "s", sequence: i + 1, eventId: randomUUID(), eventType, occurredAt: new Date(), observedAt: new Date(), sourceGeneration: "1", sourceOffset: i, digest: "a".repeat(64), payload: { state: "observed" } })));
    return id;
  }

  it("rolls back all body deletion on failure, retries immediately, and preserves recent content and replay tombstones", async () => {
    const old = await session(91), recent = await session(1);
    // Force a real database failure after the tombstone update and first delete.
    await db.execute(sql`create function retention_test_fail() returns trigger language plpgsql as $$ begin raise exception 'retention test failure'; end; $$`);
    await db.execute(sql`create trigger retention_test_fail before delete on dsp7_managed_contents for each row execute function retention_test_fail()`);
    await expect(expireSessionBodies(db)).rejects.toThrow();
    expect((await db.select().from(managedSessions).where(eq(managedSessions.id, old)))[0].deletedAt).toBeNull();
    expect(await db.select().from(managedParts).where(eq(managedParts.sessionId, old))).toHaveLength(1);
    await db.execute(sql`drop trigger retention_test_fail on dsp7_managed_contents`);
    const first = expireSessionBodies(db), duplicate = expireSessionBodies(db);
    expect(duplicate).toBe(first);
    await first;
    const [expired] = await db.select().from(managedSessions).where(eq(managedSessions.id, old));
    expect(expired.syncState).toBe("expired");
    expect(expired.deletedAt).not.toBeNull();
    expect(expired.lastObservation).toEqual({});
    expect(await db.select().from(managedParts).where(eq(managedParts.sessionId, old))).toHaveLength(0);
    expect(await db.select().from(managedContents).where(eq(managedContents.sessionId, old))).toHaveLength(0);
    expect((await db.select().from(managedEvents).where(eq(managedEvents.sessionId, old))).map(e => e.eventType)).toEqual(["phase"]);
    expect(await db.select().from(managedStreams).where(eq(managedStreams.sessionId, old))).toHaveLength(1);
    expect(await db.select().from(managedParts).where(eq(managedParts.sessionId, recent))).toHaveLength(1);
  });
});
