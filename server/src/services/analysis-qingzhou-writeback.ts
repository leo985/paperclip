import { createHash } from "node:crypto";
import { and, desc, eq, gt, isNotNull, ne, sql } from "drizzle-orm";
import { activityLog, agents, analysisExecutions, seatQingzhouAccounts, deliverySnapshots, heartbeatRuns, projects, type Db } from "@paperclipai/db";
import type { AnalysisQingzhouOptions, AnalysisQingzhouWriteback } from "@paperclipai/shared";
import { conflict, notFound } from "../errors.js";
import { containsCredential } from "./managed-sessions.js";
import { qingzhouClient, QINGZHOU_ORIGIN, QingzhouReadError } from "./qingzhou-client.js";
import { secretService } from "./secrets.js";
import { validateAnalysisDelivery } from "./analysis-executions.js";
import { resolveSeatQingzhouCredentials, seatQingzhouLock } from "./seat-qingzhou.js";

type Row = Record<string, any>;
const digest = (value: string) => createHash("sha256").update(value.replace(/\r\n/g, "\n").trim()).digest("hex");
const date = (value: Date) => new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit" }).format(value);
const escape = (value: string) => value.replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
// Escape all model markup: no active HTML, remote images or hidden requests.
export const analysisQingzhouHtml = (markdown: string) => `<pre>${escape(markdown)}</pre>`;

export function qingzhouAnalysisFields(data: Row, demandId: string, demandNo: string) {
  const demand = data?.demandDto;
  if (!demand || String(demand.urid) !== demandId || demand.demandNo !== demandNo) throw new QingzhouReadError("invalid_response");
  const details = data.demandAnalysisDetailsDTO;
  if (details != null && (typeof details !== "object" || Array.isArray(details))) throw new QingzhouReadError("invalid_response");
  const analysis = details?.demandAnalysisDto ?? details ?? {};
  if (typeof analysis !== "object" || Array.isArray(analysis)) throw new QingzhouReadError("invalid_response");
  const result = analysis.analysisResult ?? demand.analysisResult ?? "";
  if (typeof result !== "string") throw new QingzhouReadError("invalid_response");
  return { demand, details, analysis, result };
}

/** Same multipart field contract as qingzhou-ai/save_demand_analysis.py. */
export function buildQingzhouAnalysisForm(source: ReturnType<typeof qingzhouAnalysisFields>, markdown: string, options: AnalysisQingzhouOptions, started: Date, completed: Date) {
  const { demand, details, analysis } = source;
  const scalar = (v: unknown, fallback = "") => {
    if (v == null || v === "") return fallback;
    if (typeof v !== "string" && typeof v !== "number") throw new QingzhouReadError("invalid_response");
    return String(v);
  };
  const commonality = options.workGenerality ?? scalar(analysis.workGenerality, "1");
  const hours = options.workHour ?? scalar(analysis.workHour, "1");
  const start = options.startDate ?? scalar(analysis.startDate, date(started));
  const end = options.endDate ?? scalar(analysis.endDate, date(completed));
  if (!["1", "2"].includes(commonality) || !Number.isFinite(Number(hours)) || Number(hours) <= 0 || !/^\d{4}-\d{2}-\d{2}$/.test(start) || !/^\d{4}-\d{2}-\d{2}$/.test(end) || start > end) {
    throw conflict("轻舟分析的业务共性、工时或起止日期无效，请修改回写参数后重试");
  }
  const fields: Record<string, string> = {
    theme: scalar(demand.theme),
    "demandAnalysisDto.analysisResult": analysisQingzhouHtml(markdown),
    "demandAnalysisDto.jiraAnalysisResult": markdown,
    "demandAnalysisDto.estimateAnalysisWorkHour": scalar(analysis.estimateAnalysisWorkHour ?? details?.estimateAnalysisWorkHour ?? demand.estimateAnalysisWorkHour, "1"),
    "demandAnalysisDto.workHour": hours,
    "demandAnalysisDto.workGenerality": commonality,
    "demandAnalysisDto.startDate": start,
    "demandAnalysisDto.endDate": end,
    "demandAnalysisDto.functionPackage": scalar(analysis.functionPackage ?? details?.functionPackage ?? demand.functionPackage),
  };
  for (const key of ["associateOtherFunctions", "isAcrossSubProduct", "planAttributes"]) fields[`demandAnalysisDto.${key}`] = scalar(analysis[key]);
  if (!fields.theme) throw new QingzhouReadError("invalid_response");
  return fields;
}

/** A frozen local delivery is durable even when an upstream write fails.
 * Serialize all revisions of a demand and seat-account changes through the same
 * locks. A retry reads back first; an ambiguous response never causes a blind write.
 */
