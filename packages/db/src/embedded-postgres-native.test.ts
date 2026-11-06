import childProcess from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { afterEach, describe, expect, it } from "vitest";
import { ensureDarwinSharedLibraryAliases, ensureLinuxSharedLibraryAliases, prepareEmbeddedPostgresNativeRuntime } from "./embedded-postgres-native.js";

const require = createRequire(import.meta.url);

describe("embedded Postgres native runtime", () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const tempDir of tempDirs.splice(0)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it.runIf(process.platform !== "win32")("creates soname aliases for bundled patch-level shared libraries", async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "paperclip-embedded-pg-libs-"));
    tempDirs.push(tempDir);
    fs.writeFileSync(path.join(tempDir, "libicuuc.so.60.2"), "");
    fs.writeFileSync(path.join(tempDir, "libicui18n.so.60.2"), "");
    fs.writeFileSync(path.join(tempDir, "README.md"), "");

    const created = await ensureLinuxSharedLibraryAliases(tempDir);

    expect(created.map((file) => path.basename(file)).sort()).toEqual([
      "libicui18n.so.60",
      "libicuuc.so.60",
    ]);
    expect(fs.readlinkSync(path.join(tempDir, "libicuuc.so.60"))).toBe("libicuuc.so.60.2");
  });

  it.runIf(process.platform !== "win32")("is idempotent when aliases already exist", async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "paperclip-embedded-pg-libs-"));
    tempDirs.push(tempDir);
    fs.writeFileSync(path.join(tempDir, "libicuuc.so.60.2"), "");

    await ensureLinuxSharedLibraryAliases(tempDir);
    const second = await ensureLinuxSharedLibraryAliases(tempDir);

    expect(second).toEqual([]);
    expect(fs.readlinkSync(path.join(tempDir, "libicuuc.so.60"))).toBe("libicuuc.so.60.2");
  });

  it("keeps the child process API untouched while preparing the runtime", async () => {
    const originalSpawn = childProcess.spawn;

    await prepareEmbeddedPostgresNativeRuntime();

    expect(childProcess.spawn).toBe(originalSpawn);
  });

  it.runIf(process.platform !== "win32")("repairs missing Darwin dylib aliases without replacing existing files", async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "paperclip-darwin-pg-libs-"));
    tempDirs.push(tempDir);
    for (const name of ["libicudata.77.1.dylib", "libz.1.3.1.dylib", "libcrypto.3.dylib", "README.md"])
      fs.writeFileSync(path.join(tempDir, name), "fixture");
    fs.writeFileSync(path.join(tempDir, "libz.1.dylib"), "existing");
    expect((await ensureDarwinSharedLibraryAliases(tempDir)).map(p => path.basename(p)).sort()).toEqual(["libcrypto.dylib", "libicudata.77.dylib", "libicudata.dylib", "libz.dylib"]);
    expect(fs.readlinkSync(path.join(tempDir, "libicudata.77.dylib"))).toBe("libicudata.77.1.dylib");
    expect(fs.readFileSync(path.join(tempDir, "libz.1.dylib"), "utf8")).toBe("existing");
    expect(await ensureDarwinSharedLibraryAliases(tempDir)).toEqual([]);
  });

  it("uses the dependency-scoped portable locale patch", () => {
    const source = fs.readFileSync(require.resolve("embedded-postgres"), "utf8");

    expect(source).toContain("const LC_MESSAGES_LOCALE = 'C';");
    expect(source).toContain("globalThis.process.env");
  });
});
