import express from "express";
import request from "supertest";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Db, agents } from "@paperclipai/db";
import { dispatchAuthorization, dsp7JiraDispatchRoutes } from "./dsp7-jira-dispatch.js";

vi.mock("../services/secrets.js", () => ({ secretService: () => ({ resolveSecretValue: async () => "fixture-token" }) }));
const seatId="22222222-2222-4222-8222-222222222222", projectId="33333333-3333-4333-8333-333333333333", workspaceId="44444444-4444-4444-8444-444444444444";
const rule={enabled:true,jiraAssignee:"zhangzl",jiraProjectKey:"ATSES",projectId,workspaceId,readyStatuses:["修复中"],issueTypes:["线上问题"],jiraSecretId:"secret",jiraBaseUrl:"http://jira.fingard.com:6001",ownerUserId:"owner"};
const agent={id:seatId,companyId:"company",adapterConfig:{dsp7JiraDispatch:rule}} as unknown as typeof agents.$inferSelect;
function app() {
  const app=express();app.use(express.json());app.use((req,_res,next)=>{Object.assign(req,{actor:{type:"board",userId:"admin"}});next();});
  app.use(dsp7JiraDispatchRoutes({} as Db,async()=>agent,async()=>agent));
  app.use((error:any,_req:any,res:any,_next:any)=>res.status(error.status??500).json({error:error.message}));return app;
}
afterEach(()=>vi.unstubAllGlobals());
describe("Jira assignee is source metadata, not executor authorization",()=>{
  it("previews another assignee's work on the explicitly chosen seat",async()=>{
    vi.stubGlobal("fetch",vi.fn(async()=>new Response(JSON.stringify({fields:{summary:"fixture",status:{name:"修复中",statusCategory:{key:"indeterminate"}},issuetype:{name:"线上问题"},assignee:{name:"chenjj1708"}}}))));
    const response=await request(app()).post(`/companies/company/dsp7-seats/${seatId}/jira-dispatch/intake-preview`).send({jiraKey:"ATSES-513404",projectId,workspaceId});
    expect(response.status).toBe(200);expect(response.body.summary).toBe("fixture");
  });
  it.each([
    {status:{name:"未允许状态"},issuetype:{name:"线上问题"}},
    {status:{name:"修复中",statusCategory:{key:"done"}},issuetype:{name:"线上问题"}},
    {status:{name:"修复中"},issuetype:{name:"其他类型"}},
  ])("keeps Jira status, completion and type admission gates",async fields=>{
    vi.stubGlobal("fetch",vi.fn(async()=>new Response(JSON.stringify({fields:{...fields,assignee:{name:"chenjj1708"}}}))));
    expect((await request(app()).post(`/companies/company/dsp7-seats/${seatId}/jira-dispatch/intake-preview`).send({jiraKey:"ATSES-513404",projectId,workspaceId})).status).toBe(409);
  });
  it("keeps monitoring an already active discovered run after reassignment",async()=>{
    const intake={seat_id:seatId,project_id:projectId,workspace_id:workspaceId,jira_key:"ATSES-513404",ready_status:"修复中"};
    const raw=JSON.stringify(intake);
    const record={details:{request:raw,ownerUserId:"owner",assignee:"chenjj1708",issueType:"线上问题",jiraKey:intake.jira_key}};
    const chain:any={then:(yes:any,no:any)=>Promise.resolve([record]).then(yes,no)};
    for(const key of ["from","where","limit"])chain[key]=()=>chain;
    const db={select:()=>chain} as unknown as Db;
    const task={id:"task",status:"in_progress",createdByAgentId:seatId,description:`<!-- DSP7-JIRA-INTAKE ${raw} -->`} as any;
    expect(await dispatchAuthorization(db,agent,task)).toEqual(rule);
    await expect(dispatchAuthorization(db,agent,{...task,status:"backlog"})).rejects.toMatchObject({status:403});
  });
});
