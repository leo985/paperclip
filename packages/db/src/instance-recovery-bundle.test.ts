import { randomBytes, createCipheriv, createDecipheriv } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import postgres from "postgres";
import { expect, it } from "vitest";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase, runDatabaseBackup, runDatabaseRestore } from "./index.js";
import { createRecoveryBundle, restoreRecoveryBundle } from "../../../scripts/instance-recovery-bundle.mjs";

const support = await getEmbeddedPostgresTestSupport();
(support.supported ? it : it.skip)("recovers a real database plus encrypted evidence using the bundled master key", async () => {
  const database = await startEmbeddedPostgresTestDatabase("instance-recovery-");
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-recovery-drill-"));
  const source = postgres(database.connectionString, { max: 1, onnotice: () => {} });
  let target: ReturnType<typeof postgres> | undefined;
  try {
    await source.unsafe('CREATE DATABASE recovery_target');
    const targetUrl = new URL(database.connectionString); targetUrl.pathname = "/recovery_target";
    await source.unsafe('CREATE TABLE recovery_evidence (id integer primary key, payload text not null)');
    await source.unsafe("INSERT INTO recovery_evidence VALUES (1, 'accepted source evidence')");
    const backup = await runDatabaseBackup({ connectionString: database.connectionString, backupDir: path.join(root, "dumps"), retention: { dailyDays: 1, weeklyWeeks: 1, monthlyMonths: 1 }, backupEngine: "javascript" });
    const key = randomBytes(32), nonce = randomBytes(12), cipher = createCipheriv("aes-256-gcm", key, nonce);
    const encrypted = Buffer.concat([cipher.update("recoverable artifact", "utf8"), cipher.final()]);
    const artifacts = path.join(root, "artifacts"), logs = path.join(root, "logs"); await fs.mkdir(artifacts); await fs.mkdir(logs);
    await fs.writeFile(path.join(artifacts, "evidence.enc"), encrypted); await fs.writeFile(path.join(logs, "run.log"), "run stopped and accepted");
    const masterKey = path.join(root, "master.key"), config = path.join(root, "config.json"); await fs.writeFile(masterKey, key); await fs.writeFile(config, '{"fixture":true}');
    const bundle = path.join(root, "bundle"), restored = path.join(root, "restored");
    await createRecoveryBundle({ components: { database: backup.backupFile, config, masterKey, artifacts, runLogs: logs }, destination: bundle, quiesced: true });
    await restoreRecoveryBundle(bundle, restored);
    await runDatabaseRestore({ connectionString: targetUrl.href, backupFile: path.join(restored, "database.sql.gz") });
    target = postgres(targetUrl.href, { max: 1, onnotice: () => {} });
    expect((await target.unsafe('SELECT payload FROM recovery_evidence WHERE id=1'))[0].payload).toBe("accepted source evidence");
    const decipher = createDecipheriv("aes-256-gcm", await fs.readFile(path.join(restored, "masterKey")), nonce); decipher.setAuthTag(cipher.getAuthTag());
    expect(Buffer.concat([decipher.update(await fs.readFile(path.join(restored, "artifacts/evidence.enc"))), decipher.final()]).toString()).toBe("recoverable artifact");
    expect(await fs.readFile(path.join(restored, "runLogs/run.log"), "utf8")).toContain("accepted");
  } finally { await target?.end(); await source.end(); await database.cleanup(); await fs.rm(root, { recursive: true, force: true }); }
}, 60_000);
