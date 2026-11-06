import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { agentRuntimeState, agents, companies, costEvents, createDb, heartbeatRuns, issues, runUsageCheckpoints } from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "../__tests__/helpers/embedded-postgres.js";
import { acceptSeatUsageCheckpoint } from "./seat-usage-checkpoints.js";
import { acceptSeatFinalUsage } from "./seat-final-usage.js";
import { seatPermitService } from "./seat-execution-permits.js";
import { accountFinalRunUsage } from "./run-usage-accounting.js";
const support = await getEmbeddedPostgresTestSupport();
(support.supported ? describe : describe.skip)("cumulative seat usage reconciliation", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>, db: ReturnType<typeof createDb>;
  beforeAll(async () => { database = await startEmbeddedPostgresTestDatabase("seat-cumulative-");db=createDb(database.connectionString); });
  afterAll(async () => { await database?.cleanup(); });
  async function seed() {
    const companyId=randomUUID(),agentId=randomUUID(),runId=randomUUID(),taskId=randomUUID(),machineId=randomUUID();
    await db.insert(companies).values({id:companyId,name:"Usage",issuePrefix:`C${companyId.slice(0,6)}`});
    await db.insert(agents).values({id:agentId,companyId,name:"Seat",role:"engineer",adapterType:"claude_local",status:"idle",adapterConfig:{dsp7Transport:"outbound",dsp7Seat:{machineId}}});
    await db.insert(issues).values({id:taskId,companyId,title:"Task",assigneeAgentId:agentId,status:"in_progress"});
    await db.insert(heartbeatRuns).values({id:runId,companyId,agentId,status:"running",contextSnapshot:{issueId:taskId}});
    const identity={companyId,agentId,runId,machineId,lease:randomUUID()};await seatPermitService(db).issue(identity);
    const observedAt=new Date().toISOString();
    return {identity, observation:{sequence:1,model:"claude",observedAt,usage:{inputTokens:100,outputTokens:10,cachedInputTokens:20}}};
  }
  it("accounts only deltas and serializes checkpoints with final/deferred settlement",async()=>{
    const {identity:i,observation:o}=await seed();
    await Promise.all([acceptSeatUsageCheckpoint(db,i,o),acceptSeatUsageCheckpoint(db,i,o)]);
    const second={...o,sequence:2,usage:{inputTokens:150,outputTokens:30,cachedInputTokens:25}};
    await acceptSeatUsageCheckpoint(db,i,second);
    const finishedAt=new Date();await db.update(heartbeatRuns).set({status:"cancelled",finishedAt}).where(eq(heartbeatRuns.id,i.runId));
    const final={model:"claude",usage:{inputTokens:200,outputTokens:40,cachedInputTokens:30}};
    await Promise.all([acceptSeatFinalUsage(db,i,final),accountFinalRunUsage(db,i.companyId,{heartbeatRunId:i.runId,agentId:i.agentId,issueId:(await db.select().from(runUsageCheckpoints).where(eq(runUsageCheckpoints.runId,i.runId)))[0]!.scope.issueId,projectId:null,billingCode:null,provider:"unknown",biller:"unknown",billingType:"unknown",costStatus:"unpriced",model:"claude",...final.usage,costCents:0,occurredAt:finishedAt})]);
    await acceptSeatUsageCheckpoint(db,i,o);await acceptSeatFinalUsage(db,i,final);
    const ledger=await db.select().from(costEvents).where(eq(costEvents.heartbeatRunId,i.runId));
    expect(ledger.reduce((s,r)=>s+r.inputTokens,0)).toBe(200);expect(ledger).toHaveLength(3);
    const [runtime]=await db.select().from(agentRuntimeState).where(eq(agentRuntimeState.agentId,i.agentId));expect(runtime).toMatchObject({totalInputTokens:200,totalOutputTokens:40,totalCachedInputTokens:30,totalCostCents:0});
    expect((await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id,i.runId)))[0]!.usageJson?.seatMetering).toMatchObject({status:"final_reported",costStatus:"unpriced"});
  });
  it("rejects changed historical receipts, regressions, wrong identity and invalid observation time",async()=>{
    const {identity:i,observation:o}=await seed();await acceptSeatUsageCheckpoint(db,i,o);
    await acceptSeatUsageCheckpoint(db,i,{...o,sequence:2,usage:{...o.usage,inputTokens:200}});
    await expect(acceptSeatUsageCheckpoint(db,i,{...o,usage:{...o.usage,inputTokens:101}})).rejects.toThrow("内容发生变化");
    await expect(acceptSeatUsageCheckpoint(db,i,{...o,sequence:3})).rejects.toThrow("不能倒退");
    await expect(acceptSeatUsageCheckpoint(db,{...i,lease:randomUUID()},o)).rejects.toThrow("身份不匹配");
    await expect(acceptSeatUsageCheckpoint(db,i,{...o,observedAt:"2020-01-01T00:00:00Z"})).rejects.toThrow("观测时间");
  });
  it("retains known partial usage after interruption without inventing a final receipt",async()=>{
    const {identity:i,observation:o}=await seed();await acceptSeatUsageCheckpoint(db,i,o);
    await db.update(heartbeatRuns).set({status:"failed",finishedAt:new Date()}).where(eq(heartbeatRuns.id,i.runId));
    await expect(acceptSeatFinalUsage(db,i,{model:"claude",usage:{inputTokens:0,outputTokens:0}})).rejects.toThrow("最终用量小于");
    const [state]=await db.select().from(runUsageCheckpoints).where(eq(runUsageCheckpoints.runId,i.runId));expect(state!.finalDigest).toBeNull();expect(state!.inputTokens).toBe(100);
  });
});
