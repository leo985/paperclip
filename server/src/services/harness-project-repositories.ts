import { createHash } from "node:crypto";
import { harnessRepositorySchema, type ProjectRepository } from "@paperclipai/shared";

/** Only call with company-scoped seats visible to the responsible board user. */
export function seatProjectRepositories(seats: Array<{ name: string; status: string; adapterConfig: Record<string, unknown> }>, now = Date.now()): ProjectRepository[] {
  const repositories = new Map<string, ProjectRepository>();
  for (const seat of seats) {
    if (seat.status === "terminated") continue;
    const presence = seat.adapterConfig.dsp7SeatPresence as { lastSeenAt?: string; repositories?: unknown[] } | undefined;
    const age = now - Date.parse(presence?.lastSeenAt ?? "");
    if (!Number.isFinite(age) || age < 0 || age > 90_000 || !Array.isArray(presence?.repositories)) continue;
    for (const value of presence.repositories.slice(0, 100)) {
      const parsed = harnessRepositorySchema.safeParse(value);
      if (!parsed.success) continue;
      const { url, ref } = parsed.data;
      const id = "harness:" + createHash("sha256").update(JSON.stringify([url, ref])).digest("hex");
      const previous = repositories.get(id);
      repositories.set(id, { id, fullName: new URL(url).pathname.slice(1).replace(/\.git$/, ""), url, repoRef: ref, source: "harness", connections: [...new Set([...(previous?.connections ?? []), seat.name])] });
    }
  }
  return [...repositories.values()];
}
