import { Router, type Request } from "express";
import { and, eq, inArray, or, sql } from "drizzle-orm";
import { z } from "zod";
import { activityLog, heartbeatRuns, agents, authUsers, companyMemberships, issues, personnelPeople, projects, type Db } from "@paperclipai/db";
import { seatOwnerId, canCreateSeatIntake, isSeatManager } from "./dsp7-seat-owners.js";
import { badRequest, conflict, forbidden } from "../errors.js";
import { secretService } from "../services/secrets.js";
import { issueService } from "../services/issues.js";
import { jiraRequirementOwnerField, normalizeRequirement, requirementMarker } from "../services/jira-requirement-plan.js";

type Agent = typeof agents.$inferSelect;
const input = z.object({ jiraKey: z.string().regex(/^[A-Z][A-Z0-9_]*-\d+$/), projectId: z.string().uuid() }).strict();
export function jiraRequirementRoutes(db: Db, board: (req: Request) => Promise<Agent>) {
  const router = Router();
  async function read(req: Request, agent: Agent, key: string) {
    const rule = agent.adapterConfig.dsp7JiraDispatch as { jiraBaseUrl?: string; jiraSecretId?: string } | undefined;
    if (!rule?.jiraSecretId || !rule.jiraBaseUrl) throw conflict("请先配置所选席位的 Jira 连接；此处仅借用连接读取需求，不会派单");
    const target = new URL(rule.jiraBaseUrl);
    const allowed = (process.env.PAPERCLIP_JIRA_ALLOWED_ORIGINS ?? "http://jira.fingard.com:6001").split(",").map(value => value.trim());
    if (!allowed.includes(target.origin) || target.username || target.password || target.search || target.hash) throw forbidden("Jira 来源不在服务器允许范围");
    const token = await secretService(db).resolveSecretValue(agent.companyId, rule.jiraSecretId, "latest", { accessContext: { consumerType: "agent", consumerId: agent.id, configPath: "dsp7JiraDispatch.jiraSecretId", responsibleUserId: req.actor.userId, actorType: "user", actorId: req.actor.userId! } });
    async function get(path: string): Promise<any> {
      let response: Response;
      try { response = await fetch(target.href.replace(/\/$/, "") + "/rest/api/2" + path, { headers: { Authorization: "Bearer " + token, Accept: "application/json" }, redirect: "error", signal: AbortSignal.timeout(10000) }); }
      catch { throw badRequest("Jira 连接失败，请核对网络和连接配置"); }
      if (!response.ok) throw badRequest(response.status === 401 || response.status === 403 ? "Jira PAT 无效或没有工单读取权限" : "Jira 查询失败（HTTP " + response.status + "）");
      const text = await response.text();
      if (text.length > 4 * 1024 * 1024) throw badRequest("Jira 响应过大，请缩小需求范围");
      try { return JSON.parse(text); } catch { throw badRequest("Jira 响应格式无效"); }
    }
    const ownerField = jiraRequirementOwnerField();
    if (!/^customfield_\d+$/.test(ownerField)) throw badRequest("研发负责人字段配置无效");
    const parent = await get("/issue/" + encodeURIComponent(key) + "?fields=" + ["summary", "status", "issuetype", "subtasks", ownerField].join(","));
    if (parent.key !== key) throw badRequest("Jira 主需求编号核验失败");
    const children: any[] = [];
    for (let start = 0; ; ) {
      const page = await get("/search?" + new URLSearchParams({ jql: `parent = "${key}" ORDER BY key ASC`, fields: "summary,status,issuetype,assignee,parent", startAt: String(start), maxResults: "100" }));
      if (!Array.isArray(page.issues) || !Number.isInteger(page.total)) throw badRequest("Jira 子工单列表无效");
      if (children.length + page.issues.length > 1000) throw badRequest("需求超过 1000 张子工单，不能部分导入");
      children.push(...page.issues); start += page.issues.length;
      if (start >= page.total) break;
      if (!page.issues.length || start >= 1000) throw badRequest("子工单列表未完整读取，不进行部分导入");
    }
    let plan;
    try { plan = normalizeRequirement(parent, children, ownerField); } catch (error) { throw badRequest((error as Error).message); }
    const members = await db.select({ id: authUsers.id, name: authUsers.name, email: authUsers.email }).from(companyMemberships).innerJoin(authUsers, eq(authUsers.id, companyMemberships.principalId)).where(and(eq(companyMemberships.companyId, agent.companyId), eq(companyMemberships.principalType, "user"), eq(companyMemberships.status, "active")));
    const people = await db.select().from(personnelPeople).where(and(eq(personnelPeople.active, true), inArray(personnelPeople.userId, members.map(member=>member.id))));
    const match = (person: typeof plan.owner) => {
      if (!person) return null;
      const ids = new Set(people.filter(p => p.username === person.login || Boolean(person.email && p.email?.toLowerCase() === person.email.toLowerCase())).map(p => p.userId));
      const matches = members.filter(member => ids.has(member.id) || Boolean(person.email && member.email.toLowerCase() === person.email.toLowerCase()));
      return matches.length === 1 ? matches[0].id : null;
    };
    const seats = await db.select().from(agents).where(eq(agents.companyId, agent.companyId));
    return { ...plan, jiraBaseUrl: target.href.replace(/\/$/, ""), ownerUserId: match(plan.owner), members, children: plan.children.map(item => {
      const userId = match(item.assignee);
      const candidates = seats.filter(seat => {
        const registration = seat.adapterConfig.dsp7Seat as { ownerUserId?: string } | undefined;
        const scope = seat.adapterConfig.dsp7JiraDispatch as { ownerUserId?: string; projectId?: string; jiraAssignee?: string; issueTypes?: string[] } | undefined;
        return registration && seatOwnerId(registration) && scope?.projectId === req.body.projectId && scope?.issueTypes?.includes(item.issueType) && !["paused", "terminated", "pending_approval"].includes(seat.status);
      });
      return { ...item, userId, seats: item.mode === "development" ? candidates.map(seat => ({ id: seat.id, name: seat.name })) : [] };
    }) };
  }
  router.post("/companies/:companyId/dsp7-seats/:id/jira-requirements/preview", async (req, res) => {
    const agent = await board(req); const parsed = input.safeParse(req.body);
    if (!parsed.success) throw badRequest("请选择项目并填写有效的主需求编号");
    const [project] = await db.select().from(projects).where(and(eq(projects.id, parsed.data.projectId), eq(projects.companyId, agent.companyId)));
    if (!project || project.archivedAt) throw forbidden("项目不存在、已归档或不属于当前组织");
    res.setHeader("Cache-Control", "no-store"); res.json(await read(req, agent, parsed.data.jiraKey));
  });
  router.post("/companies/:companyId/dsp7-seats/:id/jira-requirements/import", async (req, res) => {
    const agent = await board(req);
    const parsed = input.extend({ fingerprint: z.string().regex(/^[a-f0-9]{64}$/), ownerUserId: z.string().min(1).optional() }).safeParse(req.body);
    if (!parsed.success || !req.actor.userId) throw badRequest("导入参数无效，请重新预览");
    const data = parsed.data; const plan = await read(req, agent, data.jiraKey);
    if (data.ownerUserId && !plan.ownerUserId && !isSeatManager(req, agent.companyId)) throw forbidden("手工关联研发负责人账号需要管理员权限");
    if (plan.fingerprint !== data.fingerprint) throw conflict("Jira 人员、状态或子工单已变化，请重新预览后确认");
    const ownerId = data.ownerUserId ?? plan.ownerUserId;
    if (!plan.owner) throw conflict("主需求研发负责人缺失或不唯一，请先在 Jira 核对；不会以经办人替代");
    if (!ownerId || !plan.members.some(member => member.id === ownerId)) throw conflict("请将研发负责人关联到当前组织成员");
    if (plan.ownerUserId && ownerId !== plan.ownerUserId) throw conflict("研发负责人映射已确定，不能改派给其他成员");
    const result = await db.transaction(async tx => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${agent.companyId + ":jira-requirement:" + plan.jiraBaseUrl + ":" + plan.key},0))`);
      const [project] = await tx.select().from(projects).where(and(eq(projects.id, data.projectId), eq(projects.companyId, agent.companyId)));
      if (!project || project.archivedAt) throw forbidden("项目不可用");
      const origin = `${plan.jiraBaseUrl}:${plan.key}`;
      const [prior] = await tx.select().from(issues).where(and(eq(issues.companyId, agent.companyId), eq(issues.originId, origin)));
      if (prior) {
        if (prior.projectId !== data.projectId) throw conflict("该需求已接入其他项目，请先核对，不能重复导入");
        const [importRecord] = await tx.select().from(activityLog).where(and(eq(activityLog.companyId, agent.companyId), eq(activityLog.entityId, prior.id), eq(activityLog.action, "dsp7.jira.requirement.imported"))).limit(1);
        if (!importRecord) throw conflict("已有同来源任务缺少主需求接入记录，请先核对");
        return { taskId: prior.id, existing: true };
      }
      const meta = { version: 1, ...plan, members: undefined, connectionSeatId: agent.id, ownerUserId: ownerId, importedAt: new Date().toISOString() };
      const service = issueService(db);
      const root = await service.create(agent.companyId, { title: `${plan.key} ${plan.summary}`, description: requirementMarker(meta) + "\n\n主需求仅统筹交付，不派给 Agent 执行。业务负责人来自 Jira 研发负责人字段。接入不会启动子工单。", projectId: data.projectId, originId: origin, status: "backlog", priority: "medium", assigneeUserId: ownerId, responsibleUserId: ownerId, createdByUserId: req.actor.userId, idempotencyKey: `jira-requirement:${origin}`, allowDuplicate: true }, tx);
      for (const item of plan.children) {
        await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${agent.companyId + ":dsp7:" + item.key}, 0))`);
        const matching = await tx.select().from(issues).where(and(eq(issues.companyId, agent.companyId), or(eq(issues.originId, `${plan.jiraBaseUrl}:${item.key}`), sql`${issues.description} like ${'%"jira_key":"' + item.key + '"%'}`)));
        if (matching.length > 1) throw conflict(item.key + " 存在多个平台记录，请先核对");
        if (matching[0]) {
          const existing = matching[0];
          if (existing.originId && existing.originId !== `${plan.jiraBaseUrl}:${item.key}`) throw conflict(item.key + " 的 Jira 来源不同，不能仅按编号合并");
          if (!existing.originId) {
            let intake;
            try { intake = JSON.parse(existing.description?.match(/<!-- DSP7-JIRA-INTAKE (.*?) -->/)?.[1] ?? ""); } catch { throw conflict(item.key + " 缺少可核验的原接入记录"); }
            const [sourceSeat] = await tx.select().from(agents).where(and(eq(agents.id, String(intake.seat_id)), eq(agents.companyId, agent.companyId)));
            const sourceRule = sourceSeat?.adapterConfig.dsp7JiraDispatch as { jiraBaseUrl?: string } | undefined;
            let sourceBaseUrl;
            try { sourceBaseUrl = new URL(sourceRule?.jiraBaseUrl ?? "").href.replace(/\/$/, ""); } catch { throw conflict(item.key + " 的原 Jira 来源配置无效"); }
            if (intake.jira_key !== item.key || sourceBaseUrl !== plan.jiraBaseUrl) throw conflict(item.key + " 的原 Jira 来源无法核验，不能自动合并");
          }
          if (matching[0].projectId !== data.projectId || matching[0].parentId && matching[0].parentId !== root.id) throw conflict(item.key + " 已属于其他项目或需求，不能自动迁移");
          await tx.update(issues).set({ parentId: root.id, updatedAt: new Date() }).where(eq(issues.id, matching[0].id));
          continue;
        }
        await service.create(agent.companyId, { title: `${item.key} ${item.summary}`, description: requirementMarker({ version: 1, rootKey: plan.key, ...item, connectionSeatId: agent.id, jiraBaseUrl: plan.jiraBaseUrl }) + "\n\n" + item.note + "\nJira 状态是接入时快照；不代表平台已授权执行或验收。", projectId: data.projectId, parentId: root.id, originId: `${plan.jiraBaseUrl}:${item.key}`, status: "backlog", priority: "medium", assigneeUserId: item.userId, createdByUserId: req.actor.userId, idempotencyKey: `jira-child:${plan.jiraBaseUrl}:${item.key}`, allowDuplicate: true }, tx);
      }
      await tx.insert(activityLog).values({ companyId: agent.companyId, actorType: "user", actorId: req.actor.userId!, action: "dsp7.jira.requirement.imported", entityType: "issue", entityId: root.id, details: { jiraKey: plan.key, fingerprint: plan.fingerprint, ownerUserId: ownerId, connectionSeatId: agent.id, projectId: data.projectId, children: plan.children.map(item => ({ key: item.key, mode: item.mode, originId: `${plan.jiraBaseUrl}:${item.key}` })), dispatchGranted: false } });
      return { taskId: root.id, existing: false };
    });
    res.json(result);
  });
  router.post("/companies/:companyId/dsp7-seats/:id/jira-requirements/prepare", async (req, res) => {
    const agent = await board(req);
    const parsed = z.object({ taskId: z.string().uuid() }).strict().safeParse(req.body);
    if (!parsed.success || !req.actor.userId) throw badRequest("请选择有效的子工单");
    const [task] = await db.select().from(issues).where(and(eq(issues.id, parsed.data.taskId), eq(issues.companyId, agent.companyId)));
    if (!task?.parentId) throw conflict("仅支持已纳管的真实需求子工单");
    const [record] = await db.select().from(activityLog).where(and(eq(activityLog.companyId, agent.companyId), eq(activityLog.action, "dsp7.jira.requirement.imported"), eq(activityLog.entityId, task.parentId)));
    const rootKey = record?.details?.jiraKey;
    if (typeof rootKey !== "string") throw forbidden("缺少主需求接入记录");
    const plan = await read(req, agent, rootKey);
    const item = plan.children.find(child => task.originId === `${plan.jiraBaseUrl}:${child.key}`);
    if (!item || item.mode !== "development") throw conflict("此子工单不是独立研发执行项；人工评审、关联代码评审不能重复派单，测试任务须使用测试执行通道");
    if (!isSeatManager(req, agent.companyId) && !await canCreateSeatIntake(db, agent, task.createdByUserId)) throw forbidden("原申请人未获所选席位授权，请由管理员派单");
    const rule = agent.adapterConfig.dsp7JiraDispatch as { jiraProjectKey?: string; projectId?: string; workspaceId?: string; jiraAssignee?: string; readyStatuses?: string[]; issueTypes?: string[] };
    const owner = seatOwnerId(agent.adapterConfig.dsp7Seat as Record<string, unknown>);
    if (!owner) throw conflict("请先指定席位负责人");
    if (!item.key.startsWith((rule.jiraProjectKey ?? "") + "-") || item.done || !rule.readyStatuses?.includes(item.status) || !rule.issueTypes?.includes(item.issueType) || rule.projectId !== task.projectId) throw conflict("Jira 类型、状态或项目未满足席位接单规则");
    const request = { version: 4, seat_id: agent.id, jira_key: item.key, project_id: task.projectId, status_source: "seat_rule" };
    const result = await db.transaction(async tx => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${agent.id + ":seat-commands"},0))`);
      const [currentAgent] = await tx.select().from(agents).where(and(eq(agents.id, agent.id), eq(agents.companyId, agent.companyId))).for("update");
      if (!currentAgent || JSON.stringify([currentAgent.adapterConfig.dsp7Seat, currentAgent.adapterConfig.dsp7JiraDispatch, currentAgent.status]) !== JSON.stringify([agent.adapterConfig.dsp7Seat, agent.adapterConfig.dsp7JiraDispatch, agent.status])) throw conflict("席位配置已变化，请刷新后重试");
      const [fresh] = await tx.select().from(issues).where(eq(issues.id, task.id)).for("update");
      if (!fresh || fresh.parentId !== task.parentId || fresh.originId !== task.originId || fresh.projectId !== task.projectId || fresh.createdByUserId !== task.createdByUserId || !["backlog", "todo"].includes(fresh.status) || fresh.executionRunId || fresh.checkoutRunId) throw conflict("任务已有执行或已结束，请在原任务处理，不能重新准备");
      const [active] = await tx.select().from(heartbeatRuns).where(and(eq(heartbeatRuns.companyId, agent.companyId), inArray(heartbeatRuns.status, ["queued", "running", "scheduled_retry"]), sql`${heartbeatRuns.contextSnapshot}->>'issueId' = ${task.id}`));
      if (active) throw conflict("任务已有活动运行");
      const raw = fresh.description?.match(/<!-- DSP7-JIRA-INTAKE (.*?) -->/)?.[1];
      if (raw) {
        let previous;
        try { previous = JSON.parse(raw); } catch { throw conflict("原接入申请无效，请核对原任务"); }
        if (![3, 4].includes(previous.version) || previous.status_source !== "seat_rule" || previous.seat_id !== agent.id || previous.project_id !== task.projectId || previous.jira_key !== item.key) throw conflict("任务已绑定不同席位或工单，不自动改派");
      }
      if (!fresh.createdByUserId || fresh.createdByAgentId) throw forbidden("任务创建身份无效");
      const updated = await issueService(db).update(task.id, { status: "backlog", title: `Jira 接入申请：${item.key} ${item.summary}`, assigneeUserId: null, assigneeAgentId: null, projectWorkspaceId: raw ? fresh.projectWorkspaceId : null, assigneeAdapterOverrides: { useProjectWorkspace: false }, description: raw ? fresh.description : fresh.description + "\n\n<!-- DSP7-JIRA-INTAKE " + JSON.stringify(request) + " -->", actorUserId: req.actor.userId }, tx);
      await tx.insert(activityLog).values({ companyId: agent.companyId, agentId: agent.id, actorType: "user", actorId: req.actor.userId!, action: "dsp7.jira.requirement.child.prepared", entityType: "issue", entityId: task.id, details: { jiraKey: item.key, parentId: task.parentId, dispatchGranted: false } });
      return updated;
    });
    res.json({ taskId: result!.id, seatId: agent.id, jiraKey: item.key });
  });
  return router;
}
