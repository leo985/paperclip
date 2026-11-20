import type { Db } from "@paperclipai/db";
import { conflict } from "../errors.js";

/** Compatibility fence: QA repair must reuse the workflow's existing Jira identities. */
export async function repairJiraClient(_db: Db, _companyId: string, _projectId: string): Promise<never> {
  throw conflict("已停用自动修复 Jira 建单：请复用原编码、原代码评审和原功能测试工单");
}
