import { Router, type Request } from "express";
import { and, desc, eq, inArray, isNull } from "drizzle-orm";
import { activityLog, agents, heartbeatRuns, issueComments, issues, type Db } from "@paperclipai/db";
import { z } from "zod";
import { badRequest, conflict, forbidden } from "../errors.js";
import { secretService } from "../services/secrets.js";
import { canCreateSeatIntake } from "./dsp7-seat-owners.js";

type Agent = typeof agents.$inferSelect;
type Intake = { version: number; seat_id: string; jira_key: string; project_id: string; workspace_id?: string };
export type JiraIntakeSnapshot = { jiraKey: string; summary: string; status: string; issueType: string; assignee: string | null; assigneeName: string | null; jiraUpdatedAt: string | null; checkedAt: string; eligible: boolean; reasons: string[]; ruleRevision: number };

export function readSeatIntake(agent: Agent, task: typeof issues.$inferSelect) {
  const raw = task.description?.match(/<!-- DSP7-JIRA-INTAKE (.*?) -->/)?.[1];
  let intake: Intake;
  try { intake = JSON.parse(raw ?? ""); } catch { throw badRequest("接入申请内容无效"); }
  if (![2, 3, 4].includes(intake.version) || intake.seat_id !== agent.id || task.companyId !== agent.companyId || intake.project_id !== task.projectId || !/^[A-Z][A-Z0-9_]*-\d+$/.test(intake.jira_key)) throw forbidden("接入申请与席位、组织或项目不一致");
  return { raw: raw!, intake };
}

export function jiraIntakeReasons(rule: Record<string, any>, intake: Intake, fields: Record<string, any>) {
  const reasons: string[] = [];
  if (rule.projectId !== intake.project_id) reasons.push("项目与席位接单设置不一致");
  if (!intake.jira_key.startsWith(rule.jiraProjectKey + "-")) reasons.push("Jira 项目与席位接单设置不一致");
  if (rule.intakePaused) reasons.push("席位已暂停接单");
  if (fields.status?.statusCategory?.key === "done") reasons.push("Jira 工单已完成，不能发起真实开发");
  if (!rule.readyStatuses?.includes(fields.status?.name)) reasons.push("当前状态“" + fields.status?.name + "”不在允许开工状态中");
  if (!rule.issueTypes?.includes(fields.issuetype?.name)) reasons.push("当前类型“" + fields.issuetype?.name + "”不在席位接单范围中");
  return reasons;
}

