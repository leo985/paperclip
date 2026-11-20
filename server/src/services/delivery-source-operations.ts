import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { activityLog, agents, companySecrets, deliveryConnections, deliverySnapshots, projects, type Db } from "@paperclipai/db";
import { z } from "zod";
import { secretService } from "./secrets.js";
import { readMonthlyDelivery } from "./delivery-monthly.js";
import { createMonthlyDeliveryReader } from "./delivery-monthly-reader.js";
import { readOnlineDelivery } from "./delivery-source-reader.js";
import { QingzhouReadError } from "./qingzhou-client.js";
import { badRequest, conflict, forbidden, HttpError } from "../errors.js";

type Actor = { type: "user" | "system"; id: string };
type Request = { projectId: string; expectedRevision: number };
const credentialSchema = z.object({ username: z.string().min(1), password: z.string().min(1) });

export function createDeliverySourceOperations(db: Db, reader = readOnlineDelivery, secrets = secretService, monthlyReader = readMonthlyDelivery) {
  const readMonthly = createMonthlyDeliveryReader(monthlyReader);
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
  // Resolving a secret updates lastResolvedAt and updatedAt; neither is a credential revision.
  async function credentialVersion(companyId: string, ids: string[], tx: Db = db, lock = false) {
    const query = tx.select({ id: companySecrets.id, version: companySecrets.latestVersion, status: companySecrets.status, deletedAt: companySecrets.deletedAt, provider: companySecrets.provider, externalRef: companySecrets.externalRef, providerConfigId: companySecrets.providerConfigId, lastRotatedAt: companySecrets.lastRotatedAt }).from(companySecrets).where(and(eq(companySecrets.companyId, companyId), inArray(companySecrets.id, ids))).orderBy(companySecrets.id);
    const rows = await (lock ? query.for("update") : query);
    if (rows.length !== new Set(ids).size || rows.some(row => row.deletedAt || row.status !== "active")) throw conflict("来源凭据不可用，请重新保存连接配置");
    return JSON.stringify(rows);
  }
  async function monthly(companyId: string, data: Request & { month: string; forceRefresh?: boolean }) {
    await project(companyId, data.projectId);
    const [connection] = await db.select().from(deliveryConnections).where(and(eq(deliveryConnections.companyId, companyId), eq(deliveryConnections.projectId, data.projectId)));
    if (!connection || connection.revision !== data.expectedRevision) throw conflict("来源配置已变化，请刷新后重试");
    const stamp = await credentialVersion(companyId, [connection.credentialSecretId]);
    const report = await readMonthly({ companyId, projectId: data.projectId, connectionId: connection.id, revision: connection.revision, credentialVersion: stamp }, { organizationId: connection.organizationId, subProductAttribution: connection.subProductAttribution ?? undefined, month: data.month, credentials: async () => {
      try { return credentialSchema.strict().parse(JSON.parse(await secrets(db).resolveSecretValue(companyId, connection.credentialSecretId, "latest"))); }
      catch { throw new QingzhouReadError("authentication_required"); }
    } }, data.forceRefresh).catch(error => { throw badRequest(error instanceof QingzhouReadError ? error.message : "读取月度排期失败，请重试"); });
    await project(companyId, data.projectId);
    const [current] = await db.select().from(deliveryConnections).where(eq(deliveryConnections.id, connection.id));
    if (current?.revision !== connection.revision || await credentialVersion(companyId, [connection.credentialSecretId]) !== stamp) throw conflict("读取期间来源配置已变化，请重新查询");
    return report;
  }

  async function sync(
    companyId: string, data: Request & { demandNo: string; months: string[] }, operation: "test" | "sync", actor: Actor,
    allowCommit?: (current: typeof deliveryConnections.$inferSelect) => boolean,
  ) {
    await project(companyId, data.projectId);
    const [connection] = await db.select().from(deliveryConnections).where(and(eq(deliveryConnections.companyId, companyId), eq(deliveryConnections.projectId, data.projectId)));
    if (!connection || connection.revision !== data.expectedRevision) throw conflict("来源尚未配置或配置已变化，请刷新后重试");
    const { agent, rule } = await projectJira(companyId, connection);
    const credentialStamp = await credentialVersion(companyId, [rule.jiraSecretId, connection.credentialSecretId]);
    let fetched: Awaited<ReturnType<typeof reader>>;
    try {
      let token: string;
      try {
        token = await secrets(db).resolveSecretValue(companyId, rule.jiraSecretId, "latest", agent ? { accessContext: { consumerType: "agent", consumerId: agent.id, configPath: "dsp7JiraDispatch.jiraSecretId", responsibleUserId: actor.type === "user" ? actor.id : undefined, actorType: actor.type, actorId: actor.id } } : undefined);
      } catch { throw new QingzhouReadError("authentication_required"); }
      fetched = await reader({ projectId: data.projectId, demandNo: data.demandNo, months: data.months, organizationId: connection.organizationId, subProductAttribution: connection.subProductAttribution ?? undefined,
        credentials: async () => { try { return credentialSchema.strict().parse(JSON.parse(await secrets(db).resolveSecretValue(companyId, connection.credentialSecretId, "latest"))); } catch { throw new QingzhouReadError("authentication_required"); } },
        jira: { baseUrl: rule.jiraBaseUrl, token } });
    } catch (error) {
      const status = error instanceof QingzhouReadError ? error.code : "invalid_response";
      await db.transaction(async transaction => {
        const tx = transaction as unknown as Db;
        const changed = await tx.update(deliveryConnections).set({ lastCheckStatus: status, lastCheckedAt: new Date() }).where(and(eq(deliveryConnections.id, connection.id), eq(deliveryConnections.revision, connection.revision))).returning();
        if (changed.length) await tx.insert(activityLog).values({ companyId, actorType: actor.type, actorId: actor.id, action: "delivery.connection.checked", entityType: "delivery_connection", entityId: connection.id, details: { operation, status, revision: connection.revision, executionGranted: false } });
      });
      if (error instanceof HttpError && error.status === 400) throw error;
      throw badRequest(error instanceof QingzhouReadError ? error.message : "来源同步失败，请稍后重试或联系管理员核对来源数据");
    }
    return db.transaction(async transaction => {
      const tx = transaction as unknown as Db;
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${companyId + ":delivery-connection:" + data.projectId}, 0))`);
      const [current] = await tx.select().from(deliveryConnections).where(eq(deliveryConnections.id, connection.id)).for("update");
      if (!current || current.revision !== connection.revision) throw conflict("读取期间来源配置已变化，请重新同步");
      if (allowCommit && !allowCommit(current)) throw conflict("定时同步已取消或运行超时");
      await project(companyId, data.projectId, tx);
      const source = await projectJira(companyId, current, tx, true);
      if (source.rule.jiraSecretId !== rule.jiraSecretId || source.rule.jiraBaseUrl !== rule.jiraBaseUrl || source.rule.revision !== rule.revision) throw conflict("读取期间 Jira 连接已变化，请重新同步");
      if (await credentialVersion(companyId, [rule.jiraSecretId, current.credentialSecretId], tx, true) !== credentialStamp) throw conflict("读取期间来源凭据已变化，请重新同步");
      await tx.update(deliveryConnections).set({ lastCheckStatus: "verified", lastCheckedAt: new Date() }).where(eq(deliveryConnections.id, current.id));
      await tx.insert(activityLog).values({ companyId, actorType: actor.type, actorId: actor.id, action: "delivery.connection.checked", entityType: "delivery_connection", entityId: current.id, details: { operation, status: "verified", revision: current.revision, executionGranted: false } });
      const { plan, collectedAt } = fetched;
      if (operation === "test") return { plan, saved: false };
      // A sync only verifies the requested plan months. Preserve membership
      // evidence from other months when this demand gets a newer snapshot.
      const [latest] = await tx.select({ plan: deliverySnapshots.plan }).from(deliverySnapshots)
        .where(and(eq(deliverySnapshots.companyId, companyId), eq(deliverySnapshots.projectId, data.projectId),
          eq(deliverySnapshots.sourceOrigin, "https://proj.fingard.com:1888"), eq(deliverySnapshots.demandNo, data.demandNo)))
        .orderBy(desc(deliverySnapshots.collectedAt), desc(deliverySnapshots.createdAt), desc(deliverySnapshots.id)).limit(1);
      if (plan.reportMonths) {
        plan.reportMonths = [...new Set([
          ...(latest?.plan.reportMonths ?? []).filter(month => !data.months.includes(month)),
          ...plan.reportMonths,
        ])].sort();
      }
      const [prior] = await tx.select().from(deliverySnapshots).where(and(eq(deliverySnapshots.companyId, companyId), eq(deliverySnapshots.projectId, data.projectId), eq(deliverySnapshots.sourceOrigin, "https://proj.fingard.com:1888"), eq(deliverySnapshots.demandNo, data.demandNo), eq(deliverySnapshots.fingerprint, plan.fingerprint)));
      if (prior) {
        const stored = prior.plan.monthlyChildIssues;
        const fresh = plan.monthlyChildIssues;
        if (fresh && (!stored || stored.jiraOrigin !== fresh.jiraOrigin ||
          JSON.stringify(plan.reportMonths) !== JSON.stringify(prior.plan.reportMonths) ||
          Object.entries(fresh.issues).some(([key, fact]) => fact.ownerAccount !== stored.issues[key]?.ownerAccount))) {
          const [snapshot] = await tx.update(deliverySnapshots)
            .set({ plan: { ...prior.plan, reportMonths: plan.reportMonths, monthlyChildIssues: fresh } })
            .where(and(eq(deliverySnapshots.companyId, companyId), eq(deliverySnapshots.id, prior.id))).returning();
          return { plan, snapshot, existing: true, saved: true };
        }
        return { plan, snapshot: prior, existing: true, saved: true };
      }
      const [snapshot] = await tx.insert(deliverySnapshots).values({ companyId, projectId: data.projectId, sourceOrigin: "https://proj.fingard.com:1888", demandNo: data.demandNo, fingerprint: plan.fingerprint, collectedAt: new Date(collectedAt), createdByUserId: actor.id, plan }).returning();
      await tx.insert(activityLog).values({ companyId, actorType: actor.type, actorId: actor.id, action: "delivery.snapshot.synchronized", entityType: "delivery_snapshot", entityId: snapshot!.id, details: { projectId: data.projectId, demandNo: data.demandNo, connectionRevision: current.revision, sourceMode: "online_readonly", executionGranted: false } });
      return { plan, snapshot, existing: false, saved: true };
    });
  }

  return { project, jira, projectJira, credentialVersion, monthly, sync };
}
