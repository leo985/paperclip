import { annotateMonthlyDelivery } from "../services/delivery-monthly-annotations.js";
import { Router, type Request } from "express";
import { and, eq, inArray, sql } from "drizzle-orm";
import { activityLog, agents, companySecrets, deliveryConnections, deliverySnapshots, projects, type Db } from "@paperclipai/db";
import { z } from "zod";
import { assertBoard, assertCompanyAccess } from "./authz.js";
import { isSeatManager } from "./dsp7-seat-owners.js";
import { secretService } from "../services/secrets.js";
import { readQingzhouOrganizations } from "../services/qingzhou-organizations.js";
import { readMonthlyDelivery } from "../services/delivery-monthly.js";
import { readOnlineDelivery } from "../services/delivery-source-reader.js";
import { QingzhouReadError } from "../services/qingzhou-client.js";
import { badRequest, conflict, forbidden, HttpError } from "../errors.js";
import type { DeliveryConnection } from "@paperclipai/shared";

const saveInput = z.object({ projectId: z.string().uuid(), expectedRevision: z.number().int().min(0), jiraAgentId: z.string().uuid().optional(), jira: z.object({ baseUrl: z.string().url().max(2048).refine(value => { try { const u = new URL(value); return ["http:", "https:"].includes(u.protocol) && !u.username && !u.password && !u.search && !u.hash && u.pathname === "/" && (process.env.PAPERCLIP_JIRA_ALLOWED_ORIGINS ?? "http://jira.fingard.com:6001").split(",").map(v=>v.trim()).includes(u.origin); } catch { return false; } }), token: z.string().trim().min(1).max(4096).refine(v=>!/[\r\n\0]/.test(v)).optional() }).strict().optional(), organizationId: z.string().regex(/^\d{1,30}$/), credentials: z.object({ username: z.string().trim().min(1).max(200), password: z.string().min(1).max(1000) }).strict().optional() }).strict();
const syncInput = z.object({ projectId: z.string().uuid(), expectedRevision: z.number().int().positive(), demandNo: z.string().regex(/^[A-Z][A-Z0-9]*-\d+$/), months: z.array(z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/)).min(1).max(12) }).strict();
const publicConnection = (row: typeof deliveryConnections.$inferSelect): DeliveryConnection => ({ id: row.id, projectId: row.projectId, jiraAgentId: row.jiraAgentId, jiraBaseUrl: row.jiraBaseUrl ?? "", jiraCredentialsConfigured: !!row.jiraSecretId, jiraConnectionMode: row.jiraSecretId ? "project" : "legacy_seat", organizationId: row.organizationId, revision: row.revision, credentialsConfigured: !!row.credentialSecretId, lastCheckStatus: row.lastCheckStatus, lastCheckedAt: row.lastCheckedAt?.toISOString() ?? null });
export function deliveryConnectionRoutes(db: Db, reader = readOnlineDelivery, secrets = secretService, monthlyReader = readMonthlyDelivery, organizationReader = readQingzhouOrganizations) {
  const router = Router(), base = "/companies/:companyId/delivery-connections";
  function access(req: Request, mutate = false) {
    const companyId = String(req.params.companyId);assertBoard(req);assertCompanyAccess(req, companyId);
    if (mutate && !isSeatManager(req, companyId)) throw forbidden("交付来源配置及同步需要组织管理员权限");
    return companyId;
  }
  async function project(companyId: string, projectId: string, tx: Db = db) {
    const [row] = await tx.select().from(projects).where(and(eq(projects.companyId, companyId), eq(projects.id, projectId)));
    if (!row || row.archivedAt) throw forbidden("项目不属于当前组织或已归档");
  }
  async function jira(companyId: string, projectId: string, agentId: string, tx: Db = db, lock = false) {
    const query = tx.select().from(agents).where(and(eq(agents.companyId, companyId), eq(agents.id, agentId)));
    const [agent] = await (lock ? query.for("update") : query);
    const rule = agent?.adapterConfig.dsp7JiraDispatch as { projectId?: string; jiraSecretId?: string; jiraBaseUrl?: string; revision?: number } | undefined;
    if (!agent?.adapterConfig.dsp7Seat || !rule?.jiraSecretId || !rule.jiraBaseUrl || rule.projectId !== projectId) throw conflict("请选择已配置当前项目 Jira 连接的席位；这里只借用只读连接，不派发任务");
    return { agent: agent!, rule: { ...rule, jiraSecretId: rule.jiraSecretId, jiraBaseUrl: rule.jiraBaseUrl } };
  }
  async function projectJira(companyId: string, connection: typeof deliveryConnections.$inferSelect, tx: Db = db, lock = false) {
    if (connection.jiraBaseUrl && connection.jiraSecretId) return { agent: null, rule: { jiraBaseUrl: connection.jiraBaseUrl, jiraSecretId: connection.jiraSecretId, revision: connection.revision } };
    if (!connection.jiraAgentId) throw conflict("请配置项目 Jira 地址和 PAT，来源读取不需要执行席位");
    return jira(companyId, connection.projectId, connection.jiraAgentId, tx, lock);
  }
  async function view(row: typeof deliveryConnections.$inferSelect, tx: Db = db) {
    const value = publicConnection(row);
    if (!row.jiraSecretId && row.jiraAgentId) {
      try { const source = await jira(row.companyId, row.projectId, row.jiraAgentId, tx); value.jiraBaseUrl = source.rule.jiraBaseUrl; value.jiraCredentialsConfigured = true; } catch { /* Keep broken legacy configuration editable. */ }
    }
    return value;
  }
  // Resolving a secret updates lastResolvedAt and updatedAt; neither is a credential revision.
  async function credentialVersion(companyId: string, ids: string[], tx: Db = db, lock = false) {
    const query = tx.select({ id: companySecrets.id, version: companySecrets.latestVersion, status: companySecrets.status, deletedAt: companySecrets.deletedAt, provider: companySecrets.provider, externalRef: companySecrets.externalRef, providerConfigId: companySecrets.providerConfigId, lastRotatedAt: companySecrets.lastRotatedAt }).from(companySecrets).where(and(eq(companySecrets.companyId, companyId), inArray(companySecrets.id, ids))).orderBy(companySecrets.id);
    const rows = await (lock ? query.for("update") : query);
    if (rows.length !== new Set(ids).size || rows.some(row => row.deletedAt || row.status !== "active")) throw conflict("来源凭据不可用，请重新保存连接配置");
    return JSON.stringify(rows);
  }
  router.get(base, async (req, res) => {
    const companyId = access(req), parsed = z.string().uuid().safeParse(req.query.projectId);
    if (!parsed.success) throw badRequest("请选择项目");await project(companyId, parsed.data);
    const [row] = await db.select().from(deliveryConnections).where(and(eq(deliveryConnections.companyId, companyId), eq(deliveryConnections.projectId, parsed.data)));
    res.setHeader("Cache-Control", "no-store");res.json(row ? await view(row) : null);
  });
  router.put(base, async (req, res) => {
    const companyId = access(req, true), parsed = saveInput.safeParse(req.body);
    if (!parsed.success) throw badRequest("请选择项目和轻舟组织，填写有效的项目 Jira 服务地址并完成账号配置");
    const data = parsed.data;
    const result = await db.transaction(async transaction => {
      const tx = transaction as unknown as Db;
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${companyId + ":delivery-connection:" + data.projectId}, 0))`);
      await project(companyId, data.projectId, tx);
      const [prior] = await tx.select().from(deliveryConnections).where(and(eq(deliveryConnections.companyId, companyId), eq(deliveryConnections.projectId, data.projectId))).for("update");
      if ((prior?.revision ?? 0) !== data.expectedRevision) throw conflict("来源配置已变化，请刷新后重试");
      let secretId = prior?.credentialSecretId;const service = secrets(tx);
      if (data.credentials) {
        const value = JSON.stringify(data.credentials);
        if (secretId) await service.rotate(secretId, { value }, { userId: req.actor.userId });
        else secretId = (await service.create(companyId, { name: "轻舟交付来源 " + data.projectId, provider: "local_encrypted", value }, { userId: req.actor.userId })).id;
      }
      if (!secretId) throw badRequest("首次配置需要轻舟账号和密码；后续留空可保留原凭据");
      let jiraAgentId: string | null = null, jiraBaseUrl: string | null = null, jiraSecretId: string | null = null;
      if (data.jira && data.jiraAgentId) throw badRequest("项目连接和旧席位连接不能同时指定");
      if (data.jira) {
        jiraBaseUrl = new URL(data.jira.baseUrl).origin;
        jiraSecretId = prior?.jiraSecretId ?? null;
        let token = data.jira.token;
        if (!token && prior && !prior.jiraSecretId && prior.jiraAgentId) {
          const source = await projectJira(companyId, prior, tx, true);
          if (new URL(source.rule.jiraBaseUrl).origin !== jiraBaseUrl) throw badRequest("变更 Jira 地址时请重新填写 PAT");
          token = await service.resolveSecretValue(companyId, source.rule.jiraSecretId, "latest");
        }
        if (!token && prior?.jiraBaseUrl && new URL(prior.jiraBaseUrl).origin !== jiraBaseUrl) throw badRequest("变更 Jira 地址时请重新填写 PAT");
        if (token) {
          if (jiraSecretId) await service.rotate(jiraSecretId, { value: token }, { userId: req.actor.userId });
          else jiraSecretId = (await service.create(companyId, { name: "项目 Jira 来源 " + data.projectId, provider: "local_encrypted", value: token }, { userId: req.actor.userId })).id;
        }
        if (!jiraSecretId) throw badRequest("首次配置项目 Jira 连接需要填写 PAT");
        await credentialVersion(companyId, [jiraSecretId], tx);
      } else if (data.jiraAgentId) {
        await jira(companyId, data.projectId, data.jiraAgentId, tx);
        jiraAgentId = data.jiraAgentId;
      } else throw badRequest("请配置项目 Jira 服务地址和 PAT");
      const values = { jiraAgentId, jiraBaseUrl, jiraSecretId, organizationId: data.organizationId, credentialSecretId: secretId, revision: data.expectedRevision + 1, lastCheckStatus: "not_checked", lastCheckedAt: null, updatedAt: new Date() };
      const [row] = prior ? await tx.update(deliveryConnections).set(values).where(eq(deliveryConnections.id, prior.id)).returning()
        : await tx.insert(deliveryConnections).values({ companyId, projectId: data.projectId, ...values }).returning();
      await tx.insert(activityLog).values({ companyId, actorType: "user", actorId: req.actor.userId ?? "local-board", action: "delivery.connection.saved", entityType: "delivery_connection", entityId: row!.id, details: { projectId: data.projectId, revision: row!.revision, credentialUpdated: !!data.credentials, jiraCredentialUpdated: !!data.jira?.token, jiraConnectionMode: jiraSecretId ? "project" : "legacy_seat", executionGranted: false } });
      return view(row!, tx);
    });res.setHeader("Cache-Control", "no-store");res.json(result);
  });
  router.post(base + "/organizations", async (req,res) => {
    const companyId=access(req,true);
    const parsed=z.object({projectId:z.string().uuid(),expectedRevision:z.number().int().min(0),credentials:z.object({username:z.string().trim().min(1).max(200),password:z.string().min(1).max(1000)}).strict().optional()}).strict().safeParse(req.body);
    if(!parsed.success)throw badRequest("请同时填写轻舟账号和密码，或使用项目已保存的凭据");
    const data=parsed.data;await project(companyId,data.projectId);
    const [connection]=await db.select().from(deliveryConnections).where(and(eq(deliveryConnections.companyId,companyId),eq(deliveryConnections.projectId,data.projectId)));
    if((connection?.revision??0)!==data.expectedRevision)throw conflict("来源配置已变化，请刷新后重新读取组织");
    if(!data.credentials&&!connection)throw badRequest("首次配置请先填写轻舟账号和密码，再读取组织");
    const stamp=!data.credentials&&connection?await credentialVersion(companyId,[connection.credentialSecretId]):null;
    const result=await organizationReader({credentials:async()=>{
      if(data.credentials)return data.credentials;
      try{return z.object({username:z.string().min(1),password:z.string().min(1)}).strict().parse(JSON.parse(await secrets(db).resolveSecretValue(companyId,connection!.credentialSecretId,"latest")));}
      catch{throw new QingzhouReadError("authentication_required");}
    }}).catch(error=>{throw badRequest(error instanceof QingzhouReadError?error.message:"组织读取失败，请重试");});
    await project(companyId,data.projectId);
    const [current]=await db.select().from(deliveryConnections).where(and(eq(deliveryConnections.companyId,companyId),eq(deliveryConnections.projectId,data.projectId)));
    if((current?.revision??0)!==data.expectedRevision || (stamp&&await credentialVersion(companyId,[connection!.credentialSecretId])!==stamp))throw conflict("读取期间来源配置已变化，请重新读取组织");
    res.setHeader("Cache-Control","no-store");res.json(result);
  });
  router.post(base + "/monthly", async (req, res) => {
    const companyId = access(req, true);
    const parsed = z.object({ projectId: z.string().uuid(), expectedRevision: z.number().int().positive(), month: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/) }).strict().safeParse(req.body);
    if (!parsed.success) throw badRequest("请选择项目与有效排期月份");
    const data = parsed.data; await project(companyId, data.projectId);
    const [connection] = await db.select().from(deliveryConnections).where(and(eq(deliveryConnections.companyId, companyId), eq(deliveryConnections.projectId, data.projectId)));
    if (!connection || connection.revision !== data.expectedRevision) throw conflict("来源配置已变化，请刷新后重试");
    const stamp = await credentialVersion(companyId, [connection.credentialSecretId]);
    const result = await monthlyReader({ organizationId: connection.organizationId, month: data.month, credentials: async () => {
      try { return z.object({ username: z.string().min(1), password: z.string().min(1) }).strict().parse(JSON.parse(await secrets(db).resolveSecretValue(companyId, connection.credentialSecretId, "latest"))); }
      catch { throw new QingzhouReadError("authentication_required"); }
    } }).catch(error => { throw badRequest(error instanceof QingzhouReadError ? error.message : "读取月度排期失败，请重试"); });
    await project(companyId, data.projectId);
    const [current] = await db.select().from(deliveryConnections).where(eq(deliveryConnections.id, connection.id));
    if (current?.revision !== connection.revision || await credentialVersion(companyId, [connection.credentialSecretId]) !== stamp) throw conflict("读取期间来源配置已变化，请重新查询");
    await annotateMonthlyDelivery(db, companyId, data.projectId, result);
    res.setHeader("Cache-Control", "no-store"); res.json(result);
  });
  for (const operation of ["test", "sync"] as const) router.post(base + "/" + operation, async (req, res) => {
    const companyId = access(req, true), parsed = syncInput.safeParse(req.body);
    if (!parsed.success) throw badRequest("请选择已配置项目，填写条目号及排期月份");const data = parsed.data;
    await project(companyId, data.projectId);
    const [connection] = await db.select().from(deliveryConnections).where(and(eq(deliveryConnections.companyId, companyId), eq(deliveryConnections.projectId, data.projectId)));
    if (!connection || connection.revision !== data.expectedRevision) throw conflict("来源尚未配置或配置已变化，请刷新后重试");
    const { agent, rule } = await projectJira(companyId, connection);
    const credentialStamp = await credentialVersion(companyId, [rule.jiraSecretId, connection.credentialSecretId]);
    let fetched: Awaited<ReturnType<typeof reader>>;
    try {
      let token: string;
      try {
        token = await secrets(db).resolveSecretValue(companyId, rule.jiraSecretId, "latest", agent ? { accessContext: { consumerType: "agent", consumerId: agent.id, configPath: "dsp7JiraDispatch.jiraSecretId", responsibleUserId: req.actor.userId, actorType: "user", actorId: req.actor.userId ?? "local-board" } } : undefined);
      } catch { throw new QingzhouReadError("authentication_required"); }
      fetched = await reader({ projectId: data.projectId, demandNo: data.demandNo, months: data.months, organizationId: connection.organizationId,
        credentials: async () => { try { return z.object({ username: z.string().min(1), password: z.string().min(1) }).strict().parse(JSON.parse(await secrets(db).resolveSecretValue(companyId, connection.credentialSecretId, "latest"))); } catch { throw new QingzhouReadError("authentication_required"); } },
        jira: { baseUrl: rule.jiraBaseUrl, token } });
    } catch (error) {
      const status = error instanceof QingzhouReadError ? error.code : "invalid_response";
      await db.transaction(async transaction => {
        const tx = transaction as unknown as Db;
        const changed = await tx.update(deliveryConnections).set({ lastCheckStatus: status, lastCheckedAt: new Date() }).where(and(eq(deliveryConnections.id, connection.id), eq(deliveryConnections.revision, connection.revision))).returning();
        if (changed.length) await tx.insert(activityLog).values({ companyId, actorType: "user", actorId: req.actor.userId ?? "local-board", action: "delivery.connection.checked", entityType: "delivery_connection", entityId: connection.id, details: { operation, status, revision: connection.revision, executionGranted: false } });
      });
      if (error instanceof HttpError && error.status === 400) throw error;
      throw badRequest(error instanceof QingzhouReadError ? error.message : "来源同步失败，请稍后重试或联系管理员核对来源数据");
    }
    const result = await db.transaction(async transaction => {
      const tx = transaction as unknown as Db;
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${companyId + ":delivery-connection:" + data.projectId}, 0))`);
      const [current] = await tx.select().from(deliveryConnections).where(eq(deliveryConnections.id, connection.id)).for("update");
      if (!current || current.revision !== connection.revision) throw conflict("读取期间来源配置已变化，请重新同步");
      await project(companyId, data.projectId, tx);
      const source = await projectJira(companyId, current, tx, true);
      if (source.rule.jiraSecretId !== rule.jiraSecretId || source.rule.jiraBaseUrl !== rule.jiraBaseUrl || source.rule.revision !== rule.revision) throw conflict("读取期间 Jira 连接已变化，请重新同步");
      if (await credentialVersion(companyId, [rule.jiraSecretId, current.credentialSecretId], tx, true) !== credentialStamp) throw conflict("读取期间来源凭据已变化，请重新同步");
      await tx.update(deliveryConnections).set({ lastCheckStatus: "verified", lastCheckedAt: new Date() }).where(eq(deliveryConnections.id, current.id));
      await tx.insert(activityLog).values({ companyId, actorType: "user", actorId: req.actor.userId ?? "local-board", action: "delivery.connection.checked", entityType: "delivery_connection", entityId: current.id, details: { operation, status: "verified", revision: current.revision, executionGranted: false } });
      const { plan, collectedAt } = fetched;
      if (operation === "test") return { plan, saved: false };
      const [prior] = await tx.select().from(deliverySnapshots).where(and(eq(deliverySnapshots.companyId, companyId), eq(deliverySnapshots.projectId, data.projectId), eq(deliverySnapshots.sourceOrigin, "https://proj.fingard.com:1888"), eq(deliverySnapshots.demandNo, data.demandNo), eq(deliverySnapshots.fingerprint, plan.fingerprint)));
      if (prior) return { plan, snapshot: prior, existing: true, saved: true };
      const [snapshot] = await tx.insert(deliverySnapshots).values({ companyId, projectId: data.projectId, sourceOrigin: "https://proj.fingard.com:1888", demandNo: data.demandNo, fingerprint: plan.fingerprint, collectedAt: new Date(collectedAt), createdByUserId: req.actor.userId ?? "local-board", plan }).returning();
      await tx.insert(activityLog).values({ companyId, actorType: "user", actorId: req.actor.userId ?? "local-board", action: "delivery.snapshot.synchronized", entityType: "delivery_snapshot", entityId: snapshot!.id, details: { projectId: data.projectId, demandNo: data.demandNo, connectionRevision: current.revision, sourceMode: "online_readonly", executionGranted: false } });
      return { plan, snapshot, existing: false, saved: true };
    });res.setHeader("Cache-Control", "no-store");res.json(result);
  });
  return router;
}
