import { describe, expect, it } from "vitest";
import { harnessRepositorySchema, createProjectSchema } from "@paperclipai/shared";
import { seatProjectRepositories } from "./harness-project-repositories.js";
import { resolveProjectRepositorySelection } from "./project-repositories.js";

const now = Date.parse("2026-11-02T08:00:00Z");
const repo = { url: "https://git.example/team/app", ref: "dev" };
const seat = (name: string, repositories: unknown[] = [repo], lastSeenAt = new Date(now).toISOString()) => ({ name, status: "active", adapterConfig: { dsp7SeatPresence: { repositories, lastSeenAt } } });
describe("Harness business repositories", () => {
  it("deduplicates checkouts across seats, retains branches, and exposes no machine paths", () => {
    const result = seatProjectRepositories([seat("A"), seat("B"), seat("C", [{ ...repo, ref: "release" }])], now);
    expect(result).toHaveLength(2);
    expect(result[0]).toMatchObject({ source: "harness", repoRef: "dev", connections: ["A", "B"] });
    expect(result[0].id).toMatch(/^harness:[a-f0-9]{64}$/);
    expect(result[0]).not.toHaveProperty("path");
  });
  it("ignores stale/terminated seats and rejects secret-bearing or path-bearing reports", () => {
    expect(seatProjectRepositories([seat("old", [repo], new Date(now - 90_001).toISOString()), { ...seat("gone"), status: "terminated" }, seat("unsafe", [{ ...repo, url: "https://u:secret@git.example/app" }, { ...repo, path: "/private/checkout" }])], now)).toEqual([]);
    for (const url of ["https://git.example/team/\napp", "file:///tmp/source", "https://git.example/app?token=secret", "https://git.example/team/../source"]) expect(harnessRepositorySchema.safeParse({ ...repo, url }).success).toBe(false);
  });
  it("requires fresh availability for new selections but retains saved offline selections", () => {
    const [available] = seatProjectRepositories([seat("A")], now);
    expect(resolveProjectRepositorySelection([available.id], [available])).toEqual([available]);
    expect(() => resolveProjectRepositorySelection([available.id], [])).toThrow("no longer available");
    expect(resolveProjectRepositorySelection([available.id], [], [{ name: available.fullName, repoUrl: repo.url, metadata: { harnessRepositoryId: available.id } }])[0].source).toBe("harness");
  });
  it("keeps projects without code repositories valid and accepts Harness selections", () => {
    expect(createProjectSchema.safeParse({ name: "Environment tests", repositoryIds: [] }).success).toBe(true);
    expect(createProjectSchema.safeParse({ name: "Coding", repositoryIds: [seatProjectRepositories([seat("A")], now)[0].id] }).success).toBe(true);
  });
});