/** Read Jira afresh; source state never fabricates execution completion. */
export async function syncJiraIntake(db: Db, agent: Agent, task: typeof issues.$inferSelect, userId: string) {
  const { intake } = readSeatIntake(agent, task);
  const rule = agent.adapterConfig.dsp7JiraDispatch as Record<string, any> | undefined;
  if (!rule?.jiraSecretId) throw conflict("请先在席位接单设置中配置 Jira 连接和 PAT");
  const target = new URL(rule.jiraBaseUrl);
  const allowed = (process.env.PAPERCLIP_JIRA_ALLOWED_ORIGINS ?? "http://jira.fingard.com:6001").split(",").map(v => v.trim());
  if (!allowed.includes(target.origin) || target.username || target.password) throw badRequest("Jira 来源地址未获允许");
  const token = await secretService(db).resolveSecretValue(agent.companyId, rule.jiraSecretId, "latest", { accessContext: { consumerType: "agent", consumerId: agent.id, configPath: "dsp7JiraDispatch.jiraSecretId", responsibleUserId: userId, actorType: "user", actorId: userId } });
  let response: Response;
  try { response = await fetch(target.href.replace(/\/$/, "") + "/rest/api/2/issue/" + encodeURIComponent(intake.jira_key) + "?fields=summary,status,issuetype,assignee,updated", { headers: { Authorization: "Bearer " + token, Accept: "application/json" }, redirect: "error", signal: AbortSignal.timeout(10000) }); }
  catch { throw badRequest("无法同步 Jira，请检查服务器网络或 DNS；上次结果不能作为本次派单依据"); }
  if (!response.ok) throw badRequest(response.status === 401 || response.status === 403 ? "Jira PAT 无效或没有查询权限" : "Jira 同步失败（HTTP " + response.status + "）");
  const body = await response.json(); const f = body.fields;
  if (!f?.status?.name || !f.issuetype?.name) throw badRequest("Jira 返回数据缺少状态或工单类型");
  const reasons = jiraIntakeReasons(rule, intake, f);
  const snapshot: JiraIntakeSnapshot = { jiraKey: intake.jira_key, summary: String(f.summary ?? ""), status: f.status.name, issueType: f.issuetype.name, assignee: f.assignee?.name ?? f.assignee?.accountId ?? null, assigneeName: f.assignee?.displayName ?? null, jiraUpdatedAt: f.updated ?? null, checkedAt: new Date().toISOString(), eligible: reasons.length === 0, reasons, ruleRevision: Number(rule.revision ?? 0) };
  const [last] = await db.select().from(activityLog).where(and(eq(activityLog.companyId, agent.companyId), eq(activityLog.agentId, agent.id), eq(activityLog.entityId, task.id), eq(activityLog.action, "dsp7.jira.intake.synced"))).orderBy(desc(activityLog.createdAt)).limit(1);
  const comparable = (v: Record<string, unknown>) => JSON.stringify(Object.fromEntries(Object.entries(v).filter(([k]) => k !== "checkedAt").sort(([a], [b]) => a.localeCompare(b))));
  if (!last || comparable(last.details ?? {}) !== comparable(snapshot)) await db.insert(activityLog).values({ companyId: agent.companyId, agentId: agent.id, actorType: "user", actorId: userId, action: "dsp7.jira.intake.synced", entityType: "issue", entityId: task.id, details: snapshot });
  return snapshot;
}

const resultSchema = z.object({ taskId: z.string().uuid(), request: z.string().max(6000), status: z.enum(["blocked", "ready"]), message: z.string().trim().min(1).max(1000), receipt: z.object({ title: z.string().max(1000), description: z.string().max(80000) }).strict().optional() });

