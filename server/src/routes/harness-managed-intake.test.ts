import express from "express";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";
import { HARNESS_REPOSITORY_MANAGEMENT_CAPABILITY } from "@paperclipai/shared";
import { dsp7JiraDispatchRoutes, jiraDispatchSchema, manualIntakeRule } from "./dsp7-jira-dispatch.js";
import { jiraIntakeReasons, readSeatIntake } from "./jira-intake-sync.js";

vi.mock("./dsp7-seat-owners.js", () => ({
  canConfigureSeat: () => true, canCreateSeatIntake: async () => true,
  isSeatManager: () => true, isSeatManagerUser: async () => true,
}));

const projectId = "11111111-1111-4111-8111-111111111111";
const seatId = "22222222-2222-4222-8222-222222222222";
const rule = { enabled: true, jiraBaseUrl: "http://jira.fingard.com:6001", jiraAssignee: "dev",
  jiraProjectKey: "ATSES", projectId, readyStatuses: ["编码中"], issueTypes: ["编码"] };
const agent: any = { id: seatId, companyId: "company", status: "idle", adapterConfig: {
  dsp7Seat: { intakeUserIds: ["owner"] }, dsp7JiraDispatch: { ...rule, jiraSecretId: "secret", revision: 1 },
  dsp7SeatPresence: { capabilities: [HARNESS_REPOSITORY_MANAGEMENT_CAPABILITY] },
} };
const intake = { version: 4, seat_id: seatId, jira_key: "ATSES-1", project_id: projectId, status_source: "seat_rule" };

describe("Harness manages execution repositories", () => {
  it("accepts project scope without a workspace and still rejects missing project scope", () => {
    expect(jiraDispatchSchema.safeParse(rule).success).toBe(true);
    expect(jiraDispatchSchema.safeParse({ ...rule, projectId: undefined }).success).toBe(false);
    expect(manualIntakeRule(agent, intake)).toMatchObject({ projectId });
    expect(() => manualIntakeRule(agent, { ...intake, project_id: seatId })).toThrow("所选项目");
    expect(jiraIntakeReasons(rule, intake, { status: { name: "编码中" }, issuetype: { name: "编码" } })).toEqual([]);
  });

  it("requires a capable client while preserving company and seat boundaries", () => {
    const task: any = { companyId: "company", projectId, description: `<!-- DSP7-JIRA-INTAKE ${JSON.stringify(intake)} -->` };
    expect(readSeatIntake(agent, task).intake).toMatchObject({ version: 4 });
    expect(() => readSeatIntake(agent, { ...task, companyId: "other" })).toThrow("组织");
    expect(() => manualIntakeRule({ ...agent, adapterConfig: { ...agent.adapterConfig, dsp7SeatPresence: {} } }, intake)).toThrow("更新席位客户端");
  });

  it("saves rules for a project with no repositories without looking up any workspace", async () => {
    const rows = [[{ id: projectId, companyId: "company", archivedAt: null }], [agent]];
    const writes: any[] = [], events: any[] = [];
    const db: any = {
      select: vi.fn(() => {
        const value = rows.shift();
        if (!value) throw new Error("Unexpected repository query");
        const chain: any = { then: (ok: any, no: any) => Promise.resolve(value).then(ok, no) };
        for (const method of ["from", "where", "for"]) chain[method] = () => chain;
        return chain;
      }),
      execute: async () => {},
      update: () => ({ set: (data: any) => ({ where: async () => writes.push(data) }) }),
      insert: () => ({ values: async (event: any) => events.push(event) }),
    };
    db.transaction = (run: any) => run(db);
    const app = express(); app.use(express.json());
    app.use((req: any, _res, next) => { req.actor = { userId: "owner" }; next(); });
    app.use(dsp7JiraDispatchRoutes(db, async () => agent, async () => agent));
    app.use((error: any, _req: any, res: any, _next: any) => res.status(error.status ?? 500).json({ error: error.message }));
    const response = await request(app).post(`/companies/company/dsp7-seats/${seatId}/jira-dispatch`).send(rule);
    expect(response.status).toBe(200);
    expect(response.body).not.toHaveProperty("workspaceId");
    expect(writes[0].adapterConfig.dsp7JiraDispatch).not.toHaveProperty("workspaceId");
    expect(events[0].action).toBe("dsp7.jira.dispatch.configured");
    expect(db.select).toHaveBeenCalledTimes(2);
  });
});
