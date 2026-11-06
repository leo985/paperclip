import express from "express";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Db } from "@paperclipai/db";
import { jiraIntakeSyncRoutes, syncJiraIntake } from "./jira-intake-sync.js";
import { platformAuthorization } from "./dsp7-jira-dispatch.js";

const auth = vi.hoisted(() => ({ allowed: vi.fn(async () => true), manager: vi.fn(async () => true) }));
vi.mock("./dsp7-seat-owners.js", () => ({ canCreateSeatIntake: auth.allowed, isSeatManagerUser: auth.manager }));
vi.mock("../services/delivery-admission.js", () => ({ assertDeliveryCodingAdmission: vi.fn(async () => {}) }));
vi.mock("../services/secrets.js", () => ({ secretService: () => ({ resolveSecretValue: async () => "private-fixture-token" }) }));
const realFetch = globalThis.fetch;
const seatId = "87ed3723-6fff-40b8-ab01-d0183580686d", taskId = "37f4f46e-de05-4164-9e14-39d2abe4eb48";
const intake = { version: 3, status_source: "seat_rule", seat_id: seatId, jira_key: "ATSES-513404", project_id: "project", workspace_id: "workspace" };
const raw = JSON.stringify(intake);
const rule = { enabled: true, ownerUserId: "current-owner", revision: 2, jiraBaseUrl: "http://jira.fingard.com:6001", jiraSecretId: "secret", jiraProjectKey: "ATSES", jiraAssignee: "zhangzl", projectId: "project", workspaceId: "workspace", readyStatuses: ["修复中"], issueTypes: ["线上问题"] };
const agent = { id: seatId, companyId: "company", status: "idle", adapterConfig: { dsp7Seat: { machineId: "machine", machineFingerprint: "fingerprint" }, dsp7JiraDispatch: rule } } as any;
const task = { id: taskId, companyId: "company", projectId: "project", createdByUserId: "admin", status: "backlog", description: `人工补充说明\n<!-- DSP7-JIRA-INTAKE ${raw} -->` } as any;
function fixture(rows: unknown[][]) {
  const updates: any[] = [], events: any[] = [];
  const db: any = { select: () => { if (!rows.length) throw new Error("Unexpected query"); const result = rows.shift(); const chain: any = { then: (ok: any, no: any) => Promise.resolve(result).then(ok, no) }; for (const name of ["from", "where", "limit", "orderBy", "for"]) chain[name] = () => chain; return chain; }, update: () => ({ set: (data: any) => ({ where: async () => updates.push(data) }) }), insert: () => ({ values: async (data: any) => events.push(data) }) };
  db.transaction = (run: any) => run(db); return { db: db as Db, updates, events };
}
async function post(db: Db, path: string, body: unknown) {
  const app = express(); app.use(express.json()); app.use((req: any, _res, next) => { req.actor = { userId: "admin" }; next(); });
  app.use(jiraIntakeSyncRoutes(db, async () => agent, async () => agent, platformAuthorization));
  app.use((e: any, _req: any, res: any, _next: any) => res.status(e.status ?? 500).json({ error: e.message }));
  const server = app.listen(0, "127.0.0.1"); await new Promise<void>(resolve => server.once("listening", resolve));
  try { const response = await realFetch(`http://127.0.0.1:${(server.address() as any).port}${path}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }); return { status: response.status, body: await response.json() }; }
  finally { await new Promise<void>((resolve, reject) => server.close(e => e ? reject(e) : resolve())); }
}
afterEach(() => { vi.unstubAllGlobals(); auth.allowed.mockReset().mockResolvedValue(true); auth.manager.mockReset().mockResolvedValue(true); });
describe("Jira intake synchronization and bounded machine receipts", () => {
  it("reads a reassignment afresh and preserves the distinction from execution", async () => {
    const responses = ["chenjj1708", "zhangzl"].map(name => new Response(JSON.stringify({ fields: { summary: "测试工单", status: { name: "修复中", statusCategory: { key: "indeterminate" } }, issuetype: { name: "线上问题" }, assignee: { name } } })));
    const fetcher = vi.fn(async () => responses.shift()!); vi.stubGlobal("fetch", fetcher);
    const f = fixture([[], []]);
    expect(await syncJiraIntake(f.db, agent, task, "admin")).toMatchObject({ assignee: "chenjj1708", eligible: true, reasons: [] });
    const current = await syncJiraIntake(f.db, agent, task, "admin");
    expect(current).toMatchObject({ assignee: "zhangzl", status: "修复中", eligible: true });
    expect(fetcher).toHaveBeenCalledTimes(2); expect(f.updates).toEqual([]);
    expect(JSON.stringify(current)).not.toContain("private-fixture-token");
  });
  it("checks current server authority for administrators absent from a local user list", async () => {
    const f = fixture([[task], [{ body: `<!-- DSP7-JIRA-INTAKE-AUTH ${raw} -->` }]]);
    const response = await post(f.db, `/agents/${seatId}/dsp7-jira-intake/authorize`, { taskId });
    expect(response).toMatchObject({ status: 200, body: { authorized: true } });
    expect(auth.allowed).toHaveBeenCalledWith(f.db, agent, "admin");
  });
  it("accepts an attributed blocked receipt without granting generic issue writes", async () => {
    const f = fixture([[agent], [task], []]);
    const response = await post(f.db, `/agents/${seatId}/dsp7-jira-intake/result`, { taskId, request: raw, status: "blocked", message: "仓库不可用", machine_id: "machine", machine_fingerprint: "fingerprint" });
    expect(response.status).toBe(200); expect(f.updates[0].status).toBe("blocked"); expect(f.updates[0].description).toContain("人工补充说明");
    expect(f.events[0]).toMatchObject({ actorType: "agent", agentId: seatId, entityId: taskId, action: "dsp7.jira.intake.result" });
  });
  it("rejects receipts for another seat and never writes", async () => {
    const f = fixture([[agent], [{ ...task, description: task.description.replace(seatId, "other-seat") }]]);
    const response = await post(f.db, `/agents/${seatId}/dsp7-jira-intake/result`, { taskId, request: raw, status: "blocked", message: "x", machine_id: "machine", machine_fingerprint: "fingerprint" });
    expect(response.status).toBe(403); expect(f.updates).toEqual([]);
  });
  it("rejects a receipt while the seat has an active run", async () => {
    const f = fixture([[agent], [task], [{ id: "active" }]]);
    const response = await post(f.db, `/agents/${seatId}/dsp7-jira-intake/result`, { taskId, request: raw, status: "blocked", message: "x", machine_id: "machine", machine_fingerprint: "fingerprint" });
    expect(response.status).toBe(409); expect(f.updates).toEqual([]);
  });
  it("requires the exact exclusive claim before publishing readiness", async () => {
    const f = fixture([[agent], [task], [], []]);
    const response = await post(f.db, `/agents/${seatId}/dsp7-jira-intake/result`, { taskId, request: raw, status: "ready", message: "ready", receipt: { title: "t", description: task.description }, machine_id: "machine", machine_fingerprint: "fingerprint" });
    expect(response.status).toBe(403); expect(f.updates).toEqual([]);
  });
  it("preserves human notes and accepts readiness only for the reserved machine", async () => {
    const claim = { details: { taskId, seatId, machineId: "machine", machineFingerprint: "fingerprint", request: raw } };
    const f = fixture([[agent], [task], [], [claim]]);
    const ready = {status:"ready",jira_key:"ATSES-513404",seat_id:seatId};
    const description = `untrusted replacement\n<!-- DSP7-JIRA-INTAKE ${raw} -->\n\nDSP7-PILOT:ATSES-513404\n<!-- DSP7-INTAKE-RESULT ${JSON.stringify(ready)} -->`;
    const response = await post(f.db, `/agents/${seatId}/dsp7-jira-intake/result`, { taskId, request: raw, status: "ready", message: "ready", receipt: { title: "ATSES-513404", description }, machine_id: "machine", machine_fingerprint: "fingerprint" });
    expect(response.status).toBe(200); expect(f.updates[0].status).toBe("backlog");
    expect(f.updates[0].description).toContain("人工补充说明"); expect(f.updates[0].description).not.toContain("untrusted replacement");
    expect(f.updates[0].description).toContain(`<!-- DSP7-JIRA-INTAKE ${raw} -->`);
  });
  it("rejects stale request receipts without mutation", async () => {
    const f = fixture([[agent], [task]]);
    const response = await post(f.db, `/agents/${seatId}/dsp7-jira-intake/result`, { taskId, request: raw + " ", status: "blocked", message: "x", machine_id: "machine", machine_fingerprint: "fingerprint" });
    expect(response.status).toBe(409); expect(f.updates).toEqual([]);
  });

  it("publishes version 4 readiness without binding a project workspace", async () => {
    const { workspace_id: _legacyWorkspace, ...identity } = intake;
    const current = { ...identity, version: 4 };
    const currentRaw = JSON.stringify(current);
    const source = { ...task, description: `人工说明\n<!-- DSP7-JIRA-INTAKE ${currentRaw} -->` };
    const claim = { details: { taskId, seatId, machineId: "machine", machineFingerprint: "fingerprint", request: currentRaw } };
    const ready = { status: "ready", jira_key: current.jira_key, seat_id: seatId, worktree: null };
    const description = source.description + `\n\nDSP7-PILOT:${current.jira_key}\n<!-- DSP7-INTAKE-RESULT ${JSON.stringify(ready)} -->`;
    const f = fixture([[agent], [source], [], [claim]]);
    const response = await post(f.db, `/agents/${seatId}/dsp7-jira-intake/result`, {
      taskId, request: currentRaw, status: "ready", message: "Harness ready",
      receipt: { title: "ATSES-513404", description }, machine_id: "machine", machine_fingerprint: "fingerprint",
    });
    expect(response.status).toBe(200);
    expect(f.updates[0]).toMatchObject({ projectWorkspaceId: null, assigneeAdapterOverrides: { useProjectWorkspace: false } });
    expect(f.updates[0].description).toContain(`<!-- DSP7-JIRA-INTAKE ${currentRaw} -->`);
  });

  it("assigns only the prepared, exclusively registered task before a model run", async () => {
    const readyTask={...task,description:task.description+'\n<!-- DSP7-INTAKE-RESULT '+JSON.stringify({status:"ready",jira_key:"ATSES-513404",seat_id:seatId})+' -->'};
    const claim={details:{taskId,seatId,machineId:"machine",machineFingerprint:"fingerprint",request:raw}};
    const f=fixture([[agent],[readyTask],[claim],[]]);
    const response=await post(f.db,`/agents/${seatId}/dsp7-jira-intake/start-assignment`,{taskId,request:raw,machine_id:"machine",machine_fingerprint:"fingerprint"});
    expect(response.status).toBe(200);expect(f.updates[0]).toMatchObject({assigneeAgentId:seatId});
    expect(f.updates[0].status).toBeUndefined();expect(f.events[0].action).toBe("dsp7.jira.start.assigned");
  });
  it("does not assign unprepared or already running work", async () => {
    const f=fixture([[agent],[{...task,status:"in_progress"}]]);
    const response=await post(f.db,`/agents/${seatId}/dsp7-jira-intake/start-assignment`,{taskId,request:raw,machine_id:"machine",machine_fingerprint:"fingerprint"});
    expect(response.status).toBe(409);expect(f.updates).toEqual([]);
  });

  it("accepts readiness and startup under a current manager grant after the applicant loses access", async () => {
    auth.allowed.mockResolvedValue(false);
    const source = { ...task, createdByUserId: "former-owner" };
    const grant = { details: { state: "authorized", request: raw, ownerUserId: rule.ownerUserId, managerAuthorizedBy: "manager" } };
    const claim = { details: { taskId, seatId, machineId: "machine", machineFingerprint: "fingerprint", request: raw } };
    const ready = { status: "ready", jira_key: intake.jira_key, seat_id: seatId };
    const description = source.description + `\n\nDSP7-PILOT:${intake.jira_key}\n<!-- DSP7-INTAKE-RESULT ${JSON.stringify(ready)} -->`;
    const f = fixture([[agent], [source], [grant], [], [claim]]);
    const response = await post(f.db, `/agents/${seatId}/dsp7-jira-intake/result`, {
      taskId, request: raw, status: "ready", message: "ready", receipt: { title: intake.jira_key, description }, machine_id: "machine", machine_fingerprint: "fingerprint",
    });
    expect(response.status).toBe(200); expect(f.updates[0].status).toBe("backlog");
    const start = fixture([[agent], [{ ...source, ...f.updates[0] }], [grant], [claim], []]);
    const started = await post(start.db, `/agents/${seatId}/dsp7-jira-intake/start-assignment`, { taskId, request: raw, machine_id: "machine", machine_fingerprint: "fingerprint" });
    expect(started.status).toBe(200); expect(start.updates[0].assigneeAgentId).toBe(seatId);
    expect(auth.manager).toHaveBeenCalledWith(start.db, agent.companyId, "manager");
  });

  it.each([
    ["missing", null, true],
    ["cancelled", { state: "cancelled", request: raw, ownerUserId: rule.ownerUserId, managerAuthorizedBy: "manager" }, true],
    ["changed request", { state: "authorized", request: raw + " ", ownerUserId: rule.ownerUserId, managerAuthorizedBy: "manager" }, true],
    ["changed owner", { state: "authorized", request: raw, ownerUserId: "former-owner", managerAuthorizedBy: "manager" }, true],
    ["revoked manager", { state: "authorized", request: raw, ownerUserId: rule.ownerUserId, managerAuthorizedBy: "manager" }, false],
  ])("rejects %s manager grants for both receipts and startup", async (_name, details, managerAllowed) => {
    auth.allowed.mockResolvedValue(false); auth.manager.mockResolvedValue(managerAllowed);
    for (const endpoint of ["result", "start-assignment"]) {
      const f = fixture([[agent], [{ ...task, createdByUserId: "former-owner" }], details ? [{ details }] : []]);
      const response = await post(f.db, `/agents/${seatId}/dsp7-jira-intake/${endpoint}`, {
        taskId, request: raw, ...(endpoint === "result" ? { status: "blocked", message: "failure" } : {}), machine_id: "machine", machine_fingerprint: "fingerprint",
      });
      expect(response.status).toBe(403); expect(f.updates).toEqual([]);
    }
  });

  it("records a machine's exact terminal-run interruption without releasing checkout", async () => {
    const runId="bf218ec2-13af-4732-9b45-36b358fc0ad0";
    const run={id:runId,status:"failed",finishedAt:new Date(),contextSnapshot:{issueId:taskId,wakeReason:"本地研发人员主动启动交互会话；test"}};
    const f=fixture([[agent],[{...task,status:"in_progress",assigneeAgentId:seatId}],[run]]);
    const response=await post(f.db,`/agents/${seatId}/dsp7-jira-intake/execution-interrupted`,{taskId,runId,stopped:true,action:"执行已中断：本机已停止。 运行编号："+runId,machine_id:"machine",machine_fingerprint:"fingerprint"});
    expect(response.status).toBe(200);expect(f.updates[0].status).toBe("blocked");
    expect(f.updates[0].executionRunId).toBeUndefined();expect(f.events[0].action).toBe("dsp7.jira.execution.interrupted");
  });
  it.each(["DSP7-PILOT:ATSES-513404", "DSP7-PILOT:ATSES-513404:replay-abc123"])("accepts terminal interruption of legacy task %s", async marker => {
    const runId="bf218ec2-13af-4732-9b45-36b358fc0ad0";
    const run={id:runId,status:"failed",finishedAt:new Date(),contextSnapshot:{issueId:taskId,wakeReason:"本地研发人员主动启动交互会话；legacy"}};
    const f=fixture([[agent],[{...task,status:"in_progress",assigneeAgentId:seatId,description:marker+"\nJira: fixture"}],[run]]);
    const response=await post(f.db,`/agents/${seatId}/dsp7-jira-intake/execution-interrupted`,{taskId,runId,stopped:true,action:"执行已中断：运行编号："+runId,machine_id:"machine",machine_fingerprint:"fingerprint"});
    expect(response.status).toBe(200); expect(f.updates[0].status).toBe("blocked");
    expect(f.updates[0].executionRunId).toBeUndefined(); expect(f.updates[0].assigneeAgentId).toBeUndefined();
  });
  it.each([
    ["unregistered task", "ordinary task", 403],
    ["malformed intake with a legacy marker", "DSP7-PILOT:ATSES-513404\n<!-- DSP7-JIRA-INTAKE invalid -->", 400],
    ["another seat's intake with a legacy marker", "DSP7-PILOT:ATSES-513404\n"+task.description.replace(seatId,"other-seat"), 403],
  ])("does not broaden interruption authority for %s", async (_name, description, status) => {
    const runId="bf218ec2-13af-4732-9b45-36b358fc0ad0";
    const f=fixture([[agent],[{...task,status:"in_progress",assigneeAgentId:seatId,description}]]);
    const response=await post(f.db,`/agents/${seatId}/dsp7-jira-intake/execution-interrupted`,{taskId,runId,stopped:true,action:"执行已中断：运行编号："+runId,machine_id:"machine",machine_fingerprint:"fingerprint"});
    expect(response.status).toBe(status); expect(f.updates).toEqual([]);
  });
  it.each(["active run", "other task", "missing finish", "newer run", "other active run"])("retains legacy interruption fences for %s", async scenario => {
    const runId="bf218ec2-13af-4732-9b45-36b358fc0ad0";
    const run={id:runId,status:"failed",finishedAt:new Date(),contextSnapshot:{issueId:taskId,wakeReason:"本地研发人员主动启动交互会话；legacy"}};
    const runs: any[]=[run];
    if(scenario==="active run") run.status="running";
    if(scenario==="other task") run.contextSnapshot.issueId="other-task";
    if(scenario==="missing finish") runs[0]={...run,finishedAt:null};
    if(scenario==="newer run") runs.unshift({...run,id:"newer-run"});
    if(scenario==="other active run") runs.unshift({...run,id:"other-run",status:"running",contextSnapshot:{issueId:"other-task"}});
    const f=fixture([[agent],[{...task,status:"in_progress",assigneeAgentId:seatId,description:"DSP7-PILOT:ATSES-513404\nfixture"}],runs]);
    const response=await post(f.db,`/agents/${seatId}/dsp7-jira-intake/execution-interrupted`,{taskId,runId,stopped:true,action:"执行已中断：运行编号："+runId,machine_id:"machine",machine_fingerprint:"fingerprint"});
    expect(response.status).toBe(409); expect(f.updates).toEqual([]);
  });
  it("refuses an interruption receipt over an active run", async () => {
    const runId="bf218ec2-13af-4732-9b45-36b358fc0ad0";
    const f=fixture([[agent],[{...task,status:"in_progress",assigneeAgentId:seatId}],[{id:runId,status:"running",contextSnapshot:{issueId:taskId,wakeReason:"本地研发人员主动启动交互会话；"}}]]);
    const response=await post(f.db,`/agents/${seatId}/dsp7-jira-intake/execution-interrupted`,{taskId,runId,stopped:true,action:"执行已中断：运行编号："+runId,machine_id:"machine",machine_fingerprint:"fingerprint"});
    expect(response.status).toBe(409);expect(f.updates).toEqual([]);
  });

});