export function jiraIntakeSyncRoutes(db: Db, own: (req: Request) => Promise<Agent>, board: (req: Request) => Promise<Agent>, authorizePlatformDispatch?: (db: Db, agent: Agent, task: typeof issues.$inferSelect) => Promise<unknown>) {
  const router = Router();
  const authorizeApplicantOrDispatch = async (db: Db, agent: Agent, task: typeof issues.$inferSelect) => {
    if (await canCreateSeatIntake(db, agent, task.createdByUserId)) return;
    if (!authorizePlatformDispatch) throw forbidden("申请人未获席位授权");
    // Reuse the complete current dispatch grant, including request/owner binding,
    // persisted manager roles, cancellation and execution admission gates.
    await authorizePlatformDispatch(db, agent, task);
  };
  router.post("/companies/:companyId/dsp7-seats/:id/jira-intake/:taskId/sync", async (req, res) => {
    const agent = await board(req);
    const [task] = await db.select().from(issues).where(and(eq(issues.id, String(req.params.taskId)), eq(issues.companyId, agent.companyId)));
    if (!task) throw badRequest("接入申请不存在");
    res.setHeader("Cache-Control", "no-store"); res.json(await syncJiraIntake(db, agent, task, req.actor.userId ?? "local-board"));
  });
  router.post("/agents/:id/dsp7-jira-intake/authorize", async (req, res) => {
    const agent = await own(req);
    const [task] = await db.select().from(issues).where(and(eq(issues.id, String(req.body.taskId)), eq(issues.companyId, agent.companyId)));
    if (!task) throw badRequest("接入申请不存在");
    const { raw } = readSeatIntake(agent, task);
    if (task.createdByAgentId || !await canCreateSeatIntake(db, agent, task.createdByUserId)) throw forbidden("申请人未获席位授权");
    const comments = await db.select().from(issueComments).where(and(eq(issueComments.issueId, task.id), eq(issueComments.authorUserId, task.createdByUserId!), isNull(issueComments.authorAgentId), isNull(issueComments.deletedAt)));
    if (!comments.some(c => c.body.includes(`<!-- DSP7-JIRA-INTAKE-AUTH ${raw} -->`))) throw forbidden("缺少申请人的接入授权");
    res.json({ authorized: true });
  });
  // Prepare the one registered task before a model run exists. This grants
  // assignment only; wakeup, dispatch authorization and run leases stay separate.
  router.post("/agents/:id/dsp7-jira-intake/start-assignment", async (req, res) => {
    const agent = await own(req);
    const data = z.object({taskId:z.string().uuid(),request:z.string().max(6000)}).parse(req.body);
    await db.transaction(async tx => {
      const [fresh] = await tx.select().from(agents).where(and(eq(agents.id,agent.id),eq(agents.companyId,agent.companyId))).for("update");
      const seat = fresh?.adapterConfig.dsp7Seat as Record<string,unknown> | undefined;
      if (!seat || seat.machineId!==req.body.machine_id || seat.machineFingerprint!==req.body.machine_fingerprint || ["paused","terminated","pending_approval"].includes(fresh.status)) throw forbidden("席位登记已变化");
      const [task] = await tx.select().from(issues).where(and(eq(issues.id,data.taskId),eq(issues.companyId,agent.companyId))).for("update");
      if (!task || task.status!=="backlog" || task.assigneeUserId || (task.assigneeAgentId && task.assigneeAgentId!==agent.id)) throw conflict("任务已开始、结束或分配给其他执行者");
      const {raw,intake} = readSeatIntake(fresh,task);
      if (raw!==data.request) throw conflict("接入申请已变化");
      await authorizeApplicantOrDispatch(tx as unknown as Db, fresh, task);
      const [claim] = await tx.select().from(activityLog).where(and(eq(activityLog.companyId,agent.companyId),eq(activityLog.action,"dsp7.jira.reserved"),eq(activityLog.entityType,"dsp7_jira_claim"),eq(activityLog.entityId,intake.jira_key))).limit(1);
      if (!claim || claim.details?.taskId!==task.id || claim.details?.seatId!==agent.id || claim.details?.machineId!==req.body.machine_id || claim.details?.machineFingerprint!==req.body.machine_fingerprint || claim.details?.request!==raw) throw forbidden("缺少本机独占接入登记");
      let receipt; try { receipt=JSON.parse(task.description?.match(/<!-- DSP7-INTAKE-RESULT (.*?) -->/)?.[1]??"{}"); } catch { throw conflict("接入结果无效"); }
      if (receipt.status!=="ready" || receipt.seat_id!==agent.id || receipt.jira_key!==intake.jira_key) throw conflict("请先完成本机接入准备");
      const [active] = await tx.select({id:heartbeatRuns.id}).from(heartbeatRuns).where(and(eq(heartbeatRuns.agentId,agent.id),inArray(heartbeatRuns.status,["queued","running","scheduled_retry"])));
      if (active) throw conflict("席位存在活动运行，不能重复启动");
      if (!task.assigneeAgentId) {
        await tx.update(issues).set({assigneeAgentId:agent.id,updatedAt:new Date()}).where(eq(issues.id,task.id));
        await tx.insert(activityLog).values({companyId:agent.companyId,agentId:agent.id,actorType:"agent",actorId:agent.id,action:"dsp7.jira.start.assigned",entityType:"issue",entityId:task.id,details:{machineId:req.body.machine_id,jiraKey:intake.jira_key}});
      }
    });
    res.json({taskId:data.taskId,assigneeAgentId:agent.id});
  });
  router.post("/agents/:id/dsp7-jira-intake/execution-interrupted", async (req,res) => {
    const agent=await own(req);
    const data=z.object({taskId:z.string().uuid(),runId:z.string().uuid(),stopped:z.boolean(),action:z.string().min(1).max(1500)}).parse(req.body);
    if (!data.action.startsWith("执行已中断") || !data.action.includes("运行编号："+data.runId)) throw badRequest("中断回执缺少运行归属");
    await db.transaction(async tx=>{
      const [fresh]=await tx.select().from(agents).where(and(eq(agents.id,agent.id),eq(agents.companyId,agent.companyId))).for("update");
      const seat=fresh?.adapterConfig.dsp7Seat as Record<string,unknown>|undefined;
      if (!seat || seat.machineId!==req.body.machine_id || seat.machineFingerprint!==req.body.machine_fingerprint) throw forbidden("席位登记已变化");
      const [task]=await tx.select().from(issues).where(and(eq(issues.id,data.taskId),eq(issues.companyId,agent.companyId))).for("update");
      if (!task || task.assigneeAgentId!==agent.id || !["in_progress","blocked"].includes(task.status)) throw conflict("任务不属于本机的中断执行");
      if (task.description?.includes("<!-- DSP7-JIRA-INTAKE")) readSeatIntake(fresh,task);
      else if (!/(?:^|\r?\n)DSP7-PILOT:[A-Z][A-Z0-9_]*-\d+(?::[A-Za-z0-9_-]+)?(?:\r?\n|$)/.test(task.description ?? "")) throw forbidden("任务不是已登记的 Harness 执行");
      if (task.status==="blocked" && (!String(task.unblockDescriptor?.action??"").startsWith("执行已中断") || !String(task.unblockDescriptor?.action).includes(data.runId))) throw conflict("不能覆盖其他流程阻塞");
      const runs=await tx.select().from(heartbeatRuns).where(and(eq(heartbeatRuns.agentId,agent.id),eq(heartbeatRuns.companyId,agent.companyId))).orderBy(desc(heartbeatRuns.createdAt));
      const run=runs.find(r=>r.id===data.runId);
      const linked=(r:typeof heartbeatRuns.$inferSelect)=>(r.nativeIssueId??r.contextSnapshot?.issueId??r.contextSnapshot?.taskId)===task.id && String(r.contextSnapshot?.wakeReason??"").startsWith("本地研发人员主动启动交互会话；");
      if (!run || !linked(run) || !["failed","cancelled","timed_out"].includes(run.status) || !run.finishedAt || runs.find(linked)?.id!==run.id || runs.some(r=>["queued","running","scheduled_retry"].includes(r.status))) throw conflict("旧运行尚未结束，或已有更新的运行，不能覆盖");
      if (task.status!=="blocked" || task.unblockDescriptor?.action!==data.action) {
        await tx.update(issues).set({status:"blocked",unblockDescriptor:{owner:"board",action:data.action},updatedAt:new Date()}).where(eq(issues.id,task.id));
        await tx.insert(activityLog).values({companyId:agent.companyId,agentId:agent.id,actorType:"agent",actorId:agent.id,action:"dsp7.jira.execution.interrupted",entityType:"issue",entityId:task.id,details:{runId:run.id,machineId:req.body.machine_id,stopped:data.stopped}});
      }
      // Do not release checkout, leases or conversation ownership here. Explicit
      // resume still requires fresh machine stop evidence and the original gates.
    });
    res.json({received:true});
  });
  // A machine reports only its exact intake receipt, outside any model run.
  // Generic issue writes retain the heartbeat attribution requirement.
  router.post("/agents/:id/dsp7-jira-intake/result", async (req, res) => {
    const agent = await own(req); const data = resultSchema.parse(req.body);
    const result = await db.transaction(async tx => {
      const [fresh] = await tx.select().from(agents).where(and(eq(agents.id, agent.id), eq(agents.companyId, agent.companyId))).for("update");
      const seat = fresh?.adapterConfig.dsp7Seat as Record<string, unknown> | undefined;
      if (!seat || seat.machineId !== req.body.machine_id || seat.machineFingerprint !== req.body.machine_fingerprint || ["paused", "terminated"].includes(fresh.status)) throw forbidden("席位登记已变化");
      const [task] = await tx.select().from(issues).where(and(eq(issues.id, data.taskId), eq(issues.companyId, agent.companyId))).for("update");
      if (!task || !["backlog", "blocked"].includes(task.status) || task.assigneeAgentId || task.assigneeUserId) throw conflict("任务已启动或已变化，接入回执不能覆盖执行状态");
      if (task.status === "blocked" && !String(task.unblockDescriptor?.action ?? "").startsWith("请核对并解决接入失败原因")) throw conflict("任务存在其他流程阻塞，不能由接入回执覆盖");
      const { raw, intake } = readSeatIntake(agent, task);
      if (raw !== data.request) throw conflict("接入申请已变化");
      await authorizeApplicantOrDispatch(tx as unknown as Db, fresh, task);
      const [active] = await tx.select({ id: heartbeatRuns.id }).from(heartbeatRuns).where(and(eq(heartbeatRuns.agentId, agent.id), inArray(heartbeatRuns.status, ["queued", "running", "scheduled_retry"])));
      if (active) throw conflict("席位存在活动运行，不能由接入回执覆盖任务");
      let description = String(task.description ?? "").replace(/\n?<!-- DSP7-INTAKE-RESULT .*? -->/g, "");
      const update: Partial<typeof issues.$inferInsert> = { updatedAt: new Date() };
      if (data.status === "ready") {
        const [claim] = await tx.select().from(activityLog).where(and(eq(activityLog.companyId, agent.companyId), eq(activityLog.action, "dsp7.jira.reserved"), eq(activityLog.entityType, "dsp7_jira_claim"), eq(activityLog.entityId, intake.jira_key))).limit(1);
        if (!claim || claim.details?.taskId !== task.id || claim.details?.seatId !== agent.id || claim.details?.machineId !== req.body.machine_id || claim.details?.machineFingerprint !== req.body.machine_fingerprint || claim.details?.request !== raw) throw forbidden("缺少本机对该申请的独占登记");
        if (!data.receipt || !data.receipt.description.includes(`DSP7-PILOT:${intake.jira_key}`) || !data.receipt.description.includes(`<!-- DSP7-JIRA-INTAKE ${raw} -->`)) throw badRequest("接入成功回执缺少登记身份");
        // The authenticated seat owns only this receipt and cannot alter source metadata.
        const marker = `\n\nDSP7-PILOT:${intake.jira_key}`;
        const start = data.receipt.description.indexOf(marker);
        let ready;
        try { ready = JSON.parse(data.receipt.description.match(/<!-- DSP7-INTAKE-RESULT (.*?) -->/)?.[1] ?? "{}"); } catch { throw badRequest("接入成功回执格式无效"); }
        if (start < 0 || ready.status !== "ready" || ready.jira_key !== intake.jira_key || ready.seat_id !== agent.id) throw badRequest("接入成功回执与本席位不一致");
        if (!description.includes(`DSP7-PILOT:${intake.jira_key}`)) description += data.receipt.description.slice(start);
        else description += '\n<!-- DSP7-INTAKE-RESULT ' + JSON.stringify(ready) + ' -->';
        update.title = data.receipt.title; update.status = "backlog"; update.unblockDescriptor = null;
        update.projectWorkspaceId = intake.version === 4 ? null : intake.workspace_id; update.assigneeAdapterOverrides = { useProjectWorkspace: false };
      } else {
        update.status = "blocked"; update.unblockDescriptor = { owner: "board", action: "请核对并解决接入失败原因：" + data.message + "。修正后在网页重新派单。" };
        description += '\n<!-- DSP7-INTAKE-RESULT ' + JSON.stringify({ status: "blocked", message: data.message }) + ' -->';
      }
      update.description = description;
      await tx.update(issues).set(update).where(eq(issues.id, task.id));
      await tx.insert(activityLog).values({ companyId: agent.companyId, agentId: agent.id, actorType: "agent", actorId: agent.id, action: "dsp7.jira.intake.result", entityType: "issue", entityId: task.id, details: { status: data.status, message: data.message, jiraKey: intake.jira_key, machineId: req.body.machine_id } });
      return { taskId: task.id, status: data.status };
    }); res.json(result);
  });
  return router;
}
