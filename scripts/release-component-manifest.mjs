#!/usr/bin/env node
// A local component inventory is build evidence, never a deployment receipt.
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFile, lstat } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { uiStaticManifest } from "./ui-static-release.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const sha = bytes => createHash("sha256").update(bytes).digest("hex");
const json = async path => JSON.parse(await readFile(path, "utf8"));
export async function releaseComponentManifest(repo = root, uiDirectory) {
  const git = args => execFileSync("git", args, { cwd: repo, encoding: "utf8", timeout: 10000 });
  const files = [...new Set(git(["ls-files", "-z", "--cached", "--others", "--exclude-standard"]).split("\0").filter(Boolean))].sort();
  const components = {};
  for (const [name, prefix] of Object.entries({ server: "server/src/", ui: "ui/src/", database: "packages/db/src/", shared: "packages/shared/src/", bridge: "integrations/dsp7-bridge/" })) {
    const entries = [];
    for (const file of files.filter(f => f.startsWith(prefix) && !f.includes("/__pycache__/") && !f.endsWith(".pyc"))) {
      try {
        const path = resolve(repo, file), stat = await lstat(path);
        if (stat.isSymbolicLink()) throw new Error("Component source cannot be a symlink: " + file);
        if (stat.isFile()) entries.push([file, sha(await readFile(path))]);
      } catch (error) { if (error.code !== "ENOENT") throw error; }
    }
    components[name] = { sourceSha256: sha(JSON.stringify(entries)), files: entries.length, deployed: "unverified" };
  }
  const journal = await json(resolve(repo, "packages/db/src/migrations/meta/_journal.json"));
  const manifest = await json(resolve(repo, "ui/public/dsp7-bridge-manifest.json"));
  const bridgeSha256 = sha(await readFile(resolve(repo, "ui/public/dsp7-bridge.zip")));
  const installerMatches = (await readFile(resolve(repo, "ui/public/dsp7-install.py"))).equals(await readFile(resolve(repo, "integrations/dsp7-bridge/quick_install.py")))
    && (await readFile(resolve(repo, "ui/public/dsp7-install.ps1"))).equals(await readFile(resolve(repo, "integrations/dsp7-bridge/install_windows.ps1")));
  const staticFiles = uiDirectory ? await uiStaticManifest(resolve(uiDirectory)) : null;
  return {
    format: 1, generatedAt: new Date().toISOString(),
    source: { commit: git(["rev-parse", "HEAD"]).trim(), dirty: git(["status", "--porcelain", "--untracked-files=normal"]).length > 0 },
    tools: { node: process.version, platform: process.platform, arch: process.arch },
    components,
    database: { expectedLatestMigration: journal.entries.at(-1)?.tag ?? null, appliedMigration: "unverified" },
    bridge: { sha256: bridgeSha256, manifestMatches: bridgeSha256 === manifest.sha256 && manifest.format === 1, installerMatches, installedDevices: "unverified" },
    ui: staticFiles ? { buildSha256: sha(JSON.stringify(Object.entries(staticFiles).sort())), files: Object.keys(staticFiles).length } : { build: "unverified" },
    verification: { tests: "unverified", typecheck: "unverified", build: "unverified", liveAcceptance: "unverified" },
  };
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const args = process.argv.slice(2);
  if (args.length > 1) throw new Error("Usage: node scripts/release-component-manifest.mjs [ui/dist]");
  const manifest = await releaseComponentManifest(root, args[0]);
  console.log(JSON.stringify(manifest, null, 2));
  if (!manifest.bridge.manifestMatches || !manifest.bridge.installerMatches) process.exitCode = 1;
}
