import { afterEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { harnessObserverBindingSchema } from "@paperclipai/shared";
import { assertObserverNegotiation, resolveHarnessObserverBinding, sameObserverBinding } from "./harness-observer-binding.js";

function fixture() {
  const agent = { id: randomUUID(), companyId: randomUUID(), adapterConfig: {} as Record<string, unknown> };
  const scope = { taskId: randomUUID(), runId: randomUUID(), machineId: randomUUID(), projectId: randomUUID() };
  const bundle = { protocolVersion: 1, project: "history-pilot", bundleDigest: "a".repeat(64), mode: "candidate",
    packages: [ { id: "runtime", layer: "L3", version: "1.0.0", skills: [], manifestDigest: "b".repeat(64) },
      { id: "methods", layer: "L4", version: "1.0.0", skills: ["history"], manifestDigest: "c".repeat(64) } ] };
  agent.adapterConfig.dsp7HarnessBundles = { version: 1, revision: 2, items: [{ ...bundle,
    checkedAt: new Date().toISOString(), validation: "seat-reported-local-files", executionReady: false, loadState: "unconfirmed" }] };
  vi.stubEnv("DSP7_HARNESS_OBSERVER_BINDINGS_ENABLED", "true");
  vi.stubEnv("DSP7_HARNESS_OBSERVATION_ENABLED", "true");
  vi.stubEnv("DSP7_HARNESS_BUNDLES_ENABLED", "true");
  vi.stubEnv("DSP7_HARNESS_V2_SEATS", JSON.stringify([{ companyId: agent.companyId, seatId: agent.id }]));
  vi.stubEnv("DSP7_HARNESS_OBSERVER_BINDINGS", JSON.stringify([{ companyId: agent.companyId, seatId: agent.id,
    taskId: scope.taskId, projectId: scope.projectId, bundleDigest: bundle.bundleDigest }]));
  return { agent, scope };
}
afterEach(() => vi.unstubAllEnvs());
describe("observer attachments are distinct from execution authority", () => {
  it("negotiates only the exact protocol and never accepts extra fields or confirmed claims", () => {
    const { agent, scope } = fixture(), binding = resolveHarnessObserverBinding(agent, scope)!;
    expect(harnessObserverBindingSchema.safeParse(binding).success).toBe(true);
    for (const protocol of [undefined, true, "1", 2]) expect(() => assertObserverNegotiation(binding, protocol, 2)).toThrow();
    expect(() => assertObserverNegotiation(binding, 1, 1)).toThrow();
    expect(() => assertObserverNegotiation(binding, 1, 2)).not.toThrow();
    for (const mutation of [{ executionReady: true }, { loadState: "confirmed" }, { path: "/tmp/plugin" }, { registryRevision: true }]) {
      expect(harnessObserverBindingSchema.safeParse({ ...binding, ...mutation }).success).toBe(false);
      expect(sameObserverBinding(binding, { ...binding, ...mutation })).toBe(false);
    }
    expect(sameObserverBinding(binding, JSON.parse(JSON.stringify(binding)))).toBe(true);
    expect(sameObserverBinding(binding, null)).toBe(false);
  });
  it("does not select another company, seat or task and does not equate project UUID with bundle scope key", () => {
    const { agent, scope } = fixture();
    expect(resolveHarnessObserverBinding({ ...agent, id: randomUUID() }, scope)).toBeNull();
    expect(resolveHarnessObserverBinding({ ...agent, companyId: randomUUID() }, scope)).toBeNull();
    expect(resolveHarnessObserverBinding(agent, { ...scope, taskId: randomUUID() })).toBeNull();
    expect(() => resolveHarnessObserverBinding(agent, { ...scope, projectId: null })).toThrow();
    expect(resolveHarnessObserverBinding(agent, scope)!.bundle.project).toBe("history-pilot");
  });
  it("refuses duplicate/malformed registry records and missing bundle gates", () => {
    const { agent, scope } = fixture();
    const registry = agent.adapterConfig.dsp7HarnessBundles as { items: unknown[] };
    registry.items.push(registry.items[0]);
    expect(() => resolveHarnessObserverBinding(agent, scope)).toThrow();
    registry.items.pop();
    vi.stubEnv("DSP7_HARNESS_BUNDLES_ENABLED", "false");
    expect(() => resolveHarnessObserverBinding(agent, scope)).toThrow();
    vi.stubEnv("DSP7_HARNESS_OBSERVER_BINDINGS_ENABLED", "false");
    expect(resolveHarnessObserverBinding(agent, scope)).toBeNull();
  });
});
