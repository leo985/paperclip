import type { Db } from "@paperclipai/db";
import type { DeliveryJiraReviewResults, DeliveryPlan } from "@paperclipai/shared";
import { conflict } from "../errors.js";
import { deliveryJiraCredentials } from "./delivery-seat-assignment.js";

const resultField = "customfield_14608";
const completedStatuses = new Set(["已完成", "完成", "已关闭", "关闭", "已解决", "已发版", "已发布", "done", "closed", "resolved", "released"]);
const jiraKey = /^[A-Z][A-Z0-9_]*-\d+$/;
const isReview = (type: string) => /评审|审查/.test(type);
const completed = (status: unknown) => typeof status === "string" && completedStatuses.has(status.trim().toLowerCase());

interface JiraReviewPage {
  startAt: number;
  total: number;
  names?: Record<string, string>;
  issues: Array<{
    key: string;
    fields?: {
      status?: { name?: string };
      parent?: { key?: string };
      issuetype?: { name?: string };
      [resultField]?: unknown;
      attachment?: unknown;
    };
  }>;
}

async function readPage(url: URL, token: string, signal: AbortSignal): Promise<JiraReviewPage> {
  try {
    const response = await fetch(url, {
      headers: { Authorization: "Bearer " + token, Accept: "application/json" },
      redirect: "error",
      signal,
    });
    const reader = response.body?.getReader();
    if (!response.ok || !reader) throw new Error("Jira search failed");
    const decoder = new TextDecoder();
    let body = "";
    let size = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > 2_000_000) throw new Error("Jira search response too large");
        body += decoder.decode(value, { stream: true });
      }
      return JSON.parse(body + decoder.decode());
    } finally {
      await reader.cancel();
    }
  } catch {
    throw conflict("Jira 交付材料读取失败，请核对项目连接与工单权限");
  }
}

function readAttachmentLinks(value: unknown, origin: string) {
  if (!Array.isArray(value)) return [];
  const files = new Map<string, { filename: string; url: string }>();
  for (const attachment of value) {
    const id = String(attachment?.id ?? "");
    const filename = attachment?.filename;
    const content = attachment?.content;
    if (!/^\d+$/.test(id) || typeof filename !== "string" || !filename.trim() || typeof content !== "string") continue;
    const url = URL.canParse(content) ? new URL(content) : null;
    if (!url || url.origin !== origin || url.username || url.password || url.search || url.hash
        || !new RegExp(`^/secure/attachment/${id}/[^/]+$`).test(url.pathname)) continue;
    files.set(id, { filename, url: url.href });
  }
  return [...files.values()];
}

/** Read source files and review text for display alongside platform evidence. */
export async function readDeliveryJiraReviewResults(db: Db, companyId: string, projectId: string, plan: DeliveryPlan): Promise<DeliveryJiraReviewResults> {
  const results: DeliveryJiraReviewResults["results"] = [];
  const attachments: NonNullable<DeliveryJiraReviewResults["attachments"]> = [];
  if (plan.sourceMode !== "online_readonly") return { results };
  const candidates = new Map(plan.items.filter(item => item.parentKey && jiraKey.test(item.key)
    && completed(item.status)).map(item => [item.key, item]));
  if (!candidates.size) return { results };
  if (candidates.size > 1000) throw conflict("条目关联的已完成 Jira 子工单超过读取范围");
  const { origin, token } = await deliveryJiraCredentials(db, companyId, projectId);
  if (plan.monthlyChildIssues?.jiraOrigin && plan.monthlyChildIssues.jiraOrigin !== origin)
    throw conflict("项目 Jira 来源已变更，请重新同步条目");

  const keys = [...candidates.keys()];
  const signal = AbortSignal.timeout(15_000);
  for (let offset = 0; offset < keys.length; offset += 50) {
    const batch = new Set(keys.slice(offset, offset + 50));
    const includesReview = [...batch].some(key => isReview(candidates.get(key)!.type));
    const url = new URL("/rest/api/2/search", origin);
    url.search = new URLSearchParams({
      jql: `key in (${[...batch].map(key => `"${key}"`).join(",")})`,
      fields: `status,parent,issuetype,attachment${includesReview ? "," + resultField : ""}`,
      ...(includesReview ? { expand: "names" } : {}),
      startAt: "0",
      maxResults: "50",
    }).toString();
    const page = await readPage(url, token, signal);
    if (!Array.isArray(page?.issues) || page.startAt !== 0 || page.total !== batch.size || page.issues.length !== batch.size ||
        new Set(page.issues.map(issue => issue?.key)).size !== batch.size || page.issues.some(issue => !batch.has(issue?.key)) ||
        (includesReview && page.names?.[resultField] !== "结果描述")) {
      throw conflict("Jira 子工单或「结果描述」字段未完整返回");
    }
    for (const issue of page.issues) {
      const fields = issue.fields;
      const candidate = candidates.get(issue.key);
      if (!fields || !candidate || fields.parent?.key !== candidate.parentKey
          || fields.issuetype?.name !== candidate.type || !completed(fields.status?.name)) continue;
      const files = readAttachmentLinks(fields.attachment, origin);
      if (files.length) attachments.push({ jiraKey: issue.key, files });
      const description = fields[resultField];
      if (isReview(candidate.type) && typeof description === "string" && description.trim()) {
        results.push({ jiraKey: issue.key, description: description.trim(), url: new URL("/browse/" + issue.key, origin).href });
      }
    }
  }
  return attachments.length ? { results, attachments } : { results };
}
