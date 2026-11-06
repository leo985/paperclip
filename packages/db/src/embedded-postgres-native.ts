import { promises as fs } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

const require = createRequire(import.meta.url);

function resolveNativePackageName(): string | null {
  if (process.platform === "darwin" && ["arm64", "x64"].includes(process.arch)) {
    return `darwin-${process.arch}`;
  }
  if (process.platform !== "linux") return null;

  switch (process.arch) {
    case "arm64":
      return "linux-arm64";
    case "arm":
      return "linux-arm";
    case "ia32":
      return "linux-ia32";
    case "ppc64":
      return "linux-ppc64";
    case "x64":
      return "linux-x64";
    default:
      return null;
  }
}

async function pathExists(value: string): Promise<boolean> {
  try {
    await fs.stat(value);
    return true;
  } catch {
    return false;
  }
}

function resolveEmbeddedPostgresPackageRoot(): string | null {
  try {
    const entry = require.resolve("embedded-postgres");
    return path.dirname(path.dirname(entry));
  } catch {
    return null;
  }
}

function prependPathEnv(name: string, value: string): void {
  const current = process.env[name] ?? "";
  const parts = current.split(path.delimiter).filter(Boolean);
  if (parts.includes(value)) return;
  process.env[name] = [value, ...parts].join(path.delimiter);
}

export async function ensureLinuxSharedLibraryAliases(libDir: string): Promise<string[]> {
  return ensureSharedLibraryAliases(libDir, /^(lib.+\.so\.\d+)\.\d+(?:\.\d+)?$/);
}

/** npm archives may omit dylib symlinks referenced by the bundled Mach-O files. */
export async function ensureDarwinSharedLibraryAliases(libDir: string): Promise<string[]> {
  const major = await ensureSharedLibraryAliases(libDir, /^(lib.+?\.\d+)\.\d+(?:\.\d+)?\.dylib$/, ".dylib");
  const unversioned = await ensureSharedLibraryAliases(libDir, /^(lib.+?)\.\d+(?:\.\d+)*\.dylib$/, ".dylib");
  return [...major, ...unversioned];
}

async function ensureSharedLibraryAliases(libDir: string, pattern: RegExp, suffix = ""): Promise<string[]> {
  const entries = await fs.readdir(libDir, { withFileTypes: true });
  const created: string[] = [];

  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const match = entry.name.match(pattern);
    if (!match) continue;

    const aliasName = match[1] + suffix;
    const aliasPath = path.join(libDir, aliasName);
    try {
      await fs.symlink(entry.name, aliasPath);
      created.push(aliasPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") continue;
      throw error;
    }
  }

  return created;
}

export async function prepareEmbeddedPostgresNativeRuntime(): Promise<void> {
  const nativePackageName = resolveNativePackageName();
  const packageRoot = resolveEmbeddedPostgresPackageRoot();
  if (!nativePackageName || !packageRoot) return;

  const nativeRoot = path.resolve(packageRoot, "..", "@embedded-postgres", nativePackageName);
  const libDir = path.join(nativeRoot, "native", "lib");
  if (!(await pathExists(libDir))) return;

  if (process.platform === "darwin") {
    await ensureDarwinSharedLibraryAliases(libDir);
  } else {
    prependPathEnv("LD_LIBRARY_PATH", libDir);
    await ensureLinuxSharedLibraryAliases(libDir);
  }
}
