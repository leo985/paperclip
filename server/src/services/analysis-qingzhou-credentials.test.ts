import { describe, expect, it, vi, beforeEach } from "vitest";
const deps=vi.hoisted(()=>({resolve:vi.fn()}));
vi.mock("./seat-qingzhou.js",()=>({seatQingzhouLock:()=>"lock",resolveSeatQingzhouCredentials:deps.resolve}));
import { analysisQingzhouCredentials } from "./analysis-qingzhou-credentials.js";
const scope={task:{id:"task",companyId:"company",seatId:"seat",demandNo:"TWGF-00919",delivery:null,publication:null},run:{id:"run"}};
function fixture(account:any){const writes:any[]=[];const query:any={from:()=>query,where:()=>query,for:async()=>account?[account]:[]};const db:any={execute:vi.fn(),select:()=>query,insert:()=>({values:async(v:any)=>writes.push(v)})};return {db,writes};}
beforeEach(()=>deps.resolve.mockReset());
describe("analysis client collection authentication",()=>{
 it("resolves only the bound account and audits metadata without storing credentials",async()=>{
  const account={companyId:"company",seatId:"seat",credentialSecretId:"secret",revision:3};const f=fixture(account);deps.resolve.mockResolvedValue({username:"u",password:"private"});
  const result=await analysisQingzhouCredentials(f.db,scope);expect(result).toMatchObject({demandNo:"TWGF-00919",seatAccountRevision:3,credentials:{password:"private"}});
  expect(deps.resolve).toHaveBeenCalledWith(f.db,"company",account);expect(JSON.stringify(f.writes)).not.toContain("private");expect(f.writes[0].details).toMatchObject({runId:"run",collectionLocation:"client"});
 });
 it("does not borrow credentials when the seat has none",async()=>{const f=fixture(null);await expect(analysisQingzhouCredentials(f.db,scope)).rejects.toThrow("配置轻舟账号");expect(deps.resolve).not.toHaveBeenCalled();expect(f.writes).toEqual([]);});
 it("rejects absent demand or frozen delivery before resolving secrets",async()=>{
  for(const patch of [{demandNo:null},{delivery:{}},{publication:{}}]){const f=fixture({});await expect(analysisQingzhouCredentials(f.db,{...scope,task:{...scope.task,...patch}})).rejects.toThrow();expect(deps.resolve).not.toHaveBeenCalled();}
 });
});
