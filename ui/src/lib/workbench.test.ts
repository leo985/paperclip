import { describe, expect, it } from "vitest";
import type { AnalysisPendingAction, AttentionItem, CompactIssue } from "@paperclipai/shared";
import type { RegisteredSeat } from "@/api/dsp7-seats";
import { managementRows } from "./management-work";
import { legacyInboxTarget, workbenchActions, workbenchTab } from "./workbench";
import { resolveManagementScope } from "@/hooks/useManagementScope";

const task = (id: string, extra = {}) => ({ id, title: id, status: "in_progress", projectId: "p", assigneeAgentId: "seat", updatedAt: "2026-11-12", ...extra }) as unknown as CompactIssue;
const seat = { agentId: "seat", name: "李巍席位", online: false, isMine: true, owner: { id: "me" }, presence: { lastSeenAt: "2026-11-12", tasks: [], alerts: [] } } as unknown as RegisteredSeat;
const decision = { id: "decision", taskId: "a", projectId: "p", ownerUserId: "me", seatId: "seat", runId: "run", key: "Q1", kind: "question", title: "需求分析", prompt: "请确认规则", createdAt: "2026-11-12" } as AnalysisPendingAction;
function project(extra: Partial<Parameters<typeof workbenchActions>[0]> = {}) {
  return workbenchActions({ rows: [], seats: [], analysis: [], platform: [], scope: "mine", userId: "me", executionEvidenceReady: true, ...extra });
}

describe("workbench responsibilities and action identity", () => {
  it("defaults to personal actions and restricts administrator tabs and stored scope", () => {
    expect(workbenchTab(new URLSearchParams(), true)).toBe("pending");
    expect(workbenchTab(new URLSearchParams("scope=company"), true)).toBe("organization");
    expect(workbenchTab(new URLSearchParams("tab=organization&scope=company"), false)).toBe("pending");
    expect(resolveManagementScope(false, "company", "company")).toBe("mine");
    expect(resolveManagementScope(true, null, "mine")).toBe("mine");
    expect(resolveManagementScope(true, "company", "mine")).toBe("company");
  });
  it("keeps legacy projects, filters, history tabs and fragment when redirecting", () => {
    const target = legacyInboxTarget("/ACME/inbox/unread", "?projectId=p&scope=mine", "#notice");
    expect(target).toContain("projectId=p"); expect(target).toContain("scope=mine");
    expect(target).toContain("tab=notifications"); expect(target).toContain("legacyTab=unread"); expect(target).toMatch(/#notice$/);
    expect(legacyInboxTarget("/inbox", "?scope=company")).toContain("tab=organization");
    expect(legacyInboxTarget("/inbox/blocked", "")).toContain("action=recovery");
  });
  it("counts multiple questions independently but deduplicates the same current question", () => {
    const actions = project({ analysis: [decision, { ...decision, id: "duplicate" }, { ...decision, id: "review", key: "P3-review", kind: "review" }] });
    expect(actions).toHaveLength(2); expect(actions.map(action => action.actionLabel)).toEqual(["回答业务问题", "评审分析结果"]);
    expect(actions[0].href).toBe("/issues/a");
  });
  it("does not make another person's analysis into the administrator's personal todo", () => {
    expect(project({ analysis: [{ ...decision, ownerUserId: "other" }] })).toHaveLength(0);
    expect(project({ scope: "company", analysis: [{ ...decision, ownerUserId: "other" }] })).toHaveLength(1);
    expect(project({ analysis: [decision], projectId: "another-project" })).toHaveLength(0);
  });
  it("aggregates offline active tasks by device and excludes queued and finished tasks", () => {
    const rows = managementRows([task("a"), task("b"), task("queued", { status: "todo" }), task("done", { status: "done" })], [seat], new Set());
    const actions = project({ rows, seats: [seat] });
    expect(actions).toHaveLength(1); expect(actions[0].affectedTasks?.map(row => row.issue.id)).toEqual(["a", "b"]);
    expect(actions[0].href).toBe("/seats?seat=seat");
  });
  it("keeps missing evidence and transient fetch failures out of actionable counts", () => {
    const rows = managementRows([task("a")], [], new Set());
    expect(project({ rows })).toHaveLength(0);
    expect(project({ rows: managementRows([task("a")], [seat], new Set()), executionEvidenceReady: false })).toHaveLength(0);
  });
  it("does not recreate an answered analysis question from a stale waiting heartbeat", () => {
    const online = { ...seat, online: true, presence: { ...seat.presence!, state: "waiting_decision", activeTaskId: "a" } } as RegisteredSeat;
    const rows = managementRows([task("a", { deliveryStages: ["analysis"] })], [online], new Set());
    expect(project({ rows, seats: [online] })).toHaveLength(0);
    expect(project({ rows, seats: [online], analysis: [decision] })).toHaveLength(1);
  });
  it("keeps unassigned organization approvals out of Mine and honors explicit recipients", () => {
    const approval = { id: "approval", sourceKind: "approval", subject: { title: "批准配置", href: "/approvals/one" }, project: null, createdAt: "2026-11-12" } as AttentionItem;
    expect(project({ platform: [approval] })).toHaveLength(0);
    expect(project({ platform: [approval], scope: "company" })).toHaveLength(1);
    const row = managementRows([task("a")], [], new Set())[0];
    const interaction = { ...approval, sourceKind: "issue_thread_interaction", relatedIssue: { id: "a" }, resolverAudience: { addresseeUserId: "other" } } as AttentionItem;
    expect(project({ platform: [interaction], rows: [row] })).toHaveLength(0);
    expect(project({ platform: [{ ...interaction, resolverAudience: { addresseeUserId: "me" } } as AttentionItem], rows: [row] })).toHaveLength(1);
  });
  it("read or dismissed state never substitutes for resolving an active decision", () => {
    const approval = { id: "approval", sourceKind: "approval", subject: { href: "/approvals/one" }, createdAt: "2026-11-12", dismissal: { isActive: true } } as AttentionItem;
    expect(project({ scope: "company", platform: [approval] })).toHaveLength(1);
  });
});

it("uses activated workflow actions and suppresses generic todos for waiting workflow tasks",()=>{
 const rows=managementRows([task("active",{status:"blocked"}),task("future",{status:"blocked"})],[seat],new Set());
 const delivery={managedTaskIds:['active','future'],actions:[{id:'delivery:flow:active:work',workflowId:'flow',snapshotId:'snapshot',projectId:'p',taskId:'active',ownerUserId:'me',kind:'work' as const,title:'人工设计',reason:'前置完成',actionLabel:'提交人工交付',href:'/delivery?snapshotId=snapshot#delivery-node-active',createdAt:'2026-11-17'}]};
 const result=project({rows,seats:[seat],delivery});
 expect(result).toHaveLength(1);expect(result[0]).toMatchObject({kind:'work',taskId:'active',href:delivery.actions[0].href});
 expect(project({rows,seats:[seat],delivery:{...delivery,actions:[]}})).toEqual([]);
 expect(project({delivery:{...delivery,actions:[{...delivery.actions[0],ownerUserId:'someone'}]}})).toEqual([]);
 expect(project({delivery,projectId:'other'})).toEqual([]);
});
