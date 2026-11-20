import { createHash } from "node:crypto";
import type { Db } from "@paperclipai/db";
import { matchesDeliveryWorkType, type DeliveryPriorCompletion, type DeliveryStageRecord } from "@paperclipai/shared";
import { deliveryJiraCredentials } from "./delivery-seat-assignment.js";
import { conflict, HttpError } from "../errors.js";

type Evidence = NonNullable<NonNullable<DeliveryStageRecord["priorCompletion"]>["jiraEvidence"]>;
const completed = new Set(["已完成", "完成", "已关闭", "关闭", "已发版", "已发布", "done", "closed", "resolved", "released"]);
// Jira exposes this instance's formal result field on review and test screens.
const resultField = "customfield_14608";
const resultFieldName = "结果描述";

function explicitReviewPass(result: string) {
  const unresolved = /(?:未|不|没|拒绝|待|有条件)\s*(?:同意|建议|予以|予)?\s*(?:评审|审核)?\s*通过|待整改|待复核|(?:整改|修改|修复)后|\b(?:not passed|not approved|failed|rejected|conditionally approved)\b/i;
  if (unresolved.test(result))
    return false;
  return /(?:^|[，,；;。\n：:\s])(?:已?通过|评审通过|审核通过|同意通过|pass(?:ed)?|approved)[。．.!！\s]*$/i.test(result);
}

function explicitTestPass(result: string) {
  if (/部分|未|不通过|失败|阻塞|跳过|条件|待复测|待回归/.test(result)) return false;
  return /(?:^|[，,；;。\n：:\s])(?:(?:人工|功能|回归)?测试(?:全部|均)?|(?:全部)?用例(?:全部|均)?)\s*(?:已)?通过[。．.!！\s]*$/.test(result);
}