export async function writeAnalysisToQingzhou(db: Db, companyId: string, executionId: string,
  actor: { type: "user" | "agent"; id: string }, options?: AnalysisQingzhouOptions,
  dependencies = { fetch: globalThis.fetch, secrets: secretService },
): Promise<AnalysisQingzhouWriteback | null> {
  return db.transaction(async transaction => {
    const tx = transaction as unknown as Db;
    const [initial] = await tx.select().from(analysisExecutions).where(and(eq(analysisExecutions.id, executionId), eq(analysisExecutions.companyId, companyId)));
    if (!initial) throw notFound("分析任务不存在");
    if (!initial.demandNo) return null;
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${companyId + ":analysis-writeback:" + initial.projectId + ":" + initial.demandNo},0))`);
    await tx.execute(seatQingzhouLock(companyId, initial.seatId));
    const [task] = await tx.select().from(analysisExecutions).where(eq(analysisExecutions.id, executionId)).for("update");
    if (!task.delivery) throw conflict("请先完成并核验本地分析交付");
    if (task.qingzhouWriteback?.status === "saved" && task.qingzhouWriteback.reviewStatus === "submitted") return task.qingzhouWriteback;
    let receipt: AnalysisQingzhouWriteback = {
      ...task.qingzhouWriteback, status: "pending", inputDigest: task.delivery.inputDigest,
      options: { ...task.qingzhouWriteback?.options, ...options }, attemptedAt: new Date().toISOString(),
    };
    try {
      validateAnalysisDelivery(task.delivery, task);
      const markdown = task.delivery.analysisMarkdown;
      if (!markdown) throw conflict("当前客户端未上传分析正文；请更新客户端后补传同一版本交付，或建立新修订重新分析");
      if (containsCredential(markdown)) throw conflict("分析正文疑似包含凭据，请脱敏并建立新修订后回写");
      const [project] = await tx.select().from(projects).where(and(eq(projects.id, task.projectId), eq(projects.companyId, companyId)));
      if (!project || project.archivedAt) throw conflict("项目已归档或不属于当前组织");
      const [newer] = await tx.select({ id: analysisExecutions.id }).from(analysisExecutions).where(and(eq(analysisExecutions.companyId, companyId), eq(analysisExecutions.projectId, task.projectId), eq(analysisExecutions.demandNo, task.demandNo!), ne(analysisExecutions.id, task.id), gt(analysisExecutions.createdAt, task.createdAt), isNotNull(analysisExecutions.delivery))).limit(1);
      if (newer) throw conflict("该条目已有更新的分析交付，请使用最新修订，旧版本不会覆盖轻舟");
      const [snapshot] = await tx.select().from(deliverySnapshots).where(and(eq(deliverySnapshots.companyId, companyId), eq(deliverySnapshots.projectId, task.projectId), eq(deliverySnapshots.demandNo, task.demandNo!), eq(deliverySnapshots.sourceOrigin, QINGZHOU_ORIGIN))).orderBy(desc(deliverySnapshots.collectedAt)).limit(1);
      if (!snapshot) throw conflict("请先在当前项目同步该轻舟条目，确认条目归属后重试回写");
      const [seat] = await tx.select().from(agents).where(and(eq(agents.companyId, companyId), eq(agents.id, task.seatId)));
      if (!seat?.adapterConfig.dsp7Seat || seat.status === "terminated") throw conflict("执行席位不存在或已停用，请核对席位身份");
      const [account] = await tx.select().from(seatQingzhouAccounts).where(and(eq(seatQingzhouAccounts.companyId, companyId), eq(seatQingzhouAccounts.seatId, task.seatId))).for("update");
      if (!account?.credentialSecretId) throw conflict("请先在执行席位的接单设置中配置轻舟账号，再重试保存");
      receipt = { ...receipt, credentialSource: "seat", credentialSeatId: task.seatId, seatAccountRevision: account.revision, connectionRevision: undefined };
      const client = qingzhouClient({ fetch: dependencies.fetch, credentials: () => resolveSeatQingzhouCredentials(tx, companyId, account, dependencies.secrets) });
      const demand = await client.demand(task.demandNo!);
      if (demand.demandId !== snapshot.plan.demandId) throw conflict("轻舟条目身份与项目已纳管版本不匹配，请重新同步核对");
      await saveAndSubmitQingzhouAnalysis(client, demand.demandId, task.demandNo!, markdown, receipt, async source => {
        const [run] = task.activeRunId ? await tx.select().from(heartbeatRuns).where(and(eq(heartbeatRuns.id, task.activeRunId), eq(heartbeatRuns.companyId, companyId))) : [];
        return buildQingzhouAnalysisForm(source, markdown, receipt.options ?? {}, run?.startedAt ?? task.updatedAt, task.updatedAt);
      });
    } catch (error) {
      receipt = { ...receipt, status: "failed", error: error instanceof QingzhouReadError
        ? error.code === "source_rejected" ? "轻舟拒绝保存，请核对执行席位的轻舟账号是否为条目分析负责人及条目状态" : error.message
        : error instanceof Error && "status" in error ? error.message : "轻舟回写失败，请核对执行席位的轻舟账号后重试" };
    }
    await tx.update(analysisExecutions).set({ qingzhouWriteback: receipt }).where(eq(analysisExecutions.id, executionId));
    await tx.insert(activityLog).values({ companyId, actorType: actor.type, actorId: actor.id, action: `analysis.qingzhou.${receipt.status}`, entityType: "analysis_execution", entityId: executionId,
      details: { demandNo: task.demandNo, inputDigest: receipt.inputDigest, contentDigest: receipt.contentDigest, credentialSource: receipt.credentialSource, credentialSeatId: receipt.credentialSeatId, seatAccountRevision: receipt.seatAccountRevision, reviewStatus: receipt.reviewStatus, reviewerId: receipt.reviewerId, sourceState: receipt.sourceState, error: receipt.error, reviewError: receipt.reviewError, formalPublication: false } });
    if (receipt.reviewStatus) await tx.insert(activityLog).values({ companyId, actorType: actor.type, actorId: actor.id,
      action: `analysis.qingzhou.review.${receipt.reviewStatus}`, entityType: "analysis_execution", entityId: executionId,
      details: { demandNo: task.demandNo, inputDigest: receipt.inputDigest, reviewerId: receipt.reviewerId, sourceState: receipt.sourceState, error: receipt.reviewError, formalPublication: false } });
    return receipt;
  });
}

/** Use the source-assigned reviewer after saving; never infer a reviewer from a
 * seat owner or perform the review itself. Receipt mutations survive in the
 * caller's catch, so a submission failure retains the verified saved content. */
export async function saveAndSubmitQingzhouAnalysis(
  client: Pick<ReturnType<typeof qingzhouClient>, "detail" | "saveAnalysis" | "applyReview">,
  demandId: string, demandNo: string, markdown: string, receipt: AnalysisQingzhouWriteback,
  form: (source: ReturnType<typeof qingzhouAnalysisFields>) => Promise<Record<string, string>>,
) {
  const read = async () => qingzhouAnalysisFields((await client.detail(demandId)).data.data, demandId, demandNo);
  let source = await read();
  const desired = digest(analysisQingzhouHtml(markdown));
  const state = () => String(source.demand.demandState ?? "");
  const canSubmit = () => ["3", "6", "8", "13"].includes(state()) ||
    (state() === "7" && !receipt.reviewAttemptedAt && ["6", "7", "8", "9"].includes(String(source.demand.areaCode)));
  Object.assign(receipt, { contentDigest: desired, demandId, sourceState: state() });
  if (digest(source.result) !== desired) {
    if (receipt.savedAt || receipt.previousContentDigest && receipt.previousContentDigest !== digest(source.result)) {
      throw conflict("轻舟分析内容已变化，请核对并建立新修订，不覆盖他人修改");
    }
    if (!canSubmit()) throw conflict("轻舟条目当前状态不允许自动保存并申请评审，请核对来源状态");
    receipt.previousContentDigest = digest(source.result);
    await client.saveAnalysis(demandId, await form(source));
    source = await read();
    if (digest(source.result) !== desired) throw conflict("轻舟保存请求已发送，但回读正文不一致；请核对来源后重试");
  }
  Object.assign(receipt, { status: "saved", savedAt: receipt.savedAt ?? new Date().toISOString(), error: undefined,
    reviewStatus: "pending", reviewError: undefined, sourceState: state() });
  try {
    const reviewer = source.demand.reviewer;
    if (typeof reviewer === "number" && !Number.isSafeInteger(reviewer) || !/^[1-9]\d{0,29}$/.test(String(reviewer ?? ""))) {
      throw conflict("正文已保存，但轻舟未配置有效评审人；请在轻舟配置后重试提交评审");
    }
    const reviewerId = String(reviewer);
    if (reviewerId === String(source.demand.requirementer)) throw conflict("轻舟评审人不能与分析负责人相同，请调整评审人后重试");
    receipt.reviewerId = reviewerId;
    if (state() !== "5") {
      if (!canSubmit()) throw conflict("正文已保存，但轻舟状态已变化，不自动回退或重复申请评审，请核对来源状态");
      receipt.reviewAttemptedAt = new Date().toISOString();
      let requestError: unknown;
      try { await client.applyReview(demandId, reviewerId); } catch (error) { requestError = error; }
      // Even an ambiguous response is reconciled by one read, never a blind POST retry.
      source = await read();
      receipt.sourceState = state();
      if (digest(source.result) !== desired) throw conflict("申请评审后轻舟正文已变化，请核对当前版本，不自动覆盖或再次提交");
      if (state() !== "5" || String(source.demand.reviewer) !== reviewerId) {
        if (requestError) throw requestError;
        throw conflict("正文已保存，但尚未核验为“分析完成待评审”或评审人发生变化，请核对后重试");
      }
    }
    Object.assign(receipt, { reviewStatus: "submitted", reviewVerifiedAt: new Date().toISOString(), sourceState: "5" });
  } catch (error) {
    Object.assign(receipt, { reviewStatus: "failed", reviewError: error instanceof QingzhouReadError
      ? error.code === "source_rejected" ? "正文已保存，轻舟拒绝申请评审；请核对分析负责人、评审人与条目状态" : "正文已保存，轻舟评审提交结果尚未核验；请稍后重试，系统将先查询状态"
      : error instanceof Error && "status" in error ? error.message : "正文已保存，提交轻舟评审未完成，请核对后重试" });
  }
}
