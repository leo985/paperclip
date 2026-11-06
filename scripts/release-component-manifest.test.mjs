import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { releaseComponentManifest } from "./release-component-manifest.mjs";

test("component matrix detects source and distribution drift without claiming deployment or tests", async () => {
  const root = await mkdtemp(join(tmpdir(), "pc-release-matrix-"));
  const put = async (name, value) => {
    const path = join(root, name);
    await mkdir(join(path, ".."), { recursive: true });
    await writeFile(path, value);
  };
  try {
    execFileSync("git", ["init", "-q"], { cwd: root });
    execFileSync("git", ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", "commit", "--allow-empty", "-qm", "fixture"], { cwd: root });
    await put("server/src/index.ts", "export {};");
    await put("packages/db/src/migrations/meta/_journal.json", JSON.stringify({ entries: [{ tag: "0299_fixture" }] }));
    await put("ui/public/dsp7-bridge.zip", "fixture archive");
    const digest = createHash("sha256").update("fixture archive").digest("hex");
    await put("ui/public/dsp7-bridge-manifest.json", JSON.stringify({ format: 1, sha256: digest }));
    for (const [source, target] of [["quick_install.py", "dsp7-install.py"], ["install_windows.ps1", "dsp7-install.ps1"]]) {
      await put("integrations/dsp7-bridge/" + source, "fixture installer");
      await put("ui/public/" + target, "fixture installer");
    }
    const first = await releaseComponentManifest(root);
    assert.equal(first.database.expectedLatestMigration, "0299_fixture");
    assert.equal(first.database.appliedMigration, "unverified");
    assert.equal(first.components.server.deployed, "unverified");
    assert.equal(first.verification.tests, "unverified");
    assert.equal(first.bridge.manifestMatches, true);
    assert.equal(first.bridge.installerMatches, true);
    assert.equal(first.source.dirty, true);
    await put("server/src/index.ts", "export const changed = true;");
    await put("ui/public/dsp7-bridge.zip", "changed archive");
    await put("ui/public/dsp7-install.py", "stale installer");
    const second = await releaseComponentManifest(root);
    assert.notEqual(second.components.server.sourceSha256, first.components.server.sourceSha256);
    assert.equal(second.bridge.manifestMatches, false);
    assert.equal(second.bridge.installerMatches, false);
  } finally { await rm(root, { recursive: true, force: true }); }
});
