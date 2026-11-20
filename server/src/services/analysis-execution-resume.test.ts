import { afterAll, beforeAll, describe, it, expect } from "vitest";
import { createDb } from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "../__tests__/helpers/embedded-postgres.js";
import { runAnalysisResumeRegressions } from "../__tests__/helpers/analysis-resume-regressions.js";
const support=await getEmbeddedPostgresTestSupport();
(support.supported?describe:describe.skip)("analysis stop, verified resume and truthful dispatch",()=>{
 let database:Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>,db:ReturnType<typeof createDb>;
 beforeAll(async()=>{database=await startEmbeddedPostgresTestDatabase("analysis-resume-");db=createDb(database.connectionString);});
 afterAll(async()=>{await db?.$client.end();await database?.cleanup();});
 it("preserves evidence, blocks unsafe resumes, and rejects phantom queued dispatches",async()=>{expect((await runAnalysisResumeRegressions(db)).length).toBe(16);});
});
