import { annotateMonthlyDelivery } from "../services/delivery-monthly-annotations.js";
import { Router, type Request } from "express";
import { and, desc, eq, isNull, sql } from "drizzle-orm";
import { activityLog, deliveryConnections, deliverySnapshots, projects, type Db } from "@paperclipai/db";
import { z } from "zod";
import { assertBoard, assertCompanyAccess } from "./authz.js";
import { isSeatManager } from "./dsp7-seat-owners.js";
import { secretService } from "../services/secrets.js";
import { readQingzhouOrganizations } from "../services/qingzhou-organizations.js";
import { readMonthlyDelivery } from "../services/delivery-monthly.js";
import { createDeliverySourceOperations } from "../services/delivery-source-operations.js";
import { monthlySyncTimePattern, publicDeliveryMonthlySchedule, saveDeliveryMonthlySchedule } from "../services/delivery-monthly-schedule.js";
import { readDeliveryDemand } from "../services/delivery-demand-lookup.js";
import { readOnlineDelivery } from "../services/delivery-source-reader.js";
import { QingzhouReadError } from "../services/qingzhou-client.js";
import { badRequest, conflict, forbidden } from "../errors.js";
import type { DeliveryConnection } from "@paperclipai/shared";

const saveInput = z.object({ projectId: z.string().uuid(), expectedRevision: z.number().int().min(0), jiraAgentId: z.string().uuid().optional(), jira: z.object({ baseUrl: z.string().url().max(2048).refine(value => { try { const u = new URL(value); return ["http:", "https:"].includes(u.protocol) && !u.username && !u.password && !u.search && !u.hash && u.pathname === "/" && (process.env.PAPERCLIP_JIRA_ALLOWED_ORIGINS ?? "http://jira.fingard.com:6001").split(",").map(v=>v.trim()).includes(u.origin); } catch { return false; } }), token: z.string().trim().min(1).max(4096).refine(v=>!/[\r\n\0]/.test(v)).optional() }).strict().optional(), organizationId: z.string().regex(/^\d{1,30}$/), subProductAttribution: z.string().trim().max(100).regex(/^[A-Za-z0-9_.-]*$/).nullable().optional(), credentials: z.object({ username: z.string().trim().min(1).max(200), password: z.string().min(1).max(1000) }).strict().optional() }).strict();
const syncInput = z.object({ projectId: z.string().uuid(), expectedRevision: z.number().int().positive(), demandNo: z.string().regex(/^[A-Z][A-Z0-9]*-\d+$/), months: z.array(z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/)).min(1).max(12) }).strict();
const publicConnection = (row: typeof deliveryConnections.$inferSelect): DeliveryConnection => ({ id: row.id, projectId: row.projectId, jiraAgentId: row.jiraAgentId, jiraBaseUrl: row.jiraBaseUrl ?? "", jiraCredentialsConfigured: !!row.jiraSecretId, jiraConnectionMode: row.jiraSecretId ? "project" : "legacy_seat", organizationId: row.organizationId, subProductAttribution: row.subProductAttribution, revision: row.revision, credentialsConfigured: !!row.credentialSecretId, lastCheckStatus: row.lastCheckStatus, lastCheckedAt: row.lastCheckedAt?.toISOString() ?? null });
export function deliveryConnectionRoutes(db: Db, reader = readOnlineDelivery, secrets = secretService, monthlyReader = readMonthlyDelivery, organizationReader = readQingzhouOrganizations, demandReader = readDeliveryDemand) {
  const router = Router(), base = "/companies/:companyId/delivery-connections";
  const source = createDeliverySourceOperations(db, reader, secrets, monthlyReader);
  const { project, jira, projectJira, credentialVersion } = source;
  function access(req: Request, mutate = false) {
    const companyId = String(req.params.companyId);assertBoard(req);assertCompanyAccess(req, companyId);
    if (mutate && !isSeatManager(req, companyId)) throw forbidden("交付来源配置及同步需要组织管理员权限");
    return companyId;
  }
  async function view(row: typeof deliveryConnections.$inferSelect, includeUsername: boolean, tx: Db = db) {
    const value = publicConnection(row);
    if (!row.jiraSecretId && row.jiraAgentId) {
      try { const source = await jira(row.companyId, row.projectId, row.jiraAgentId, tx); value.jiraBaseUrl = source.rule.jiraBaseUrl; value.jiraCredentialsConfigured = true; } catch { /* Keep broken legacy configuration editable. */ }
    }
    if (includeUsername) {
      try {
        const stored = await secrets(tx).resolveSecretValue(row.companyId, row.credentialSecretId, "latest");
        const parsed = z.object({ username: z.string().min(1) }).safeParse(JSON.parse(stored));
        if (parsed.success) value.qingzhouUsername = parsed.data.username;
      } catch {
        // Keep the configuration editable if its saved credential cannot be read.
      }
    }
    return value;
  }
  router.get(base, async (req, res) => {
    const companyId = access(req), parsed = z.string().uuid().safeParse(req.query.projectId);
    if (!parsed.success) throw badRequest("请选择项目");await project(companyId, parsed.data);
    const [row] = await db.select().from(deliveryConnections).where(and(eq(deliveryConnections.companyId, companyId), eq(deliveryConnections.projectId, parsed.data)));
    res.setHeader("Cache-Control", "no-store");res.json(row ? await view(row, isSeatManager(req, companyId)) : null);
  });
  router.get(base + "/monthly-schedule", async (req, res) => {
    const companyId = access(req, true);
    const parsed = z.string().uuid().safeParse(req.query.projectId);
    if (!parsed.success) throw badRequest("请选择项目");
    await project(companyId, parsed.data);
    const [connection] = await db.select({ schedule: deliveryConnections.monthlySync }).from(deliveryConnections)
      .where(and(eq(deliveryConnections.companyId, companyId), eq(deliveryConnections.projectId, parsed.data)));
    res.setHeader("Cache-Control", "no-store");
    res.json(publicDeliveryMonthlySchedule(connection?.schedule ?? null));
  });
  router.put(base + "/monthly-schedule", async (req, res) => {
    const companyId = access(req, true);
    const parsed = z.object({
      projectId: z.string().uuid(), enabled: z.boolean(), time: z.string().regex(monthlySyncTimePattern),
    }).strict().safeParse(req.body);
    if (!parsed.success) throw badRequest("请选择项目与有效的同步时间");
    const { projectId, ...settings } = parsed.data;
    const schedule = await saveDeliveryMonthlySchedule(db, companyId, projectId, settings, req.actor.userId ?? "local-board", source);
    res.setHeader("Cache-Control", "no-store");
    res.json(schedule);
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
      const values = { jiraAgentId, jiraBaseUrl, jiraSecretId, organizationId: data.organizationId, subProductAttribution: data.subProductAttribution === undefined ? prior?.subProductAttribution ?? null : data.subProductAttribution || null, credentialSecretId: secretId, revision: data.expectedRevision + 1, lastCheckStatus: "not_checked", lastCheckedAt: null, updatedAt: new Date() };
      const [row] = prior ? await tx.update(deliveryConnections).set(values).where(eq(deliveryConnections.id, prior.id)).returning()
        : await tx.insert(deliveryConnections).values({ companyId, projectId: data.projectId, ...values }).returning();
      await tx.insert(activityLog).values({ companyId, actorType: "user", actorId: req.actor.userId ?? "local-board", action: "delivery.connection.saved", entityType: "delivery_connection", entityId: row!.id, details: { projectId: data.projectId, revision: row!.revision, subProductAttribution: row!.subProductAttribution, credentialUpdated: !!data.credentials, jiraCredentialUpdated: !!data.jira?.token, jiraConnectionMode: jiraSecretId ? "project" : "legacy_seat", executionGranted: false } });
      return view(row!, true, tx);
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
  router.post(base + "/lookup", async (req, res) => {
    const companyId = access(req, true);
    const parsed = z.object({ projectId: z.string().uuid(), expectedRevision: z.number().int().positive(), demandNo: z.string().trim().toUpperCase().max(100).regex(/^[A-Z][A-Z0-9]*-\d+$/) }).strict().safeParse(req.body);
    if (!parsed.success) throw badRequest("请填写完整条目编号，例如 TWGF-00919");
    const data = parsed.data;
    await project(companyId, data.projectId);
    const [connection] = await db.select().from(deliveryConnections).where(and(eq(deliveryConnections.companyId, companyId), eq(deliveryConnections.projectId, data.projectId)));
    if (!connection || connection.revision !== data.expectedRevision) throw conflict("来源配置已变化，请刷新后重试");
    const stamp = await credentialVersion(companyId, [connection.credentialSecretId]);
    const result = await demandReader({ demandNo: data.demandNo, credentials: async () => {
      try { return z.object({ username: z.string().min(1), password: z.string().min(1) }).strict().parse(JSON.parse(await secrets(db).resolveSecretValue(companyId, connection.credentialSecretId, "latest"))); }
      catch { throw new QingzhouReadError("authentication_required"); }
    } }).catch(error => {
      if (error instanceof QingzhouReadError && error.code === "invalid_response") throw badRequest("未找到唯一匹配的条目，或轻舟返回数据异常，请核对完整编号与来源权限");
      throw badRequest(error instanceof QingzhouReadError ? error.message : "条目查询失败，请重试");
    });
    await project(companyId, data.projectId);
    const [current] = await db.select().from(deliveryConnections).where(eq(deliveryConnections.id, connection.id));
    if (current?.revision !== connection.revision || await credentialVersion(companyId, [connection.credentialSecretId]) !== stamp) throw conflict("查询期间来源配置已变化，请重新查询");
    const savedEntries = await db.selectDistinctOn([deliverySnapshots.projectId], {
      projectId: deliverySnapshots.projectId,
      projectName: projects.name,
      snapshotId: deliverySnapshots.id,
    }).from(deliverySnapshots).innerJoin(projects, and(
      eq(projects.id, deliverySnapshots.projectId),
      eq(projects.companyId, companyId),
      isNull(projects.archivedAt),
    )).where(and(
      eq(deliverySnapshots.companyId, companyId),
      eq(deliverySnapshots.sourceOrigin, "https://proj.fingard.com:1888"),
      eq(deliverySnapshots.demandNo, data.demandNo),
    )).orderBy(deliverySnapshots.projectId, desc(deliverySnapshots.collectedAt), desc(deliverySnapshots.createdAt), desc(deliverySnapshots.id));
    const snapshotId = savedEntries.find(entry => entry.projectId === data.projectId)?.snapshotId ?? null;
    res.setHeader("Cache-Control", "no-store");
    res.json({ ...result, snapshotId, savedEntries });
  });
  router.post(base + "/monthly", async (req, res) => {
    const started = performance.now();
    const companyId = access(req, true);
    const parsed = z.object({ projectId: z.string().uuid(), expectedRevision: z.number().int().positive(), month: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/), forceRefresh: z.boolean().optional() }).strict().safeParse(req.body);
    if (!parsed.success) throw badRequest("请选择项目与有效排期月份");
    const { result, timings, shared, cached } = await source.monthly(companyId, parsed.data);
    const data = parsed.data;
    const annotationStart = performance.now();
    await annotateMonthlyDelivery(db, companyId, data.projectId, result);
    timings.annotation = performance.now() - annotationStart;
    timings.total = performance.now() - started;
    res.setHeader("Server-Timing", [...Object.entries(timings).map(([name, ms]) => `${name};dur=${ms.toFixed(1)}`), `coalesced;desc="${shared ? "yes" : "no"}"`, `source_cache;desc="${cached ? "hit" : "miss"}"`].join(", "));
    res.setHeader("Cache-Control", "no-store"); res.json(result);
  });
  for (const operation of ["test", "sync"] as const) router.post(base + "/" + operation, async (req, res) => {
    const companyId = access(req, true), parsed = syncInput.safeParse(req.body);
    if (!parsed.success) throw badRequest("请选择已配置项目，填写条目号及排期月份");const data = parsed.data;
    const result = await source.sync(companyId, data, operation, { type: "user", id: req.actor.userId ?? "local-board" });
    res.setHeader("Cache-Control", "no-store");res.json(result);
  });
  return router;
}
