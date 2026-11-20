import { createHash } from "node:crypto";
import type { DeliveryPlan, DeliverySnapshotInput } from "@paperclipai/shared";
import { badRequest } from "../errors.js";

type Row = Record<string, any>;
function parse(text: string): Row {
  try {
    // JSON.parse reviver context retains the original numeric token (Node 22+).
    // Never stringify an already-rounded Number as a business identifier.
    return JSON.parse(text, ((_key: string, value: unknown, context?: { source?: string }) => {
      if (typeof value === "number" && !Number.isSafeInteger(value) && Number.isInteger(value)) {
        if (!context?.source) throw Error("无损 JSON 解析需要 Node 22 或更新版本");
        return context.source;
      }
      return value;
    }) as Parameters<typeof JSON.parse>[1]);
  } catch { throw badRequest("快照 JSON 无效，或运行环境不支持无损编号解析"); }
}
function response(text: string): Row {
  const value = parse(text);
  if (!value || typeof value !== "object" || value.success !== true || String(value.code) !== "0") throw badRequest("轻舟返回失败，不能将失败响应作为空数据纳管");
  return value;
}
const text = (value: unknown): string => typeof value === "string" ? value.slice(0, 500) : "";
export const isCancelledJiraDeliveryStatus = (status: string) => /作废|取消|^cancel(?:led|ed)$|^void(?:ed)?$/i.test(status.trim());
const completeJiraStatuses = new Set(["已完成", "完成", "已关闭", "关闭", "已发版", "已发布", "已验收", "done", "closed", "resolved", "released", "accepted"]);
export const isCompletedJiraDeliveryStatus = (status: string) => completeJiraStatuses.has(status.trim().toLowerCase());
function calendarDate(value: unknown): string | null {
  const day = text(value).slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return null;
  const date = new Date(day + "T00:00:00Z");
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === day ? day : null;
}
const id = (value: unknown): string => {
  if (typeof value !== "string" || !/^\d{1,30}$/.test(value)) throw badRequest("来源编号缺失或不完整，请使用原始 JSON 快照");
  return value;
};
const key = (value: unknown): string => {
  if (typeof value !== "string" || !/^[A-Z][A-Z0-9_]*-\d+$/.test(value)) throw badRequest("Jira 工单编号无效");
  return value;
};
function normalize(input: DeliverySnapshotInput, sourceMode: DeliveryPlan["sourceMode"]): DeliveryPlan {
  const demandResponse = response(input.demandJson);
  if (!Array.isArray(demandResponse.rows) || Number(demandResponse.total) !== demandResponse.rows.length) throw badRequest("条目查询未完整返回，请导出完整结果");
  const matches = demandResponse.rows.filter((r: Row) => r.demandNo === input.demandNo);
  if (matches.length !== 1) throw badRequest("请提供唯一且精确匹配的轻舟条目");
  const demand = matches[0]; const demandId = id(demand.urid);
  let sourceAnalysis: DeliveryPlan["sourceAnalysis"];
  if (input.detailJson !== undefined) {
    const detail = response(input.detailJson).data;
    const dto = detail?.demandDto;
    if (!dto || id(dto.urid) !== demandId || dto.demandNo !== input.demandNo) throw badRequest("条目详情与条目不匹配");
    const stages = detail.demandReviewStageDtoList;
    if (stages != null && !Array.isArray(stages)) throw badRequest("条目详情评审阶段格式无效");
    if ((stages?.length ?? 0) > 100 || stages?.some((stage: unknown) => !stage || typeof stage !== "object" || Array.isArray(stage))) throw badRequest("条目详情评审阶段格式无效");
    const result = detail.demandAnalysisDetailsDTO?.demandAnalysisDto?.analysisResult ?? detail.demandAnalysisDetailsDTO?.analysisResult ?? dto.analysisResult;
    // Verified against avatar-proj DemandServiceImpl.detail: status is an IsOrNot
    // processed flag, not a general review-result enum. Zero cannot prove rejection.
    const stageStatus = (stage: Row) => text(stage.statusTranslate) || (stage.status === 1 || stage.status === "1" ? "已处理" : stage.status === 0 || stage.status === "0" ? "未处理" : text(stage.status));
    sourceAnalysis = {
      sourceStatus: text(dto.demandStateTranslate) || text(dto.demandState_show) || text(demand.demandState_show),
      // Missing details are unknown, not evidence that analysis never happened.
      analysisSaved: typeof result === "string" ? !!result.replace(/<[^>]*>/g, "").replace(/&nbsp;|&#160;/gi, " ").trim() : null,
      reviewStages: (stages ?? []).filter((stage: Row) => !["创建人", "项目经理审核", "项目经理验收", "需求拆分人员"].includes(stage.role)).map((stage: Row) => ({ role: text(stage.role), status: stageStatus(stage) })),
    };
    if (sourceAnalysis.sourceStatus && text(demand.demandState_show) && sourceAnalysis.sourceStatus !== text(demand.demandState_show)) throw badRequest("条目状态在读取期间发生变化，请重新同步");
  }
  const analysis = response(input.analysisJson).data;
  if (!analysis || id(analysis.urid) !== demandId || !Array.isArray(analysis.demandIssuePoList)) throw badRequest("分析快照与条目不匹配或缺少主工单清单");
  const mains = analysis.demandIssuePoList.filter((r: Row) => r.del === 0).map((r: Row) => {
    if (id(r.demandId) !== demandId) throw badRequest("主工单所属条目不匹配");
    return { key: key(r.itemNo), sourceId: id(r.urid), title: text(r.theme) };
  }).sort((a: Row,b: Row) => a.key.localeCompare(b.key));
  const mainKeys = new Set<string>(mains.map((r: Row) => r.key));
  if (mainKeys.size !== mains.length || new Set(mains.map((r: Row) => r.sourceId)).size !== mains.length) throw badRequest("主工单身份重复");
  const jira = parse(input.jiraJson);
  if (!Array.isArray(jira.issues) || !Number.isSafeInteger(jira.total) || jira.startAt !== 0 || jira.total !== jira.issues.length) throw badRequest("Jira 快照必须包含 startAt=0、total 及完整 issues，不能使用截断的分页");
  const jiraRows = new Map<string, Row>();
  for (const r of jira.issues) {
    const k = key(r.key);
    if (jiraRows.has(k) || !r.fields?.status?.name || !r.fields?.issuetype?.name) throw badRequest("Jira 工单重复或缺少类型及状态");
    jiraRows.set(k,r);
  }
  for (const k of mainKeys) if (!jiraRows.has(k) || jiraRows.get(k)!.fields.issuetype.subtask !== false) throw badRequest("Jira 快照缺少有效主工单 " + k);
  const scheduled = new Map<string, { parentKey: string; digest: string; dueDate: string | null }>();
  const mainDeadlines = new Map<string, Set<string>>();
  const differences: DeliveryPlan["differences"] = [];
  for (const raw of input.scheduleJsons) {
    const data = response(raw).data;
    if (!Array.isArray(data)) throw badRequest("排期快照缺少完整树结构");
    const roots = data.filter((r: Row) => r.demandNo === input.demandNo && r.urid === demandId);
    if (roots.length !== 1 || (roots[0].children !== null && !Array.isArray(roots[0].children))) throw badRequest("排期快照与条目不匹配或缺少主工单树");
    for (const main of roots[0].children ?? []) {
      const k = key(main.issueNo); const mapped = mains.find((m: Row) => m.key === k);
      if (!mapped || id(main.urid) !== mapped.sourceId || main.parentId !== demandId) throw badRequest("排期主工单业务编号不匹配");
      const mainEnd = calendarDate(main.preEndDate);
      if (mainEnd) {
        const dates = mainDeadlines.get(k) ?? new Set<string>();
        dates.add(mainEnd);
        mainDeadlines.set(k, dates);
      }
      const issueUrid = id(main.issueUrid);
      if (main.children !== null && !Array.isArray(main.children)) throw badRequest("排期主工单缺少子工单数组");
      for (const child of main.children ?? []) {
        // Qingzhou keeps planned child records that have never received a Jira key,
        // including placeholders beneath void mains. They are not Jira issues.
        if (child.issueNo == null || typeof child.issueNo === "string" && !child.issueNo.trim()) continue;
        const ck = key(child.issueNo); id(child.urid);
        if (child.parentId !== issueUrid) throw badRequest("排期父子编号关系无效");
        const digest = JSON.stringify([child.urid, child.parentId, child.status, child.assigneeId, child.preStartDate, child.preEndDate]);
        const prior = scheduled.get(ck);
        if (prior && (prior.parentKey !== k || prior.digest !== digest)) throw badRequest("跨排期上下文内容冲突，请先核对 " + ck);
        scheduled.set(ck,{parentKey:k,digest,dueDate:calendarDate(child.preEndDate)});
      }
    }
  }
  for (const [k,s] of scheduled) {
    const j = jiraRows.get(k);
    if (!j) differences.push({code:"schedule_only",key:k,message:"排期有此工单，Jira 快照未包含；不能推断已删除"});
    else if (j.fields.parent?.key !== s.parentKey) differences.push({code:"parent_mismatch",key:k,message:`轻舟排期父工单为 ${s.parentKey}，Jira 父工单为 ${j.fields.parent?.key ?? "未提供"}；按 Jira 展示，需核对来源归属`});
  }
  const items: DeliveryPlan["items"] = [];
  for (const [k,r] of jiraRows) {
    const f = r.fields; const parentKey = mainKeys.has(k) ? null : key(f.parent?.key);
    if (parentKey && (!mainKeys.has(parentKey) || f.issuetype.subtask !== true)) throw badRequest("Jira 快照混入其他需求或非真实子单 " + k);
    if (Array.isArray(f.subtasks)) for (const c of f.subtasks) if (!jiraRows.has(key(c.key))) throw badRequest("Jira 主工单子单未完整返回 " + c.key);
    if (parentKey && !scheduled.has(k)) differences.push({code:"jira_only",key:k,message:"Jira 子工单未出现在所提供排期中，需核对新增或替代关系"});
    if (parentKey && /作废|取消/.test(f.status.name)) differences.push({code:"void",key:k,message:"来源显示作废/取消；保留身份，不自动派发或推定替代关系"});
    items.push({key:k,parentKey,title:text(f.summary),type:text(f.issuetype.name),status:text(f.status.name),assignee:text(f.assignee?.displayName || f.assignee?.name),scheduled:scheduled.has(k)});
  }
  items.sort((a,b)=>a.key.localeCompare(b.key)); differences.sort((a,b)=>(a.key+a.code).localeCompare(b.key+b.code));
  const content = {demandId,demandNo:input.demandNo,title:text(demand.theme),status:text(demand.demandState_show),...(sourceAnalysis ? {sourceAnalysis} : {}),roles:[{label:"需求分析",name:text(demand.requirementer_show)},{label:"条目研发负责人",name:text(demand.splitter_show)},{label:"需求评审",name:text(demand.reviewer_show)},{label:"条目当前经办人",name:text(demand.assignee_show)}],mains,items,scheduleCount:scheduled.size,differences,sourceMode,executionAllowed:false as const};
  // Raw digests retain provenance for source fields not rendered by this read model.
  const sourceDigests = [input.demandJson,input.analysisJson,...(input.detailJson === undefined ? [] : [input.detailJson]),input.jiraJson,...input.scheduleJsons].map(v=>createHash("sha256").update(v).digest("hex")).sort();
  const monthlyChildIssues: NonNullable<DeliveryPlan["monthlyChildIssues"]> = { issues: {} };
  const demandEnd = calendarDate(demand.estimatedDeliveryDate);
  for (const item of items) {
    if (!item.parentKey) continue;
    const fields = jiraRows.get(item.key)!.fields;
    const dates = mainDeadlines.get(item.parentKey);
    const mainEnd = dates?.size === 1 ? [...dates][0] : null;
    const childSchedule = scheduled.get(item.key);
    const childEnd = childSchedule?.parentKey === item.parentKey ? childSchedule.dueDate : null;
    const fallback = (dates?.size ?? 0) > 1 ? null : demandEnd;
    monthlyChildIssues.issues[item.key] = {
      dueDate: childEnd ?? mainEnd ?? fallback,
      deadlineSource: childEnd ? "child" : mainEnd ? "main" : fallback ? "demand" : null,
      account: text(fields.assignee?.name ?? fields.assignee?.accountId),
      cancelled: isCancelledJiraDeliveryStatus(item.status),
      done: fields.status.statusCategory?.key === "done" || isCompletedJiraDeliveryStatus(item.status),
    };
  }
  return {...content,monthlyChildIssues,fingerprint:createHash("sha256").update(JSON.stringify([content,sourceDigests])).digest("hex")};
}

export function normalizeDeliverySnapshot(input: DeliverySnapshotInput, sourceMode: DeliveryPlan["sourceMode"] = "manual_snapshot"): DeliveryPlan {
  try { return normalize(input, sourceMode); } catch (error) {
    if (error instanceof Error && "status" in error) throw error;
    throw badRequest("快照结构无效，请检查完整的原始来源响应");
  }
}
