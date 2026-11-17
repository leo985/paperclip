import { and, eq, inArray } from "drizzle-orm";
import { budgetPolicies, type agents, type Db } from "@paperclipai/db";
import { harnessCapabilityInputSchema, type HarnessCapabilityInput, type HarnessCapabilityRegistry, type HarnessExecutionRoute } from "@paperclipai/shared";
import { conflict } from "../errors.js";
import { resolveExecutionComposition, selectedExecutionComposition } from "./harness-execution-composition.js";

/** Routing never substitutes one domain for another. Native domain admission and
 * business authorization remain the caller's responsibility. */
export function resolveHarnessRoute(agent: typeof agents.$inferSelect, input: { runId: string; taskId: string; kind: HarnessCapabilityInput["kind"]; required: boolean }): HarnessExecutionRoute | null {
  const registry = agent.adapterConfig.dsp7HarnessCapabilities as HarnessCapabilityRegistry | undefined;
  const seat = agent.adapterConfig.dsp7Seat as { machineId?: string } | undefined;
  if (!seat?.machineId) throw conflict("缺少席位机器绑定");
  const candidates = registry?.items.filter(item => item.kind === input.kind) ?? [];
  if (!candidates.length && !input.required) {
    if (selectedExecutionComposition(agent, input)) throw conflict("正式组合缺少原生领域能力，不允许回退旧入口");
    return null; // preserve existing enrolled development path
  }
  const selected = registry?.routing?.[input.kind];
  const capability = selected ? candidates.find(item => item.id === selected) : candidates.length === 1 ? candidates[0] : undefined;
  if (!registry || !capability) throw conflict("未找到唯一的领域 Harness，请在席位设备与诊断中选择对应路由");
  const { id: _id, checkedAt: _checked, validation: _validation, executionReady: _ready, ...raw } = capability;
  const parsed = harnessCapabilityInputSchema.safeParse(raw);
  if (!parsed.success || registry.version !== 1) throw conflict("能力登记协议无效，请重新登记");
  const composition = resolveExecutionComposition(agent, input, capability.id, registry.revision, parsed.data);
  return { protocolVersion: composition ? 2 : 1, runId: input.runId, taskId: input.taskId, agentId: agent.id, companyId: agent.companyId, machineId: seat.machineId, registryRevision: registry.revision, capabilityId: capability.id, capability: parsed.data, ...(composition ? { composition } : {}) };
}

/** New domains use local subscription/relay pricing, currently unpriced. Do not
 * enable automatic inference under a billed-cents hard policy with unknown cost.
 * No reservation or guaranteed zero overspend is claimed for the legacy path. */
export async function assertNewDomainMetering(db: Db, companyId: string, agentId: string, projectId: string | null) {
  const policies = await db.select().from(budgetPolicies).where(and(eq(budgetPolicies.companyId, companyId), eq(budgetPolicies.isActive, true), eq(budgetPolicies.hardStopEnabled, true), eq(budgetPolicies.metric, "billed_cents"), inArray(budgetPolicies.scopeId, [companyId, agentId, ...(projectId ? [projectId] : [])])));
  if (policies.some(policy => policy.amount > 0 && (policy.scopeType === "company" && policy.scopeId === companyId || policy.scopeType === "agent" && policy.scopeId === agentId || policy.scopeType === "project" && policy.scopeId === projectId))) throw conflict("新领域计费尚未提供实际价格；存在费用硬预算，不能启动自动执行，请由预算管理员处理策略");
}

export function sameHarnessRoute(left: HarnessExecutionRoute | null, right: HarnessExecutionRoute | null) {
  // PostgreSQL jsonb reorders object keys. A persisted permit and the same
  // selection must compare by values rather than insertion order.
  const canonical = (value: unknown): unknown => Array.isArray(value) ? value.map(canonical)
    : value !== null && typeof value === "object" ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => [k, canonical(v)])) : value;
  const key = (route: HarnessExecutionRoute | null) => route ? JSON.stringify([route.protocolVersion,route.runId,route.taskId,route.agentId,route.companyId,route.machineId,route.registryRevision,route.capabilityId,route.capability.kind,route.capability.repository,route.capability.root,route.capability.profile,route.capability.commit,route.capability.manifestDigest,[...route.capability.roles].sort(),canonical(route.composition ?? null)]) : null;
  return key(left) === key(right);
}
