#!/usr/bin/env node
// Static UI releases exclude only exact root-level client-distribution artifacts.
// A basename prefix must never filter hashed modules under assets/.
import { readdir, readFile } from "node:fs/promises";
import { resolve, relative, sep } from "node:path";
import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";
const clientArtifacts = new Set([
  "dsp7-install.py", "dsp7-install.ps1", "dsp7-bridge.zip", "dsp7-bridge-manifest.json",
]);
export const isUiStaticReleaseFile = path => !clientArtifacts.has(path.replaceAll("\\", "/"));
export async function uiStaticManifest(directory) {
  const root = resolve(directory), files = {};
  async function walk(path) {
    for (const entry of await readdir(path, { withFileTypes: true })) {
      const full = resolve(path, entry.name);
      if (entry.isSymbolicLink()) throw new Error("UI release cannot include symlinks");
      if (entry.isDirectory()) await walk(full);
      else if (entry.isFile()) {
        const name = relative(root, full).split(sep).join("/");
        if (isUiStaticReleaseFile(name)) files[name] = createHash("sha256").update(await readFile(full)).digest("hex");
      }
    }
  }
  await walk(root);
  if (!files["index.html"]) throw new Error("UI build has no index.html");
  return files;
}
export async function verifyUiStaticManifest(files, baseUrl, fetcher = fetch) {
  const base = new URL(baseUrl);
  if (!["http:", "https:"].includes(base.protocol) || base.username || base.password || base.search || base.hash) throw new Error("Expected a server HTTP(S) URL without credentials, query or hash");
  const pending = Object.entries(files), failures = [];
  let verified = 0;
  await Promise.all(Array.from({length:8}, async () => {
    while (pending.length) {
      const [name, digest] = pending.pop();
      try {
        const response = await fetcher(new URL("/" + name.split("/").map(encodeURIComponent).join("/"), base), {cache:"no-store", signal:AbortSignal.timeout(20000)});
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        if (/\.m?js$/.test(name) && !/javascript/.test(response.headers.get("content-type") ?? "")) throw new Error("JavaScript MIME mismatch");
        if (/\.css$/.test(name) && !/text\/css/.test(response.headers.get("content-type") ?? "")) throw new Error("CSS MIME mismatch");
        const actual = createHash("sha256").update(Buffer.from(await response.arrayBuffer())).digest("hex");
        if (actual !== digest) throw new Error("SHA-256 mismatch");
        verified++;
      } catch (error) { failures.push({file:name, error:error.message}); }
    }
  }));
  return {verified, failures};
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [command, directory, baseUrl] = process.argv.slice(2);
  if (!["manifest", "verify"].includes(command) || !directory || (command === "verify" && !baseUrl)) throw new Error("Usage: node scripts/ui-static-release.mjs manifest <ui/dist> | verify <ui/dist> <server-url>");
  const files = await uiStaticManifest(directory);
  const result = command === "manifest" ? files : await verifyUiStaticManifest(files, baseUrl);
  console.log(JSON.stringify(result, null, 2));
  if (result.failures?.length) process.exitCode = 1;
}
