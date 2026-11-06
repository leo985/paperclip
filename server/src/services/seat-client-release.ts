import { readFile } from "node:fs/promises";

export async function publishedSeatDigest(): Promise<string> {
  for (const candidate of ["../../ui-dist/", "../../../ui/dist/", "../../../ui/public/"]) {
    let raw: string;
    try { raw = await readFile(new URL(candidate + "dsp7-bridge-manifest.json", import.meta.url), "utf8"); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") continue; throw error; }
    const value = JSON.parse(raw) as { format?: number; sha256?: string };
    if (value.format !== 1 || !/^[a-f0-9]{64}$/.test(value.sha256 ?? "")) throw new Error("客户端发布清单无效");
    return value.sha256!;
  }
  throw new Error("未找到客户端发布清单");
}
