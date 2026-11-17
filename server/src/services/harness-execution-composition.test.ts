import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { agents } from "@paperclipai/db";
import { resolveHarnessRoute, sameHarnessRoute } from "./harness-execution-routing.js";

function fixture() {
  const taskId = randomUUID(), runId = randomUUID(), machineId = randomUUID();
  const bundle = { protocolVersion: 1, bundleDigest: "c".repeat(64), project: "base-harness-infrastructure", mode: "candidate",
    packages: [{ id: "runtime", version: "0.1.0", layer: "L3", manifestDigest: "d".repeat(64), skills: ["inspect"] },
      { id: "methods", version: "0.1.0", layer: "L4", manifestDigest: "e".repeat(64), skills: ["feature-pilot"] }] };
  const agent = { id: randomUUID(), companyId: randomUUID(), adapterConfig: { dsp7Seat: { machineId },
    dsp7HarnessCapabilities: { version: 1, revision: 2, items: [{ id: "native", kind: "development", repository: "git.example/harness", root: "/native",
      profile: "default", commit: "a".repeat(40), manifestDigest: "b".repeat(64), roles: ["coding"], protocolVersion: 1, checkedAt: new Date().toISOString(), validation: "local-files", executionReady: false }] },
    dsp7HarnessBundles: { version: 1, revision: 3, items: [{ ...bundle, checkedAt: new Date().toISOString(), validation: "seat-reported-local-files", executionReady: false, loadState: "unconfirmed" }] } } };
  const selection = { companyId: agent.companyId, seatId: agent.id, machineId, taskId, capabilityId: "native", capabilityRegistryRevision: 2,
    selectionRevision: 1, bundleRegistryRevision: 3, bundleDigest: bundle.bundleDigest, nativeSkill: "jira-feature-dev", entryId: "feature-pilot" };
  const input = { taskId, runId, kind: "development" as const, required: false };
  const configure = (value = selection) => {
    vi.stubEnv("DSP7_HARNESS_EXECUTION_BINDINGS_ENABLED", "true");
    vi.stubEnv("DSP7_HARNESS_EXECUTION_BINDINGS", JSON.stringify([value]));
    vi.stubEnv("DSP7_HARNESS_BUNDLES_ENABLED", "true");
    vi.stubEnv("DSP7_HARNESS_V2_SEATS", JSON.stringify([{ companyId: agent.companyId, seatId: agent.id }]));
  };
  const resolve = () => resolveHarnessRoute(agent as unknown as typeof agents.$inferSelect, input)!;
  return { agent, selection, input, configure, resolve };
}
afterEach(() => vi.unstubAllEnvs());
describe("formal native execution composition", () => {
  it("keeps discovery on v1 until explicitly selected and freezes v2 in the native route", () => {
    const f = fixture(); expect(f.resolve().protocolVersion).toBe(1);
    f.configure(); const route = f.resolve();
    expect(route.protocolVersion).toBe(2); expect(route.composition?.entryId).toBe("feature-pilot");
    expect(sameHarnessRoute(route, JSON.parse(JSON.stringify(route)))).toBe(true);
    const reorder = (value: unknown): unknown => Array.isArray(value) ? value.map(reorder)
      : value !== null && typeof value === "object" ? Object.fromEntries(Object.entries(value).reverse().map(([k, v]) => [k, reorder(v)])) : value;
    expect(sameHarnessRoute(route, reorder(route) as typeof route)).toBe(true);
    f.configure({ ...f.selection, selectionRevision: 2 });
    expect(sameHarnessRoute(route, f.resolve())).toBe(false);
    expect(f.agent.adapterConfig.dsp7HarnessBundles.items[0]!.executionReady).toBe(false);
  });
  it("does not apply a selection to another task or seat", () => {
    const f = fixture(); f.configure({ ...f.selection, taskId: randomUUID() }); expect(f.resolve().protocolVersion).toBe(1);
    f.configure({ ...f.selection, seatId: randomUUID() }); expect(f.resolve().protocolVersion).toBe(1);
  });
  it("refuses machine, version, entry, kind and role drift without legacy fallback", () => {
    const f = fixture();
    for (const change of [{ machineId: randomUUID() }, { capabilityRegistryRevision: 9 }, { bundleRegistryRevision: 9 },
      { capabilityId: "other" }, { entryId: "absent" }, { nativeSkill: "jira-code-review" }, { bundleDigest: "f".repeat(64) }]) {
      f.configure({ ...f.selection, ...change }); expect(f.resolve).toThrow();
    }
    f.configure(); f.agent.adapterConfig.dsp7HarnessCapabilities.items = []; expect(f.resolve).toThrow("回退");
  });
  it("rejects malformed/duplicate selection, disabled scope and ambiguous bundle records", () => {
    const f = fixture(); f.configure();
    vi.stubEnv("DSP7_HARNESS_EXECUTION_BINDINGS", JSON.stringify([f.selection, f.selection])); expect(f.resolve).toThrow("配置");
    f.configure(); vi.stubEnv("DSP7_HARNESS_V2_SEATS", "[]"); expect(f.resolve).toThrow("不匹配");
    f.configure(); f.agent.adapterConfig.dsp7HarnessBundles.items.push(f.agent.adapterConfig.dsp7HarnessBundles.items[0]!); expect(f.resolve).toThrow("唯一");
  });
});
