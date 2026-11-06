import type { Db } from "@paperclipai/db";
import { budgetService } from "./budgets.js";
import { conflict } from "../errors.js";

/** Uses the native ledger and every applicable policy. Control/receipt traffic
 * deliberately does not call this gate, so paused devices can still stop/report. */
export async function assertSeatBudgetAdmission(db: Db, input: {
  companyId: string; agentId: string; projectId: string | null; taskId: string;
}) {
  const block = await budgetService(db).getInvocationBlock(input.companyId, input.agentId, {
    issueId: input.taskId, projectId: input.projectId,
  });
  if (block) throw conflict(`执行暂不可用：${block.reason} 请在用量与预算中处理后重新派发。`);
}
