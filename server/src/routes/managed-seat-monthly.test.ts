import { randomUUID } from "node:crypto";
import express, { type ErrorRequestHandler } from "express";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { agents, companies, createDb, deliverySnapshots, deliveryWorkflows, projects } from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "../__tests__/helpers/embedded-postgres.js";
import { fixture } from "../services/delivery-intake.fixture.js";
import { normalizeDeliverySnapshot } from "../services/delivery-intake.js";
import { managedReportRoutes } from "./managed-session-reports.js";

const support = await getEmbeddedPostgresTestSupport();

(support.supported ? describe : describe.skip)("seat monthly delivery report", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  const companyId = randomUUID();
  const otherCompany = randomUUID();
  const projectId = randomUUID();
  const seatId = randomUUID();
  const path = `/companies/${companyId}/managed-seat-report/monthly-delivery`;
  const origin = "https://jira.example.com";

  function appFor(userId: string, membershipRole = "member") {
    const app = express();
    app.use((req, _res, next) => {
      req.actor = {
        type: "board", source: "session", userId, companyIds: [companyId],
        memberships: [{ companyId, membershipRole, status: "active" }],
      };
      next();
    });
    app.use(managedReportRoutes(db));
    const errorHandler: ErrorRequestHandler = (error, _req, res, _next) => {
      res.status(error.status ?? 500).json({ error: error.message });
    };
    app.use(errorHandler);
    return app;
  }

  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("seat-monthly-");
    db = createDb(database.connectionString);
    await db.insert(companies).values([
      { id: companyId, name: "Company", issuePrefix: "MONTHLY" },
      { id: otherCompany, name: "Other", issuePrefix: "OTHER" },
    ]);
    await db.insert(projects).values({ id: projectId, companyId, name: "Delivery" });
    await db.insert(agents).values({
      id: seatId, companyId, name: "Seat", role: "engineer", adapterType: "claude_local",
      adapterConfig: {
        dsp7WebJiraIntake: true,
        dsp7Seat: { ownerUserId: "owner" },
        dsp7JiraDispatch: { projectId, jiraBaseUrl: origin, jiraAssignee: "jira-owner" },
      },
    });
    const input = fixture();
    const schedule = JSON.parse(input.scheduleJsons[0]!);
    const parent = schedule.data[0].children[0];
    parent.preEndDate = "2020-11-20";
    parent.children.push({ ...parent.children[0], issueNo: "ATSES-3", urid: "1846022152414969860", preEndDate: "2020-10-20" });
    input.scheduleJsons = [JSON.stringify(schedule)];
    const jira = JSON.parse(input.jiraJson);
    jira.issues[2].fields.assignee = { name: "jira-owner", displayName: "测试人员" };
    jira.issues[2].fields.issuetype.name = "功能测试";
    jira.issues[2].fields.status = { name: "处理中", statusCategory: { key: "indeterminate" } };
    input.jiraJson = JSON.stringify(jira);
    const plan = normalizeDeliverySnapshot(input, "online_readonly");
    plan.monthlyChildIssues!.jiraOrigin = origin;
    const [snapshot] = await db.insert(deliverySnapshots).values({
      companyId, projectId, demandNo: input.demandNo, sourceOrigin: input.sourceOrigin,
      fingerprint: plan.fingerprint, collectedAt: new Date(input.collectedAt), createdByUserId: "owner", plan,
    }).returning({ id: deliverySnapshots.id });
    const requestId = randomUUID();
    await db.insert(deliveryWorkflows).values({
      companyId, projectId, snapshotId: snapshot!.id, demandNo: input.demandNo, fingerprint: plan.fingerprint,
      requestId, createdBy: "owner", state: "blocked",
      config: {
        requestId, snapshotId: snapshot!.id, analysisSeatId: "", developmentSeatId: "", qaSeatId: seatId,
        designKey: "", codingKey: "", testCasesKey: "", testExecutionKey: "ATSES-3", environmentReference: "",
      },
      stages: [{
        stage: "functional-test", executionMode: "seat", taskId: randomUUID(), seatId, ownerUserId: "owner",
        jiraKey: "ATSES-3", parentKey: "ATSES-1", dispatchId: randomUUID(), state: "interrupted",
        runId: null, capabilityId: null, registryRevision: null, inputDigest: "fixture", receipt: null,
        receiptDigest: null, review: null, message: null,
      }],
    });
  }, 30_000);

  afterAll(async () => { await database?.cleanup(); });

  it("counts only the valid test subtask even when its Jira parent is already completed", async () => {
    const report = await request(appFor("owner")).get(path).query({ month: "2020-10" });
    expect(report.status).toBe(200);
    expect(report.body.seats).toEqual([expect.objectContaining({ id: seatId, ownerUserId: "owner" })]);
    expect(report.body.issues).toHaveLength(1);
    expect(report.body.issues[0]).toMatchObject({
      key: "ATSES-3", parentKey: "ATSES-1", issueType: "功能测试", seatIds: [seatId],
      dueDate: "2020-10-20", deadlineSource: "child", risk: "overdue", completed: false, interrupted: true,
    });
    expect(report.text).not.toContain("jira-owner");
    const nextMonth = await request(appFor("owner")).get(path).query({ month: "2020-11" });
    expect(nextMonth.body.issues).toEqual([]);
  });

  it("limits members to their own seats and validates calendar and company scope", async () => {
    const member = await request(appFor("visitor")).get(path).query({ month: "2020-10" });
    expect(member.status).toBe(200);
    expect(member.body).toMatchObject({ seats: [], issues: [] });
    const admin = await request(appFor("admin", "admin")).get(path).query({ month: "2020-10" });
    expect(admin.body.issues).toHaveLength(1);
    expect((await request(appFor("admin", "admin")).get(path.replace(companyId, otherCompany)).query({ month: "2020-10" })).status).toBe(403);
    expect((await request(appFor("owner")).get(path).query({ month: "2020-13" })).status).toBe(400);
  });

  it("counts an October-due Jira subtask in its November Qingzhou plan even if its platform stage remains interrupted", async () => {
    const [prior] = await db.select().from(deliverySnapshots);
    const projection = prior!.plan.monthlyChildIssues!;
    const subtask = projection.issues["ATSES-3"]!;
    const plan = {
      ...prior!.plan,
      reportMonths: ["2020-11"],
      items: prior!.plan.items.map(item => item.key === "ATSES-1" ? { ...item, status: "处理中" } :
        item.key === "ATSES-3" ? { ...item, status: "已完成" } : item),
      monthlyChildIssues: { jiraOrigin: origin, issues: { ...projection.issues, "ATSES-3": { ...subtask, done: true } } },
    };
    await db.insert(deliverySnapshots).values({
      ...prior!, id: randomUUID(), collectedAt: new Date(), fingerprint: "latest-source-version", plan,
    });
    const report = await request(appFor("owner")).get(path).query({ month: "2020-11" });
    expect(report.status).toBe(200);
    expect(report.body.issues).toHaveLength(1);
    expect(report.body.issues[0]).toMatchObject({ key: "ATSES-3", status: "已完成", dueDate: "2020-10-20", risk: "done", completed: true, interrupted: false, inMonth: true });
    expect((await request(appFor("owner")).get(path).query({ month: "2020-10" })).body.issues).toEqual([]);
  });
});
