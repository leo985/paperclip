import { describe, expect, it, vi } from "vitest";
import type { Db } from "@paperclipai/db";
import { PgDialect } from "drizzle-orm/pg-core";
import { startupRetryBlockedReason } from "./seat-startup-retry.js";
vi.mock("./seat-execution-stop.js", () => ({ hasSeatStopIntent: async () => false }));
const now = new Date();
const authorization = { createdAt: now, details: { state: "authorized" } };
const command = { entityId: "command", createdAt: now };
const agent = (presence = {}) => ({ id: "seat", companyId: "company", adapterConfig: { dsp7Transport: "outbound", dsp7SeatPresence: { state: "idle", capabilities: ["execution-recovery-v1"], lastSeenAt: new Date().toISOString(), ...presence } } }) as any;
const task = (status = "in_progress") => ({ id: "task", companyId: "company", assigneeAgentId: "seat", status }) as any;
const run = { id: "run", agentId: "seat", status: "failed" };
function db(rows: any[][], conditions: any[] = []) {
  return { select: () => { const result = rows.shift(); if (!result) throw new Error("Unexpected query"); const chain: any = { then: (ok: any, no: any) => Promise.resolve(result).then(ok, no) }; for (const key of ["from", "orderBy", "limit"]) chain[key] = () => chain; chain.where = (condition: any) => { conditions.push(condition); return chain; }; return chain; } } as unknown as Db;
}
const initial = (status = "failed") => [[authorization], [command], [{ details: { status } }]];
describe("failed seat startup retry", () => {
  it("allows stale in_progress only with the latest run's stopped proof", async () => {
    expect(await startupRetryBlockedReason(db([...initial(), [], [run]]), agent({ tasks: [{ taskId: "task", stoppedRunId: "run" }] }), task())).toBeNull();
  });
  it("matches the real local session when later comment wakes never invoked a model", async () => {
    const conditions: any[] = [];
    expect(await startupRetryBlockedReason(db([...initial(), [], [run]], conditions), agent({ tasks: [{ taskId: "task", stoppedRunId: "run" }] }), task())).toBeNull();
    const dialect = new PgDialect();
    const active = dialect.sqlToQuery(conditions[3]);
    const latest = dialect.sqlToQuery(conditions[4]);
    // The latest-session lookup is narrowed, while all active runs still block.
    expect(latest.sql).toContain("wakeReason");
    expect(latest.params).toContain("本地研发人员主动启动交互会话；%");
    expect(active.sql).not.toContain("wakeReason");
    expect(active.params).toEqual(expect.arrayContaining(["queued", "running", "scheduled_retry"]));
  });
  it("allows a failed pre-run startup without inventing a run", async () => {
    expect(await startupRetryBlockedReason(db([...initial(), [], []]), agent(), task("backlog"))).toBeNull();
  });
  it.each(["queued", "running", "scheduled_retry"])("rejects active %s runs", async status => {
    expect(await startupRetryBlockedReason(db([...initial(), [{ status }]]), agent(), task())).toContain("活动运行");
  });
  it.each([undefined, "old-run"])("requires exact local stopped proof (%s)", async stoppedRunId => {
    expect(await startupRetryBlockedReason(db([...initial(), [], [run]]), agent({ tasks: [{ taskId: "task", stoppedRunId }] }), task())).toContain("尚未确认");
  });
  it("does not let a failed receipt override local active presence", async () => {
    expect(await startupRetryBlockedReason(db(initial()), agent({ activeRuns: [{ taskId: "task" }] }), task())).toContain("活动执行");
  });
  it("requires a fresh heartbeat", async () => {
    expect(await startupRetryBlockedReason(db(initial()), agent({ lastSeenAt: "invalid" }), task())).toContain("等待席位上线");
  });
  it("rejects accepted commands and stale failures from older dispatches", async () => {
    expect(await startupRetryBlockedReason(db(initial("accepted")), agent(), task())).toContain("尚未确认失败");
    expect(await startupRetryBlockedReason(db([[authorization], [{ ...command, createdAt: new Date(0) }]]), agent(), task())).toContain("当前派单");
  });
  it("preserves explicit stop, completion and unrelated blockers", async () => {
    expect(await startupRetryBlockedReason(db([...initial(), [], [{ ...run, resultJson: { dsp7StopIntent: true } }]]), agent({ tasks: [{ taskId: "task", stoppedRunId: "run" }] }), task())).toContain("明确停止");
    for (const status of ["done", "cancelled", "blocked"]) expect(await startupRetryBlockedReason(db([]), agent(), task(status))).toContain("阻塞或结束");
  });
  it("never resets a successful run or unaccounted in_progress task", async () => {
    expect(await startupRetryBlockedReason(db([...initial(), [], [{ ...run, status: "succeeded" }]]), agent(), task())).toContain("尚未确认");
    expect(await startupRetryBlockedReason(db([...initial(), [], []]), agent(), task())).toContain("缺少运行记录");
  });
});
