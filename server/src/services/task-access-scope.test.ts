import { describe, expect, it } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import type { Db } from "@paperclipai/db";
import type { AuthorizationActor } from "./authorization.js";
import { personalTaskScope, taskScopeAllows, taskScopeCondition } from "./task-access-scope.js";
function database(roles: unknown[][]) {
  let calls = 0;
  const db = { select: () => { const rows = roles[calls++]; if (!rows) throw Error("Unexpected query"); const q = { from: () => q, where: () => q, limit: () => Promise.resolve(rows), then: (resolve: (rows: unknown[]) => unknown) => Promise.resolve(rows).then(resolve) }; return q; } };
  return { db: db as unknown as Db, calls: () => calls };
}
const member = (): AuthorizationActor => ({ type: "board", source: "session", userId: "me" });
describe("personal AI task access", () => {
  it.each(["owner", "admin"])("keeps organization scope for %s", async role => {
    const { db } = database([[], [{ role }]]);
    expect(await personalTaskScope(db, member(), "company")).toBeUndefined();
  });
  it.each(["member", "operator", "viewer"])("restricts %s to human assignment and currently owned seats", async role => {
    const actor = member(); const { db, calls } = database([[], [{ role }], [
      { id: "owned", adapterConfig: { dsp7WebJiraIntake: true, dsp7Seat: { ownerUserId: "me" } } },
      { id: "legacy", adapterConfig: { dsp7WebJiraIntake: true, dsp7Seat: { intakeUserIds: ["me"] } } },
      { id: "other", adapterConfig: { dsp7WebJiraIntake: true, dsp7Seat: { ownerUserId: "other", intakeUserIds: ["me"] } } },
      { id: "agent", adapterConfig: { dsp7Seat: { ownerUserId: "me" } } },
    ]]);
    const scope = await personalTaskScope(db, actor, "company");
    expect(scope).toEqual({ userId: "me", seatIds: ["owned", "legacy"] });
    expect(taskScopeAllows(scope, { assigneeUserId: "me" })).toBe(true);
    expect(taskScopeAllows(scope, { assigneeAgentId: "owned" })).toBe(true);
    expect(taskScopeAllows(scope, { assigneeAgentId: "other" })).toBe(false);
    expect(taskScopeAllows(scope, {})).toBe(false);
    expect(await personalTaskScope(db, actor, "company")).toBe(scope); expect(calls()).toBe(3);
  });
  it("fails closed without membership or user identity", async () => {
    const { db } = database([[], []]); const scope = await personalTaskScope(db, member(), "other-company");
    expect(taskScopeAllows(scope, { assigneeUserId: "me" })).toBe(false);
    expect(taskScopeAllows(await personalTaskScope(database([]).db, { type: "board" }, "company"), {})).toBe(false);
  });
  it("leaves agent authorization and local/admin contexts to existing policy", async () => {
    const { db } = database([]);
    for (const actor of [{ type: "agent" }, { type: "board", source: "local_implicit" }, { type: "board", isInstanceAdmin: true }] as AuthorizationActor[]) expect(await personalTaskScope(db, actor, "company")).toBeUndefined();
  });
  it("does not retain ownership or role caches across requests or companies", async () => {
    const { db } = database([[], [{ role: "member" }], [], [], [{ role: "admin" }], [], [{ role: "member" }], []]); const actor = member();
    expect(await personalTaskScope(db, actor, "one")).toEqual({ userId: "me", seatIds: [] });
    expect(await personalTaskScope(db, actor, "two")).toBeUndefined();
    expect(await personalTaskScope(db, member(), "one")).toEqual({ userId: "me", seatIds: [] });
  });
  it("uses a parameterized OR boundary which cannot be broadened by an unrelated query filter", () => {
    const dialect = new PgDialect(); const q = dialect.sqlToQuery(taskScopeCondition({ userId: "me", seatIds: ["seat"] }));
    expect(q.params).toEqual(["me", "seat"]); expect(q.sql).toContain('"issues"."assignee_user_id"'); expect(q.sql).toContain(' or ');
    expect(dialect.sqlToQuery(taskScopeCondition({ userId: "", seatIds: [] })).sql).toBe("false");
  });
});
