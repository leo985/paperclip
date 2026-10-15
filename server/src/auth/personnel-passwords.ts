import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { hashPassword } from "better-auth/crypto";
import { activityLog, authAccounts, authUsers, companyMemberships, personnelPeople, personnelSources, type Db } from "@paperclipai/db";
import type { RequestHandler } from "express";

/** Initialize only managed directory accounts without a local password. */
export async function initializePersonnelPasswords(db: Db, sourceId?: string, actorId = "scheduler") {
  const candidates = await db.select({ id: personnelPeople.id }).from(personnelPeople)
    .innerJoin(personnelSources, eq(personnelPeople.sourceId, personnelSources.id))
    .where(and(eq(personnelPeople.active, true), eq(personnelPeople.managedAccount, true), eq(personnelSources.enabled, true), ...(sourceId ? [eq(personnelPeople.sourceId, sourceId)] : [])));
  let initialized = 0;
  for (const candidate of candidates) {
    const changed = await db.transaction(async tx => {
      const [person] = await tx.select().from(personnelPeople).where(eq(personnelPeople.id, candidate.id)).for("update");
      if (!person?.userId || !person.active || !person.managedAccount) return false;
      const [source] = await tx.select().from(personnelSources).where(and(eq(personnelSources.id, person.sourceId), eq(personnelSources.enabled, true)));
      const [member] = await tx.select().from(companyMemberships).where(and(eq(companyMemberships.companyId, person.companyId), eq(companyMemberships.principalType, "user"), eq(companyMemberships.principalId, person.userId), eq(companyMemberships.status, "active")));
      if (!source || !member) return false;
      await tx.select().from(authUsers).where(eq(authUsers.id, person.userId)).for("update");
      const [account] = await tx.select().from(authAccounts).where(and(eq(authAccounts.userId, person.userId), eq(authAccounts.providerId, "credential")));
      if (account?.password) return false;
      const password = await hashPassword(process.env.PAPERCLIP_PERSONNEL_INITIAL_PASSWORD ?? "12345");
      if (account) await tx.update(authAccounts).set({ password, updatedAt: new Date() }).where(eq(authAccounts.id, account.id));
      else await tx.insert(authAccounts).values({ id: randomUUID(), issuer: "local:credential", accountId: person.userId, providerId: "credential", userId: person.userId, password, createdAt: new Date(), updatedAt: new Date() });
      await tx.update(personnelPeople).set({ requirePasswordChange: true, activationHash: null, activationExpires: null }).where(eq(personnelPeople.id, person.id));
      await tx.insert(activityLog).values({ companyId: person.companyId, actorType: "system", actorId, action: "personnel.password.initialized", entityType: "user", entityId: person.userId, details: { personId: person.id, requirePasswordChange: true } });
      return true;
    });
    if (changed) initialized++;
  }
  return { initialized };
}

export async function requiresPersonnelPasswordChange(db: Db, userId: string) {
  const [person] = await db.select({ id: personnelPeople.id }).from(personnelPeople)
    .where(and(eq(personnelPeople.userId, userId), eq(personnelPeople.requirePasswordChange, true))).limit(1);
  return !!person;
}

/** Business APIs remain unavailable until the initial password is replaced. */
export function personnelPasswordGate(db: Db): RequestHandler {
  return async (req, res, next) => {
    if (req.actor.type !== "board" || !req.actor.userId || req.path === "/health" || req.path.startsWith("/auth/")) return next();
    try {
      if (await requiresPersonnelPasswordChange(db, req.actor.userId)) {
        res.status(403).json({ error: "请先修改初始密码", code: "PASSWORD_CHANGE_REQUIRED" });
        return;
      }
      next();
    } catch (error) { next(error); }
  };
}
