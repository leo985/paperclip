import { randomUUID, createHash } from "node:crypto";
import express from "express";
import request from "supertest";
import { afterAll, beforeAll, describe, it, expect, vi } from "vitest";
import { eq } from "drizzle-orm";
import {
  createDb,
  companies,
  companyMemberships,
  projects,
  agents,
  analysisExecutions,
  heartbeatRuns,
  seatExecutionPermits,
  type Db,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "../__tests__/helpers/embedded-postgres.js";
const wakes = vi.hoisted(() => ({ call: vi.fn(), cancel: vi.fn() }));
vi.mock("../services/heartbeat.js", () => ({
  heartbeatService: () => ({ wakeup: wakes.call, cancelRun: wakes.cancel }),
}));
import { analysisWaitScope } from "../services/analysis-executions.js";
import { analysisExecutionRoutes } from "./analysis-executions.js";
import { seatPermitService } from "../services/seat-execution-permits.js";
const support = await getEmbeddedPostgresTestSupport();
(support.supported ? describe : describe.skip)(
  "independent analysis authorized lifecycle",
  () => {
    let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>,
      db: Db;
    const cid = randomUUID(),
      pid = randomUUID(),
      sid = randomUUID(),
      mid = randomUUID(),
      fingerprint = "f".repeat(64),
      capid = "c".repeat(64),
      cap = {
        id: capid,
        kind: "analysis",
        root: "/isolated/analysis",
        repository: "git.example.com/analysis",
        profile: "dsp",
        commit: "a".repeat(40),
        manifestDigest: "b".repeat(64),
        roles: ["requirements-analysis"],
        protocolVersion: 1,
        validation: "local-files",
        executionReady: false,
        checkedAt: new Date().toISOString(),
      };
    const machine = {
        seat_id: sid,
        machine_id: mid,
        machine_fingerprint: fingerprint,
      },
      lease = randomUUID();
    function app(user = "local-board", role = "admin", agent = false) {
      const a = express();
      a.use(express.json());
      a.use((req, _res, next) => {
        req.actor = agent
          ? {
              type: "agent",
              source: "agent_key",
              agentId: sid,
              companyId: cid,
              companyIds: [cid],
            }
          : {
              type: "board",
              source: "session",
              userId: user,
              companyIds: [cid],
              memberships: [
                { companyId: cid, membershipRole: role, status: "active" },
              ],
            };
        next();
      });
      a.use(analysisExecutionRoutes(db));
      a.use((e: any, _req: any, res: any, _next: any) =>
        res.status(e.status ?? 500).json({ error: e.message }),
      );
      return a;
    }
    const url = `/companies/${cid}/analysis-executions`;
    beforeAll(async () => {
      vi.stubEnv("PAPERCLIP_DEPLOYMENT_MODE", "local_trusted");
      database = await startEmbeddedPostgresTestDatabase(
        "analysis-executions-",
      );
      db = createDb(database.connectionString);
      await db.insert(companies).values({
        id: cid,
        name: "Analysis Test",
        issuePrefix: "A" + cid.slice(0, 6),
      });
      await db.insert(companyMemberships).values({companyId:cid,principalType:"user",principalId:"local-board",membershipRole:"admin",status:"active"});
      await db
        .insert(projects)
        .values({ id: pid, companyId: cid, name: "Project" });
      await db.insert(agents).values({
        id: sid,
        companyId: cid,
        name: "Seat",
        role: "engineer",
        status: "idle",
        adapterType: "claude_local",
        adapterConfig: {
          dsp7Transport: "outbound",
          dsp7WebJiraIntake: true,
          dsp7Seat: {
            machineId: mid,
            machineFingerprint: fingerprint,
            ownerUserId: "local-board",
          },
          dsp7HarnessCapabilities: { version: 1, revision: 1, items: [cap] },
          dsp7SeatPresence: {
            lastSeenAt: new Date().toISOString(),
            state: "idle",
            acceptingWork: true,
            capabilities: ["analysis-execution-v1"],
          },
        },
      });
      wakes.call.mockImplementation(async (agentId, opts) => {
        const [r] = await db
          .insert(heartbeatRuns)
          .values({
            companyId: cid,
            agentId,
            status: "running",
            contextSnapshot: opts.contextSnapshot,
          })
          .returning();
        return r;
      });
    }, 30000);
    afterAll(async () => {
      await database?.cleanup();
      vi.unstubAllEnvs();
    });
    async function create() {
      const input = {
        requestId: randomUUID(),
        projectId: pid,
        seatId: sid,
        title: "Independent analysis",
        brief: "Analyze an isolated test requirement without Jira.",
      };
      const r = await request(app()).post(url).send(input);
      expect(r.status).toBe(201);
      return { execution: r.body, input };
    }
    it("uses the registered seat name and reflects later renames without changing identity", async () => {
      const [original] = await db.select().from(agents).where(eq(agents.id, sid));
      const seat = original.adapterConfig.dsp7Seat as Record<string, unknown>;
      try {
        for (const name of ["研发电脑", "已重命名的研发电脑", undefined]) {
          await db.update(agents).set({ adapterConfig: {
            ...original.adapterConfig, dsp7Seat: { ...seat, name },
          } }).where(eq(agents.id, sid));
          const response = await request(app()).get(url + "/seats");
          expect(response.status).toBe(200);
          expect(response.body).toEqual([expect.objectContaining({
            id: sid, name: name ?? original.name, capabilityId: capid,
          })]);
        }
        expect((await request(app("stranger", "member")).get(url + "/seats")).body).toEqual([]);
      } finally {
        await db.update(agents).set({ adapterConfig: original.adapterConfig }).where(eq(agents.id, sid));
      }
    });
    it("uses management heartbeat freshness rules for analysis seat availability", async () => {
      const [original] = await db.select().from(agents).where(eq(agents.id, sid));
      const presence = original.adapterConfig.dsp7SeatPresence as Record<string, unknown>;
      try {
        for (const [lastSeenAt, online] of [
          [new Date().toISOString(), true],
          [new Date(Date.now() - 120000).toISOString(), false],
          [new Date(Date.now() + 60000).toISOString(), false],
          ["invalid", false],
        ] as const) {
          await db.update(agents).set({ adapterConfig: {
            ...original.adapterConfig, dsp7SeatPresence: { ...presence, lastSeenAt },
          } }).where(eq(agents.id, sid));
          const response = await request(app()).get(url + "/seats");
          expect(response.status).toBe(200);
          expect(response.body[0].online).toBe(online);
        }
      } finally {
        await db.update(agents).set({ adapterConfig: original.adapterConfig }).where(eq(agents.id, sid));
      }
    });
    it("creates a non-running record idempotently and restricts management and project boundaries", async () => {
      const { execution, input } = await create();
      expect(execution.state).toBe("draft");
      expect(wakes.call).not.toHaveBeenCalled();
      expect((await request(app()).post(url).send(input)).body.id).toBe(
        execution.id,
      );
      expect(
        (
          await request(app())
            .post(url)
            .send({ ...input, title: "Different" })
        ).status,
      ).toBe(409);
      expect(
        (
          await request(app("member", "member"))
            .post(url)
            .send({ ...input, requestId: randomUUID() })
        ).status,
      ).toBe(403);
      expect(
        (
          await request(app())
            .post(url)
            .send({
              ...input,
              requestId: randomUUID(),
              projectId: randomUUID(),
            })
        ).status,
      ).toBe(400);
    });
    it("resolves task details without weakening analysis or company visibility", async () => {
      const { execution } = await create();
      const path = url + `/by-task/${execution.id}`;
      const response = await request(app()).get(path);
      expect(response.status).toBe(200);
      expect(response.headers["cache-control"]).toBe("no-store");
      expect(response.body.analysis.execution.id).toBe(execution.id);
      expect(response.body.analysis.decisions).toEqual([]);
      expect(response.body.analysis.run).toBeNull();
      const absent = await request(app()).get(url + `/by-task/${randomUUID()}`);
      expect(absent.status).toBe(200);
      expect(absent.body).toEqual({ analysis: null });
      expect((await request(app("unrelated-member", "member")).get(path)).status).toBe(404);
      expect((await request(app("local-board", "admin", true)).get(path)).status).toBe(403);
      expect((await request(app()).get(path.replace(cid, randomUUID()))).status).toBe(403);
      expect(wakes.call).not.toHaveBeenCalled();
    });
    it("runs questions, exact-version review delivery and explicit manual publication without Jira identity", async () => {
      const { execution: e } = await create();
      const dispatchId = randomUUID();
      const dispatch = await request(app())
        .post(url + `/${e.id}/dispatch`)
        .send({ requestId: dispatchId });
      expect(dispatch.status).toBe(200);
      const runId = dispatch.body.runId;
      expect(runId).toBeTruthy();
      expect(
        (
          await request(app())
            .post(url + `/${e.id}/dispatch`)
            .send({ requestId: randomUUID() })
        ).status,
      ).toBe(409);
      const [grant] = await db
        .select()
        .from(analysisExecutions)
        .where(eq(analysisExecutions.id, e.id));
      expect(grant.activeRunId).toBe(runId);
      await seatPermitService(db).issue(
        { companyId: cid, agentId: sid, runId, machineId: mid, lease },
        { kind: "analysis", supervisionProtocol: 2 },
      );
      const cb = `/agents/${sid}/analysis-runs/${runId}`,
        body = { ...machine, lease };
      const snapshot = {
        protocolVersion: 1,
        binding: {
          protocolVersion: 1,
          companyId: cid,
          taskId: e.id,
          revision: 1,
          nativeId: `pc-${e.id}-r1`,
          profile: "dsp",
          repository: cap.repository,
        },
        phase: "P2",
        nativeStatus: "in-progress",
        completedPhases: ["P0", "P1"],
        gateErrors: ["waiting for real decision"],
        localCompleted: false,
        formalPublication: "unverified",
      };
      expect(
        (
          await request(app("", "", true))
            .post(cb + "/observe")
            .send({ ...body, snapshot, waiting: true })
        ).status,
      ).toBe(200);
      expect(
        (
          await request(app("", "", true))
            .post(cb + "/observe")
            .send({ ...body, snapshot: { ...snapshot, localCompleted: true } })
        ).status,
      ).toBe(409);
      const q = {
        key: "Q1",
        kind: "question",
        text: "Which authorized test behavior?",
        inputDigest: "1".repeat(64),
        contentDigest: "2".repeat(64),
      };
      const questions = await request(app("", "", true))
        .post(cb + "/questions")
        .send({ ...body, questions: [q] });
      expect(questions.status).toBe(200);
      const d = questions.body.decisions[0];
      expect(
        await analysisWaitScope(
          db,
          cid,
          sid,
          e.id,
          `analysis:${runId}:fixture`,
        ),
      ).not.toBeNull();
      expect(
        await analysisWaitScope(db, cid, sid, e.id, "analysis:old-run:fixture"),
      ).toBeNull();
      expect(
        (await request(app("stranger", "member")).get(url + `/${e.id}`)).status,
      ).toBe(404);
      expect(
        (
          await request(app())
            .post(url + `/${e.id}/decisions/${d.id}/answer`)
            .send({
              answer: "Allowed only in isolation",
              contentDigest: "3".repeat(64),
            })
        ).status,
      ).toBe(409);
      expect(
        (
          await request(app())
            .post(url + `/${e.id}/decisions/${d.id}/answer`)
            .send({
              answer: "Allowed only in isolation",
              contentDigest: d.contentDigest,
            })
        ).status,
      ).toBe(200);
      expect(
        (
          await request(app("", "", true))
            .post(cb + "/ack")
            .send({
              ...body,
              decisionId: d.id,
              contentDigest: d.contentDigest,
              inputDigest: d.inputDigest,
            })
        ).status,
      ).toBe(200);
      expect(
        (
          await request(app("", "", true))
            .post(cb + "/ack")
            .send({
              ...body,
              decisionId: d.id,
              contentDigest: d.contentDigest,
              inputDigest: d.inputDigest,
            })
        ).status,
      ).toBe(200);
      const delivery = {
        ...snapshot,
        phase: "P4",
        nativeStatus: "completed",
        completedPhases: ["P0", "P1", "P2", "P3", "P4"],
        gateErrors: [],
        localCompleted: true,
        inputDigest: "a".repeat(64),
        handoffDigest: "b".repeat(64),
        artifacts: [
          "intake.md",
          "evidence.json",
          "requirements.json",
          "analysis.md",
          "review.json",
          "handoff.md",
          "state.json",
        ].map((path) => ({
          path,
          sha256: path === "handoff.md" ? "b".repeat(64) : "a".repeat(64),
        })),
      };
      expect(
        (
          await request(app("", "", true))
            .post(cb + "/delivery")
            .send({ ...body, delivery })
        ).status,
      ).toBe(409);
      expect(
        (
          await request(app("", "", true))
            .post(cb + "/observe")
            .send({
              ...body,
              snapshot: {
                ...snapshot,
                phase: "P3",
                completedPhases: ["P0", "P1", "P2"],
              },
              waiting: true,
            })
        ).status,
      ).toBe(200);
      const rq = {
        key: "P3-review",
        kind: "review",
        text: "Review exact input",
        inputDigest: delivery.inputDigest,
        contentDigest: "4".repeat(64),
      };
      const rqs = await request(app("", "", true))
        .post(cb + "/questions")
        .send({ ...body, questions: [rq] });
      const rd = rqs.body.decisions[0];
      expect((await request(app()).post(url + `/${e.id}/decisions/${rd.id}/answer`)
        .send({ answer: "approve", contentDigest: rd.contentDigest })).status).toBe(409);
      const documents = ["intake.md", "requirements.json", "analysis.md"].map(path => ({path,content:"review text",sha256:createHash("sha256").update("review text").digest("hex")}));
      expect((await request(app("", "", true)).post(cb + "/observe").send({...body,snapshot:{...snapshot,phase:"P3",completedPhases:["P0","P1","P2"],reviewMaterials:{runId,inputDigest:delivery.inputDigest,capturedAt:new Date().toISOString(),documents,evidenceSha256:"a".repeat(64),evidence:[]}},waiting:true})).status).toBe(200);
      expect(
        (
          await request(app())
            .post(url + `/${e.id}/decisions/${rd.id}/answer`)
            .send({ answer: "approve", contentDigest: rd.contentDigest })
        ).status,
      ).toBe(200);
      expect(
        (
          await request(app("", "", true))
            .post(cb + "/ack")
            .send({
              ...body,
              decisionId: rd.id,
              contentDigest: rd.contentDigest,
              inputDigest: rd.inputDigest,
            })
        ).status,
      ).toBe(200);
      expect(
        (
          await request(app("", "", true))
            .post(cb + "/delivery")
            .send({
              ...body,
              delivery: { ...delivery, gateErrors: ["P3 stale"] },
            })
        ).status,
      ).toBe(409);
      await db.update(analysisExecutions).set({ demandNo: "ATS3-00156" }).where(eq(analysisExecutions.id, e.id));
      expect(
        (
          await request(app("", "", true))
            .post(cb + "/delivery")
            .send({ ...body, delivery })
        ).status,
      ).toBe(200);
      expect(
        (
          await request(app("", "", true))
            .post(cb + "/questions")
            .send({ ...body, questions: [] })
        ).status,
      ).toBe(409);
      const detail = await request(app()).get(url + `/${e.id}`);
      expect(detail.body.execution.state).toBe("local_completed");
      expect(detail.body.execution.publication).toBeNull();
      expect((await request(app("","",true)).post(cb+"/delivery").send({...body,delivery})).status).toBe(200);
      expect(detail.body.execution.qingzhouWriteback).toMatchObject({status:"failed",error:expect.stringContaining("未上传分析正文")});
      expect((await request(app("member","member")).post(url+`/${e.id}/qingzhou-writeback`).send({})).status).toBe(403);
      expect((await request(app()).post(url+`/${e.id}/qingzhou-writeback`).send({options:{workHour:"0"}})).status).toBe(400);
      const text = "# Approved analysis\n\nExact version result.";
      const enriched = { ...delivery, analysisMarkdown: text, artifacts: delivery.artifacts.map(a => a.path === "analysis.md" ? { ...a, sha256: createHash("sha256").update(text).digest("hex") } : a) };
      // Frozen manifests cannot be replaced to smuggle different content in a retry.
      expect((await request(app("","",true)).post(cb+"/delivery").send({...body,delivery:enriched})).status).toBe(409);
      expect(detail.body.decisions[0].status).toBe("delivered");
      const pub = {
        inputDigest: delivery.inputDigest,
        handoffDigest: delivery.handoffDigest,
        url: "http://jira.fingard.com:6001/browse/TEST-1",
        note: "Isolated fixture of an explicit human verification, no external write.",
        attest: true,
      };
      expect(
        (
          await request(app())
            .post(url + `/${e.id}/publication`)
            .send({ ...pub, url: "https://evil.invalid/" })
        ).status,
      ).toBe(400);
      expect(
        (
          await request(app())
            .post(url + `/${e.id}/publication`)
            .send(pub)
        ).body.automaticReadback,
      ).toBe(false);
      expect(
        (await request(app()).get(url + `/${e.id}`)).body.execution.publication
          .method,
      ).toBe("manual-attestation");
    });
  },
);
