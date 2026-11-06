// @vitest-environment jsdom
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import type { ManagedSessionDetail, ManagedTimelineEvent } from "@paperclipai/shared";
import { executionPhaseRows, HarnessExecutionOverview, HarnessExecutionSummary } from "./HarnessExecutionOverview";
const event = (id: string, phase: string, status: string, minute: number, extra: Record<string, unknown> = {}): ManagedTimelineEvent => ({ id, eventType: "phase", occurredAt: `2026-10-26T09:${String(minute).padStart(2,"0")}:00Z`, observedAt: "2026-10-26T10:00:00Z", payload: { phase, status, flowVersion: "v1", ...extra } });
const proof = { gateVersion: "b".repeat(64), evidence: [{script: "harness/scripts/design.py", scriptSha256: "a".repeat(64), exitCode: 0}] };
let cleanup: (()=>void)|undefined;
afterEach(()=>cleanup?.());
function mount(events: ManagedTimelineEvent[]) {
  const detail = {phases: events, timing: {elapsedMs: 60000, executingMs: 20000, waitingMs: 10000, unknownMs: 30000, coverage: .5}, quality:null} as ManagedSessionDetail;
  const node=document.createElement("div");document.body.append(node);const root=createRoot(node);
  flushSync(()=>root.render(<><HarnessExecutionSummary detail={detail}/><HarnessExecutionOverview detail={detail}/></>));
  cleanup=()=>{flushSync(()=>root.unmount());node.remove();};return node;
}
describe("Harness execution flow",()=>{
  it("never infers pass from observation or unsubstantiated pass and keeps flow versions separate",()=>{
    const rows=executionPhaseRows([event("3","设计","passed",3),event("1","设计","observed",1),event("2","设计","passed",2,{...proof,flowVersion:"v2"})]);
    expect(rows).toHaveLength(2);expect(rows[0].passed).toBe(false);expect(rows[1].passed).toBe(true);
  });
  it("reopening invalidates earlier passing evidence and resets the duration interval",()=>{
    const rows=executionPhaseRows([event("1","设计","started",1),event("2","设计","passed",2,proof),event("3","设计","reopened",5),event("4","设计","failed",7)]);
    expect(rows[0].passed).toBe(false);expect(rows[0].durationMs).toBe(120000);
  });
  it("selects the latest stage and allows inspecting earlier evidence without mixing phases",()=>{
    const node=mount([event("1","设计","started",1),event("2","设计","passed",2,proof),event("3","编码","started",3)]);
    const buttons=[...node.querySelectorAll<HTMLButtonElement>('button[aria-pressed]')];
    expect(buttons[1].getAttribute("aria-pressed")).toBe("true");
    expect(node.querySelector('[aria-label="所选阶段详情"]')?.textContent).toContain("编码");
    flushSync(()=>buttons[0].click());
    expect(buttons[0].getAttribute("aria-pressed")).toBe("true");
    expect(node.querySelector("tbody")?.textContent).toContain("harness/scripts/design.py");
    expect(node.textContent).toContain("1 分 0 秒");expect(node.textContent).toContain("50.0%");
  });
  it("defaults to a reopened earlier phase when it has the newest event",()=>{
    const node=mount([event("1","设计","passed",2,proof),event("2","编码","started",3),event("3","设计","reopened",4)]);
    expect(node.querySelector('[aria-label="所选阶段详情"] h4')?.textContent).toBe("设计");
    expect(node.querySelector('[aria-label="所选阶段详情"]')?.textContent).toContain("已重开");
  });
  it("shows missing collection rather than fabricated phases or zero defects",()=>{
    const node=mount([]);expect(node.textContent).toContain("尚未采集到 Harness 阶段事件");expect(node.textContent).toContain("未采集");expect(node.querySelector('button[aria-pressed]')).toBeNull();
  });
});