const hash = (data: string | Uint8Array) => createHash("sha256").update(data).digest("hex");
export class MissingJiraPriorEvidence extends HttpError {
  constructor(message: string) {
    super(409, message);
  }
}
export class UnconfirmedJiraReviewResult extends MissingJiraPriorEvidence {}
async function bounded(response: Response, limit: number) {
  if (!response.ok || !response.body) throw conflict("读取 Jira 已有交付失败，请核对项目连接与附件权限");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = []; let size = 0;
  try {
    for (;;) {
      const {done, value} = await reader.read(); if (done) break;
      size += value.length;
      if (size > limit) throw conflict("Jira 已有交付超过读取限制，请人工核对材料");
      chunks.push(value);
    }
  } finally { await reader.cancel(); }
  return Buffer.concat(chunks);
}
/** Import historical evidence, never synthesize an execution receipt or review approval. */
export async function readJiraPriorCompletion(db: Db, companyId: string, projectId: string,
  prior: DeliveryPriorCompletion, parentKey: string, review: boolean) {
  const key = prior.jiraKey;
  if (!key || !/^[A-Z][A-Z0-9_]*-\d+$/.test(key)) throw conflict("已有交付缺少有效 Jira 工单");
  const {origin, token} = await deliveryJiraCredentials(db, companyId, projectId);
  const get = async (url: URL, limit: number) => {
    try {
      return await bounded(await fetch(url, {headers:{Authorization:"Bearer " + token, Accept:"application/json"},
        redirect:"error", signal:AbortSignal.timeout(15000)}), limit);
    } catch { throw conflict(key + " 已有材料读取失败或超过限制，请核对 Jira 来源及权限"); }
  };
  const issueUrl = new URL("/rest/api/2/issue/" + key, origin);
  const fields = ["status", "updated", "parent", "issuetype", "attachment", "comment"];
  const functionalTest = prior.stage === "functional-test";
  if (review || functionalTest) {
    fields.push(resultField);
    issueUrl.searchParams.set("expand", "names");
  }
  issueUrl.searchParams.set("fields", fields.join(","));
  const row = JSON.parse((await get(issueUrl, 2 * 1024 * 1024)).toString());
  const f = row.fields;
  if (row.key !== key || f?.parent?.key !== parentKey || !matchesDeliveryWorkType(prior.stage, review, f?.issuetype?.name ?? "") ||
    !completed.has(String(f?.status?.name).trim().toLowerCase()) || typeof f.updated !== "string")
    throw conflict(key + " 当前类型、父工单或完成状态已变化，请重新同步");
  if (!Array.isArray(f.attachment) || f.attachment.length > 20) throw conflict(key + " 附件过多或未完整返回，请人工核对");
  const evidence: Evidence = {updated:f.updated, status:f.status.name, artifacts:[], comments:[]};
  if ((review || functionalTest) && row.names?.[resultField] === resultFieldName && typeof f[resultField] === "string") {
    const result = f[resultField].trim();
    if (result && review) {
      if (!explicitReviewPass(result))
        throw new UnconfirmedJiraReviewResult(key + " 的 Jira 结果描述没有明确的通过结论，请按正式流程人工核验");
      evidence.reviewResult = result;
    }
    if (result && functionalTest) {
      if (!explicitTestPass(result))
        throw new MissingJiraPriorEvidence(key + " 的 Jira 结果描述没有明确的测试通过结论，请核对正式测试结果");
      evidence.testResult = result;
    }
  }
  let total = 0;
  for (const a of f.attachment) {
    const url = new URL(a.content);
    if (url.origin !== origin || url.username || url.password || url.search || url.hash ||
      !/^\d+$/.test(String(a.id)) || !new RegExp("^/secure/attachment/" + a.id + "/[^/]+$").test(url.pathname) ||
      typeof a.filename !== "string" || !Number.isInteger(a.size) || a.size <= 0 || a.size > 10*1024*1024 || (total += a.size) > 50*1024*1024)
      throw conflict(key + " 附件来源或大小无效，请人工核对");
    const bytes = await get(url, Math.min(a.size, 10*1024*1024));
    if (bytes.length !== a.size) throw conflict(key + " 附件长度已变化，请重新读取");
    evidence.artifacts.push({path:a.filename, sha256:hash(bytes), downloadUrl:url.href});
  }
  const comments = f.comment;
  if (!Array.isArray(comments?.comments) || comments.total !== comments.comments.length || comments.total > 100)
    throw conflict(key + " 完成评论未完整返回，请人工核对");
  evidence.comments = comments.comments.map((c: {id:string;body:string;updated:string}) => {
    if (typeof c.id !== "string" || typeof c.body !== "string" || typeof c.updated !== "string") throw conflict(key + " 评论格式无效");
    return {id:c.id, body:c.body, updated:c.updated};
  });
  if (functionalTest && !evidence.testResult && prior.passedTests === undefined)
    throw new MissingJiraPriorEvidence(key + " 缺少明确通过的 Jira 测试结果或已核对的用例总数");
  if (!evidence.artifacts.length && !evidence.testResult && (!review || (!evidence.comments.length && !evidence.reviewResult)))
    throw new MissingJiraPriorEvidence(key + " 没有可下载的交付附件" + (review ? "、明确通过的结果描述或评审评论" : "") + "，请先补充 Jira 材料");
  // Reject an issue edited while its attachment bytes were being read.
  const fresh = JSON.parse((await get(issueUrl, 2*1024*1024)).toString());
  if (fresh.fields?.updated !== f.updated || JSON.stringify(fresh.fields) !== JSON.stringify(f) ||
    ((evidence.reviewResult || evidence.testResult) && fresh.names?.[resultField] !== resultFieldName)) throw conflict(key + " 材料在读取期间发生变化，请重试");
  return {...prior, version:"jira:" + key + ":" + hash(JSON.stringify(evidence)),
    artifactReferences:evidence.artifacts.length ? evidence.artifacts.map(a=>a.downloadUrl) : [origin + "/browse/" + key],
    reviewReference:origin + "/browse/" + key, jiraEvidence:evidence};
}
