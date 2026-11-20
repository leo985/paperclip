import { and, eq, sql } from "drizzle-orm";
import { companySecrets, seatQingzhouAccounts, type Db } from "@paperclipai/db";
import type { SeatQingzhouAccount } from "@paperclipai/shared";
import { QingzhouReadError } from "./qingzhou-client.js";
import { secretService } from "./secrets.js";

export type SeatQingzhouRow = typeof seatQingzhouAccounts.$inferSelect;
export const seatQingzhouLock = (companyId: string, seatId: string) =>
  sql`select pg_advisory_xact_lock(hashtextextended(${companyId + ":seat-qingzhou:" + seatId},0))`;

export function publicSeatQingzhouAccount(seatId: string, row?: SeatQingzhouRow): SeatQingzhouAccount {
  return {
    seatId, username: row?.username ?? null, configured: !!row?.credentialSecretId,
    revision: row?.revision ?? 0,
    lastCheckStatus: row?.lastCheckStatus === "valid" ? "valid" : row?.lastCheckStatus === "failed" ? "failed" : "not_checked",
    lastCheckedAt: row?.lastCheckedAt?.toISOString() ?? null,
    updatedAt: row?.updatedAt?.toISOString() ?? null,
  };
}

/** Resolve only the bound seat's encrypted account; never borrow project credentials. Call inside a transaction. */
export async function resolveSeatQingzhouCredentials(db: Db, companyId: string, account: SeatQingzhouRow, secrets = secretService) {
  if (account.companyId !== companyId || !account.credentialSecretId || !account.username) throw new QingzhouReadError("authentication_required");
  const secret = await lockSeatQingzhouSecret(db, companyId, account.credentialSecretId);
  try {
    const value = JSON.parse(await secrets(db).resolveSecretValue(companyId, secret.id, "latest"));
    if (value.username !== account.username || typeof value.password !== "string" || !value.password) throw Error();
    return { username: account.username, password: value.password };
  } catch { throw new QingzhouReadError("authentication_required"); }
}

export async function lockSeatQingzhouSecret(db: Db, companyId: string, secretId: string, activeOnly = true) {
  const [secret] = await db.select().from(companySecrets).where(and(eq(companySecrets.companyId, companyId), eq(companySecrets.id, secretId))).for("update");
  if (!secret || secret.scope !== "company" || (activeOnly && (secret.deletedAt || secret.status !== "active"))) throw new QingzhouReadError("authentication_required");
  return secret;
}
