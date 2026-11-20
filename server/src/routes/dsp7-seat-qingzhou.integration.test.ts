import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import express from "express";
import request from "supertest";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { activityLog, agents, companies, companySecrets, companySecretVersions, createDb, seatQingzhouAccounts, type Db } from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "../__tests__/helpers/embedded-postgres.js";
import { seatQingzhouRoutes } from "./dsp7-seat-qingzhou.js";
import { secretService } from "../services/secrets.js";
import { resolveSeatQingzhouCredentials } from "../services/seat-qingzhou.js";

const support = await getEmbeddedPostgresTestSupport();
(support.supported ? describe : describe.skip)("seat Qingzhou encrypted account persistence", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>, db: Db, directory: string;
  beforeAll(async () => {
    directory = await mkdtemp(path.join(os.tmpdir(), "seat-qingzhou-secrets-"));
    vi.stubEnv("PAPERCLIP_SECRETS_MASTER_KEY_FILE", path.join(directory, "master.key"));
    database = await startEmbeddedPostgresTestDatabase("seat-qingzhou-");
    db = createDb(database.connectionString);
  }, 30000);
  afterAll(async () => { await database?.cleanup(); if (directory) await rm(directory, { recursive: true, force: true }); vi.unstubAllEnvs(); });
  async function fixture() {
    const companyId = randomUUID(), seatId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Seat accounts", issuePrefix: "Q" + companyId.slice(0, 6) });
    await db.insert(agents).values({ id: seatId, companyId, name: "Seat", role: "engineer", adapterType: "claude_local", adapterConfig: { dsp7Seat: { ownerUserId: "owner" } } });
    const app = express(); app.use(express.json()); app.use((req, _res, next) => { req.actor = { type: "board", source: "local_implicit", userId: "owner" }; next(); });
    app.use(seatQingzhouRoutes(db, { secrets: secretService, fetch: vi.fn(async () => new Response(JSON.stringify({ accessToken: "test-login-token" }))) as typeof fetch }));
    app.use((error: any, _req: any, res: any, _next: any) => res.status(error.status ?? 500).json({ error: error.message }));
    return { companyId, seatId, app, base: `/companies/${companyId}/dsp7-seats/${seatId}/qingzhou-account` };
  }
  it("encrypts the account, rotates it and revokes its vault secret on removal", async () => {
    const f = await fixture(), password = "fixture-" + randomUUID();
    expect((await request(f.app).put(f.base).send({ expectedRevision: 0, username: "seat-analyst", password })).status).toBe(200);
    const [account] = await db.select().from(seatQingzhouAccounts).where(eq(seatQingzhouAccounts.seatId, f.seatId));
    const versions = await db.select().from(companySecretVersions).where(eq(companySecretVersions.secretId, account.credentialSecretId!));
    expect(versions).toHaveLength(1); expect(JSON.stringify(versions)).not.toContain(password);
    const credentials = await db.transaction(tx => resolveSeatQingzhouCredentials(tx as unknown as Db, f.companyId, account));
    expect(credentials).toEqual({ username: "seat-analyst", password });
    expect((await request(f.app).put(f.base).send({ expectedRevision: 1, username: "seat-analyst", password: "replacement-password" })).status).toBe(200);
    expect(JSON.parse(await secretService(db).resolveSecretValue(f.companyId, account.credentialSecretId!, "latest")).password).toBe("replacement-password");
    expect((await request(f.app).delete(f.base).send({ expectedRevision: 2 })).body).toMatchObject({ configured: false, revision: 3 });
    const [secret] = await db.select().from(companySecrets).where(eq(companySecrets.id, account.credentialSecretId!));
    expect(secret.status).toBe("deleted");
    const audit = await db.select().from(activityLog).where(and(eq(activityLog.companyId, f.companyId), eq(activityLog.agentId, f.seatId)));
    expect(JSON.stringify(audit)).not.toContain(password); expect(JSON.stringify(audit)).not.toContain("replacement-password");
  });
  it("serializes concurrent configuration without duplicate credentials or lost edits", async () => {
    const f = await fixture();
    const results = await Promise.all(["first", "second"].map(username => request(f.app).put(f.base).send({ expectedRevision: 0, username, password: "fixture-password" })));
    expect(results.map(result => result.status).sort()).toEqual([200, 409]);
    const accounts = await db.select().from(seatQingzhouAccounts).where(eq(seatQingzhouAccounts.seatId, f.seatId));
    expect(accounts).toHaveLength(1); expect(accounts[0].revision).toBe(1);
    const secrets = await db.select().from(companySecrets).where(eq(companySecrets.companyId, f.companyId));
    expect(secrets).toHaveLength(1);
  });
});
