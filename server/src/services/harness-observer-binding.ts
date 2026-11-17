import { z } from "zod";
import { harnessBundleInputSchema, harnessObserverBindingSchema, type HarnessObserverBinding } from "@paperclipai/shared";
import { harnessV2Enabled } from "./harness-v2-rollout.js";
import { conflict } from "../errors.js";

const selectionSchema = z.array(z.object({
  companyId: z.string().uuid(), seatId: z.string().uuid(), taskId: z.string().uuid(),
  projectId: z.string().uuid().nullable(),
  bundleDigest: z.string().regex(/^[a-f0-9]{64}$/),
}).strict()).max(16);
const registrySchema = z.object({
  version: z.literal(1), revision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  items: z.array(harnessBundleInputSchema.safeExtend({
    checkedAt: z.string().datetime(), validation: z.literal("seat-reported-local-files"),
    executionReady: z.literal(false), loadState: z.literal("unconfirmed"),
  }).strict()).max(16),
}).strict();

export function resolveHarnessObserverBinding(
  agent: { id: string; companyId: string; adapterConfig: Record<string, unknown> },
  scope: { taskId: string; runId: string; machineId: string; projectId: string | null },
): HarnessObserverBinding | null {
  if (process.env.DSP7_HARNESS_OBSERVER_BINDINGS_ENABLED !== "true") return null;
  const raw = process.env.DSP7_HARNESS_OBSERVER_BINDINGS;
  let selections: z.infer<typeof selectionSchema>;
  try {
    if (!raw || raw.length > 16384) throw new Error();
    selections = selectionSchema.parse(JSON.parse(raw));
    const keys = selections.map(s => `${s.companyId}/${s.seatId}/${s.taskId}`);
    if (new Set(keys).size !== keys.length) throw new Error();
  } catch { throw conflict("观察包绑定配置无效"); }
  const selected = selections.find(s => s.companyId === agent.companyId && s.seatId === agent.id && s.taskId === scope.taskId);
  if (!selected) return null;
  if (selected.projectId !== scope.projectId ||
      !harnessV2Enabled("observation", agent.companyId, agent.id) ||
      !harnessV2Enabled("bundles", agent.companyId, agent.id)) throw conflict("观察包绑定范围或开关已变化");
  const registry = registrySchema.safeParse(agent.adapterConfig.dsp7HarnessBundles);
  if (!registry.success) throw conflict("观察包登记无效");
  const matches = registry.data.items.filter(item => item.bundleDigest === selected.bundleDigest);
  if (matches.length !== 1) throw conflict("观察包未唯一登记");
  const bundle = harnessBundleInputSchema.parse({
    protocolVersion: matches[0]!.protocolVersion, bundleDigest: matches[0]!.bundleDigest,
    project: matches[0]!.project, packages: matches[0]!.packages, mode: matches[0]!.mode,
  });
  return harnessObserverBindingSchema.parse({
    schema: "harness.observer-binding/1", companyId: agent.companyId, seatId: agent.id,
    ...scope, registryRevision: registry.data.revision, bundle,
    purpose: "observation-only", executionReady: false, loadState: "unconfirmed",
  });
}

export function assertObserverNegotiation(binding: HarnessObserverBinding | null, observerProtocol?: unknown, supervisionProtocol?: unknown) {
  if (binding && (observerProtocol !== 1 || supervisionProtocol !== 2)) {
    throw conflict("指定观察包需要新版观察绑定及进程树监督协议");
  }
}

export function sameObserverBinding(a: unknown, b: unknown): boolean {
  if (a == null || b == null) return a == null && b == null;
  const left = harnessObserverBindingSchema.safeParse(a), right = harnessObserverBindingSchema.safeParse(b);
  return left.success && right.success && JSON.stringify(left.data) === JSON.stringify(right.data);
}
