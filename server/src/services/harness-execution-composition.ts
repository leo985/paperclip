import { z } from "zod";
import { harnessBundleInputSchema, harnessExecutionCompositionSchema, type HarnessCapabilityInput } from "@paperclipai/shared";
import { conflict } from "../errors.js";
import { harnessV2Enabled } from "./harness-v2-rollout.js";

const selection = z.object({
  companyId: z.string().uuid(), seatId: z.string().uuid(), machineId: z.string().uuid(), taskId: z.string().uuid(),
  capabilityId: z.string().min(1).max(128), capabilityRegistryRevision: z.number().int().nonnegative(),
  selectionRevision: z.number().int().positive(), bundleRegistryRevision: z.number().int().nonnegative(),
  bundleDigest: z.string().regex(/^[a-f0-9]{64}$/),
  nativeSkill: harnessExecutionCompositionSchema.shape.nativeSkill,
  entryId: harnessExecutionCompositionSchema.shape.entryId,
}).strict();
const selections = z.array(selection).max(16);
const roles: Record<z.infer<typeof selection>["nativeSkill"], string> = {
  "jira-feature-dev": "coding", "jira-bug-fix": "bug-fix", "jira-design-doc": "system-design",
  "jira-code-review": "code-review", "jira-design-review": "design-review",
};

/** A deployment-scoped operator selection is separate from device discovery.
 * Existing task, Jira role, capacity and budget gates still decide admission. */
export function selectedExecutionComposition(
  agent: { id: string; companyId: string; adapterConfig: Record<string, unknown> },
  input: { runId: string; taskId: string },
) {
  if (process.env.DSP7_HARNESS_EXECUTION_BINDINGS_ENABLED !== "true") return undefined;
  let configured: z.infer<typeof selections>;
  try {
    const raw = process.env.DSP7_HARNESS_EXECUTION_BINDINGS;
    if (!raw || raw.length > 16384) throw new Error();
    configured = selections.parse(JSON.parse(raw));
    const keys = configured.map(s => `${s.companyId}/${s.seatId}/${s.taskId}`);
    if (new Set(keys).size !== keys.length) throw new Error();
  } catch { throw conflict("正式组合选择配置无效"); }
  return configured.find(s => s.companyId === agent.companyId && s.seatId === agent.id && s.taskId === input.taskId);
}

export function resolveExecutionComposition(
  agent: { id: string; companyId: string; adapterConfig: Record<string, unknown> },
  input: { runId: string; taskId: string },
  capabilityId: string, capabilityRevision: number, capability: HarnessCapabilityInput,
) {
  const selected = selectedExecutionComposition(agent, input);
  if (!selected) return undefined;
  const machine = agent.adapterConfig.dsp7Seat as { machineId?: string } | undefined;
  if (!harnessV2Enabled("bundles", agent.companyId, agent.id) || selected.machineId !== machine?.machineId ||
      selected.capabilityId !== capabilityId || selected.capabilityRegistryRevision !== capabilityRevision ||
      capability.kind !== "development" || !capability.roles.includes(roles[selected.nativeSkill] as HarnessCapabilityInput["roles"][number])) {
    throw conflict("正式组合与机器、领域或能力版本不匹配");
  }
  const registry = agent.adapterConfig.dsp7HarnessBundles as { version?: number; revision?: number; items?: unknown[] } | undefined;
  if (registry?.version !== 1 || registry.revision !== selected.bundleRegistryRevision || !Array.isArray(registry.items)) {
    throw conflict("正式组合登记版本已变化");
  }
  const matches = registry.items.filter(item => (item as { bundleDigest?: unknown })?.bundleDigest === selected.bundleDigest);
  if (matches.length !== 1) throw conflict("正式组合未唯一登记");
  const item = matches[0] as Record<string, unknown>;
  const parsed = harnessBundleInputSchema.safeParse({ protocolVersion: item.protocolVersion, bundleDigest: item.bundleDigest,
    project: item.project, packages: item.packages, mode: item.mode });
  if (!parsed.success || !parsed.data.packages.some(p => p.layer === "L4" && p.skills.includes(selected.entryId))) {
    throw conflict("正式组合描述或方法入口无效");
  }
  return harnessExecutionCompositionSchema.parse({ schema: "harness.execution-composition/1",
    selectionRevision: selected.selectionRevision, bundleRegistryRevision: registry.revision, bundle: parsed.data,
    nativeSkill: selected.nativeSkill, entryId: selected.entryId });
}
