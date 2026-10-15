import type { RequestHandler } from "express";
import { eq } from "drizzle-orm";
import { agents, projects, type Db } from "@paperclipai/db";
import { forbidden } from "../errors.js";
import { isUuidLike } from "@paperclipai/shared";
import { projectService } from "../services/projects.js";
import { agentService } from "../services/agents.js";

/** Board administration boundary. Agent runtime calls retain their existing authorization. */
export function focusedManagementGate(db: Db): RequestHandler {
  return async (req, res, next) => {
    try {
      if (req.actor.type !== "board" || req.actor.isInstanceAdmin || req.actor.source === "local_implicit") return next();
      const path = req.path.toLowerCase().replace(/\/+$/, "") || "/";
      const write = !["GET", "HEAD", "OPTIONS"].includes(req.method);
      const company = path.match(/^\/companies\/([^/]+)(?:\/(.*))?$/);
      let companyId = company?.[1];
      const tail = company?.[2] ?? "";
      const manager = (id: string | undefined) => !!id && req.actor.memberships?.some(m => m.companyId.toLowerCase() === id && m.status === "active" && ["owner", "admin"].includes(m.membershipRole ?? ""));
      const assertWritable = (id: string | undefined) => {
        if (write && id && req.actor.memberships?.some(m => m.companyId.toLowerCase() === id.toLowerCase() && m.status === "active" && m.membershipRole === "viewer")) throw forbidden("观察成员仅可查看，不能修改配置、执行工单或提交决策");
      };
      assertWritable(companyId);
      const instance = /^\/(?:admin|plugins|execution-environments|instance)(?:\/|$)/.test(path);
      const sharedSettingsRead = !write && ["/instance/settings/general", "/instance/settings/experimental"].includes(path);
      if (instance && !sharedSettingsRead) throw forbidden("此管理接口需要实例管理员权限");
      const companyAdministration = /^(?:costs|budgets|finance-events|secrets|skills|skill-policy|tools|activity|audit|routines|pipelines|goals|cases|status-cards|board-chat|export|import|members|invites|join-requests)(?:\/|$)/.test(tail);
      let protectedOperation = companyAdministration || (write && company && (!tail || tail === "projects" || tail === "agents"));
      const resource = path.match(/^\/(projects|agents)\/([^/]+)(?:\/|$)/);
      if (resource && (write || /^\/agents\/[^/]+\/(?:configuration|config-revisions|instructions-bundle|skills|keys|api-keys)(?:\/|$)/.test(path))) {
        let id = resource[2]!;
        if (!isUuidLike(id)) {
          const hint = typeof req.query.companyId === "string" ? req.query.companyId : req.actor.companyIds?.length === 1 ? req.actor.companyIds[0] : undefined;
          if (!hint || !req.actor.companyIds?.includes(hint)) throw forbidden("请指定有权限的组织和资源");
          if (resource[1] === "projects") {
            const resolved = await projectService(db).resolveByReference(hint, decodeURIComponent(id));
            if (resolved.ambiguous || !resolved.project) throw forbidden("无法解析此项目");
            id = resolved.project.id;
          } else {
            const resolved = await agentService(db).resolveByReference(hint, decodeURIComponent(id));
            if (resolved.ambiguous || !resolved.agent) throw forbidden("无法解析此智能体");
            id = resolved.agent.id;
          }
        }
        const table = resource[1] === "projects" ? projects : agents;
        const [row] = await db.select({ companyId: table.companyId }).from(table).where(eq(table.id, id)).limit(1);
        companyId = row?.companyId;
        assertWritable(companyId);
        protectedOperation = true;
        if (resource[1] === "agents" && /^\/agents\/[^/]+\/(?:wakeup|heartbeat\/invoke)$/.test(path)) {
          const [agent] = await db.select().from(agents).where(eq(agents.id, id)).limit(1);
          const seat = (agent?.adapterConfig as { dsp7Seat?: { intakeUserIds?: string[] } } | undefined)?.dsp7Seat;
          if (seat?.intakeUserIds?.includes(req.actor.userId ?? "")) protectedOperation = false;
        }
      }
      // Global management objects have no trustworthy company segment. Keep instance-only.
      if (/^\/(?:tool-applications|tool-connections|tool-profiles|tool-policy|tools|skills\/catalog)(?:\/|$)/.test(path)) throw forbidden("此高级管理接口需要实例管理员权限");
      if (write && path === "/companies") throw forbidden("创建组织需要实例管理员权限");
      if (protectedOperation && !manager(companyId)) throw forbidden("此管理接口需要组织管理员权限");
      if (company && !manager(companyId) && write && tail === "issues") {
        const marker = typeof req.body?.description === "string" ? req.body.description.match(/<!-- DSP7-JIRA-INTAKE (.*?) -->/) : null;
        let intake: Record<string, unknown> | null = null;
        try { intake = marker ? JSON.parse(marker[1]!) : null; } catch { /* Invalid requests are rejected below. */ }
        if (!intake || intake.version !== 2 || !isUuidLike(String(intake.seat_id)) || !/^[A-Z][A-Z0-9_]*-\d+$/.test(String(intake.jira_key)) || req.body.projectId !== intake.project_id || req.body.projectWorkspaceId !== intake.workspace_id || req.body.status !== "backlog" || req.body.assigneeAgentId || req.body.assigneeUserId) throw forbidden("请通过 Jira 工单接入创建任务");
        const [seat] = await db.select().from(agents).where(eq(agents.id, String(intake.seat_id))).limit(1);
        const config = seat?.adapterConfig as Record<string, unknown> | undefined;
        const identity = config?.dsp7Seat as { intakeUserIds?: string[] } | undefined;
        if (seat?.companyId !== companyId || config?.dsp7WebJiraIntake !== true || !identity?.intakeUserIds?.includes(req.actor.userId ?? "")) throw forbidden("未获该 Jira 执行席位授权");
      }
      const agentDisplay = (!write && ((company && tail === "agents") || /^\/agents\/[^/]+$/.test(path)));
      if (agentDisplay) {
        const original = res.json.bind(res);
        res.json = ((body: unknown) => {
          const redact = (value: unknown) => {
            if (!value || typeof value !== "object") return value;
            const row = value as Record<string, unknown>;
            if (typeof row.companyId !== "string" || manager(row.companyId.toLowerCase())) return row;
            const config = row.adapterConfig as Record<string, unknown> | undefined;
            const seat = config?.dsp7Seat as { name?: string } | undefined;
            return { ...row, adapterConfig: { dsp7WebJiraIntake: config?.dsp7WebJiraIntake === true, ...(seat ? { dsp7Seat: { name: seat.name } } : {}) }, runtimeConfig: {} };
          };
          return original(Array.isArray(body) ? body.map(redact) : redact(body));
        }) as typeof res.json;
      }
      if (company && tail === "dashboard" && !manager(companyId)) {
        const original = res.json.bind(res);
        res.json = ((body: Record<string, unknown>) => original(body && typeof body === "object" && "costs" in body && res.statusCode < 400 ? { ...body, costs: { monthSpendCents: 0, monthBudgetCents: 0, monthUtilizationPercent: 0 } } : body)) as typeof res.json;
      }
      next();
    } catch (error) { next(error); }
  };
}
