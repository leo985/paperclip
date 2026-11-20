import { and, eq } from "drizzle-orm";
import { activityLog, seatQingzhouAccounts, type Db } from "@paperclipai/db";
import { conflict } from "../errors.js";
import { resolveSeatQingzhouCredentials, seatQingzhouLock } from "./seat-qingzhou.js";

/** Device-only bootstrap. Source documents never transit the control plane. */
export async function analysisQingzhouCredentials(db: Db, scope: {
  task: { id: string; companyId: string; seatId: string; demandNo: string | null; delivery: unknown; publication: unknown };
  run: { id: string };
}) {
  const { task, run } = scope;
  if (!task.demandNo || task.delivery || task.publication) throw conflict("当前分析任务没有可采集的轻舟条目或交付已冻结");
  await db.execute(seatQingzhouLock(task.companyId, task.seatId));
  const [account] = await db.select().from(seatQingzhouAccounts).where(and(
    eq(seatQingzhouAccounts.companyId, task.companyId), eq(seatQingzhouAccounts.seatId, task.seatId),
  )).for("update");
  if (!account?.credentialSecretId) throw conflict("请在执行席位的接单设置中配置轻舟账号");
  const credentials = await resolveSeatQingzhouCredentials(db, task.companyId, account);
  await db.insert(activityLog).values({ companyId: task.companyId, agentId: task.seatId,
    actorType: "agent", actorId: task.seatId, action: "analysis.qingzhou.collection_authorized",
    entityType: "analysis_execution", entityId: task.id,
    details: { runId: run.id, demandNo: task.demandNo, seatAccountRevision: account.revision, collectionLocation: "client" },
  });
  return { demandNo: task.demandNo, seatAccountRevision: account.revision, credentials };
}
