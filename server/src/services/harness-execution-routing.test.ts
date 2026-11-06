import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { budgetPolicies, companies, createDb, type agents } from "@paperclipai/db";
import { assertNewDomainMetering, resolveHarnessRoute, sameHarnessRoute } from "./harness-execution-routing.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "../__tests__/helpers/embedded-postgres.js";
const cap=(id:string,kind:"analysis"|"development"|"qa")=>({id,kind,repository:`git.example/${id}`,root:`/local/${id}`,profile:"default",commit:"a".repeat(40),manifestDigest:"b".repeat(64),roles:kind==="analysis"?["requirements-analysis"]:kind==="qa"?["functional-test"]:["coding"],protocolVersion:1,validation:"local-files",executionReady:false,checkedAt:new Date().toISOString()});
const agent=(items:unknown[],routing?:Record<string,string>)=>({id:randomUUID(),companyId:randomUUID(),adapterConfig:{dsp7Seat:{machineId:randomUUID()},dsp7HarnessCapabilities:{version:1,revision:3,items,routing}}}) as unknown as typeof agents.$inferSelect;
describe("machine-bound domain routing",()=>{
 it("selects the exact domain without falling back to development",()=>{
  const a=agent([cap("dev","development"),cap("analysis","analysis"),cap("qa","qa")]);
  const route=resolveHarnessRoute(a,{runId:randomUUID(),taskId:randomUUID(),kind:"analysis",required:true})!;
  expect(route.capability.kind).toBe("analysis");expect(route.machineId).toBe((a.adapterConfig.dsp7Seat as any).machineId);
  expect(sameHarnessRoute(route,JSON.parse(JSON.stringify(route)))).toBe(true);
  expect(sameHarnessRoute(route,{...route,registryRevision:4})).toBe(false);
  expect(()=>resolveHarnessRoute(agent([cap("dev","development")]),{runId:randomUUID(),taskId:randomUUID(),kind:"qa",required:true})).toThrow("唯一");
 });
 it("requires an explicit selection when several domain capabilities are registered",()=>{
  const a=agent([cap("a","analysis"),cap("b","analysis")]);const input={runId:randomUUID(),taskId:randomUUID(),kind:"analysis" as const,required:true};
  expect(()=>resolveHarnessRoute(a,input)).toThrow("唯一");
  (a.adapterConfig.dsp7HarnessCapabilities as any).routing={analysis:"b"};expect(resolveHarnessRoute(a,input)!.capabilityId).toBe("b");
  expect(resolveHarnessRoute(agent([]),{...input,kind:"development",required:false})).toBeNull();
 });
});
const support=await getEmbeddedPostgresTestSupport();
(support.supported?describe:describe.skip)("new domain unpriced hard-budget gate",()=>{
 let database:Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>,db:ReturnType<typeof createDb>;
 beforeAll(async()=>{database=await startEmbeddedPostgresTestDatabase("domain-metering-");db=createDb(database.connectionString);});afterAll(async()=>{await database?.cleanup();});
 it("blocks only applicable active positive hard policies; zero and soft remain unchanged",async()=>{
  const companyId=randomUUID(),agentId=randomUUID(),projectId=randomUUID();await db.insert(companies).values({id:companyId,name:"Metering",issuePrefix:`M${companyId.slice(0,6)}`});
  await db.insert(budgetPolicies).values([{companyId,scopeType:"company",scopeId:companyId,windowKind:"lifetime",amount:0},{companyId,scopeType:"agent",scopeId:agentId,windowKind:"lifetime",amount:1,hardStopEnabled:false},{companyId,scopeType:"project",scopeId:randomUUID(),windowKind:"lifetime",amount:1}]);
  await expect(assertNewDomainMetering(db,companyId,agentId,projectId)).resolves.toBeUndefined();
  await db.insert(budgetPolicies).values({companyId,scopeType:"project",scopeId:projectId,windowKind:"lifetime",amount:1});
  await expect(assertNewDomainMetering(db,companyId,agentId,projectId)).rejects.toThrow("实际价格");
 });
});
