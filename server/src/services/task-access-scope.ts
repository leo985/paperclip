import { and, eq, inArray, or, sql, type SQL } from "drizzle-orm";
import { agents, companyMemberships, instanceUserRoles, issues, type Db } from "@paperclipai/db";
import type { AuthorizationActor } from "./authorization.js";

export type PersonalTaskScope = { userId: string; seatIds: string[] };
export function seatOwnerId(seat: Record<string, unknown> | undefined): string | null {
  return typeof seat?.ownerUserId === "string" ? seat.ownerUserId : Array.isArray(seat?.intakeUserIds) && typeof seat.intakeUserIds[0] === "string" ? seat.intakeUserIds[0] : null;
}

// Actor objects are request-local. Never cache role/seat ownership across requests.
const scopes = new WeakMap<AuthorizationActor, Map<string, Promise<PersonalTaskScope | undefined>>>();
export function personalTaskScope(db: Pick<Db, "select">, actor: AuthorizationActor, companyId: string): Promise<PersonalTaskScope | undefined> {
  if (actor.type !== "board" || actor.source === "local_implicit") return Promise.resolve(undefined);
  let memo = scopes.get(actor);
  if (!memo) { memo = new Map(); scopes.set(actor, memo); }
  let pending = memo.get(companyId);
  if (!pending) {
    pending = resolve(); memo.set(companyId, pending);
  }
  return pending;
  async function resolve(): Promise<PersonalTaskScope | undefined> {
    const userId = actor.userId ?? "";
    if (!actor.ignoreInstanceAdmin && actor.isInstanceAdmin) return undefined;
    if (!userId) return { userId, seatIds: [] };
    if (!actor.ignoreInstanceAdmin && actor.source !== "cloud_tenant") {
      const [admin] = await db.select({ id: instanceUserRoles.id }).from(instanceUserRoles).where(and(eq(instanceUserRoles.userId, userId), eq(instanceUserRoles.role, "instance_admin"))).limit(1);
      if (admin) return undefined;
    }
    const [membership] = await db.select({ role: companyMemberships.membershipRole }).from(companyMemberships).where(and(eq(companyMemberships.companyId, companyId), eq(companyMemberships.principalType, "user"), eq(companyMemberships.principalId, userId), eq(companyMemberships.status, "active"))).limit(1);
    if (membership && ["owner", "admin"].includes(membership.role ?? "")) return undefined;
    if (!membership) return { userId: "", seatIds: [] };
    const seats = await db.select({ id: agents.id, adapterConfig: agents.adapterConfig }).from(agents).where(eq(agents.companyId, companyId));
    return { userId, seatIds: seats.filter(a => a.adapterConfig.dsp7WebJiraIntake === true && seatOwnerId(a.adapterConfig.dsp7Seat as Record<string, unknown> | undefined) === userId).map(a => a.id) };
  }
}
export function taskScopeCondition(scope: PersonalTaskScope | undefined): SQL {
  if (!scope) return sql`true`;
  if (!scope.userId) return sql`false`;
  return or(eq(issues.assigneeUserId, scope.userId), scope.seatIds.length ? inArray(issues.assigneeAgentId, scope.seatIds) : sql`false`)!;
}
export function taskScopeAllows(scope: PersonalTaskScope | undefined, issue: { assigneeUserId?: string | null; assigneeAgentId?: string | null }) {
  return !scope || Boolean(scope.userId && (issue.assigneeUserId === scope.userId || issue.assigneeAgentId && scope.seatIds.includes(issue.assigneeAgentId)));
}
