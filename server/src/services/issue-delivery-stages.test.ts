import { describe, expect, it, vi } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import type { Db } from "@paperclipai/db";
import type { DeliveryStageRecord } from "@paperclipai/shared";
import { listIssueDeliveryStages, projectIssueDeliveryStages } from "./issue-delivery-stages.js";
const record = (taskId: string, stage: string, intent?: string) => ({ taskId, stage, intent }) as DeliveryStageRecord;
describe("task delivery stage projection", () => {
  it("uses explicit associations for work, human reviews and repair cycles, with stable deduplication", () => {
    const result = projectIssueDeliveryStages(["a", "review", "repair", "other"], ["a", "hidden"], [{ stages: [record("a", "analysis"), record("review", "design", "design-review"), record("repair", "functional-test", "retest"), record("repair", "coding", "bugfix"), record("repair", "coding"), record("hidden", "design")] }]);
    expect(Object.fromEntries(result)).toEqual({ a: ["analysis"], review: ["design"], repair: ["coding", "functional-test"], other: [] });
  });
  it("scopes both reads to the company and requested page, and never returns unrelated task IDs", async () => {
    const clauses: unknown[] = [];
    const rows = [[{ id: "a" }], [{ stages: [record("b", "test-cases"), record("hidden", "coding")] }]];
    const db = { select: vi.fn(() => ({ from: () => ({ where: (condition: Parameters<PgDialect["sqlToQuery"]>[0]) => { clauses.push(new PgDialect().sqlToQuery(condition)); return Promise.resolve(rows.shift()); } }) })) };
    const result = await listIssueDeliveryStages(db as unknown as Db, "company", ["a", "b"]);
    expect(Object.fromEntries(result)).toEqual({ a: ["analysis"], b: ["test-cases"] });
    for (const clause of clauses as Array<{ params: string[] }>) expect(clause.params).toEqual(["company", "a", "b"]);
  });
  it("skips an empty page and propagates read failure instead of marking tasks as other", async () => {
    const db = { select: vi.fn(() => { throw Error("read failed"); }) };
    expect((await listIssueDeliveryStages(db as unknown as Db, "company", [])).size).toBe(0);
    expect(db.select).not.toHaveBeenCalled();
    await expect(listIssueDeliveryStages(db as unknown as Db, "company", ["a"])).rejects.toThrow("read failed");
  });
});
