import express from "express";
import request from "supertest";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Db, agents } from "@paperclipai/db";
const mocks = vi.hoisted(() => ({ update: vi.fn(), create: vi.fn() }));
vi.mock("../services/issues.js", () => ({ issueService: () => mocks }));
vi.mock("../services/secrets.js", () => ({ secretService: () => ({ resolveSecretValue: async () => "private-test-token" }) }));
vi.mock("./dsp7-seat-owners.js", () => ({ seatOwnerId: (seat: { ownerUserId?: string }) => seat?.ownerUserId, isSeatManager: () => true, canCreateSeatIntake: async () => true }));
import { jiraRequirementRoutes } from "./jira-requirements.js";
import { platformAuthorization } from "./dsp7-jira-dispatch.js";
const companyId="11111111-1111-4111-8111-111111111111", seatId="22222222-2222-4222-8222-222222222222", projectId="33333333-3333-4333-8333-333333333333", taskId="44444444-4444-4444-8444-444444444444";
const agent = { id:seatId, companyId, status:"idle", adapterConfig:{dsp7Seat:{ownerUserId:"developer"},dsp7JiraDispatch:{jiraBaseUrl:"http://jira.fingard.com:6001",jiraSecretId:"secret",jiraProjectKey:"ATSES",jiraAssignee:"dev",projectId,workspaceId:projectId,readyStatuses:["待受理"],issueTypes:["编码"]}} } as unknown as typeof agents.$inferSelect;
function fixture(results: unknown[][], denied=false) {
  const events: unknown[]=[];
  const db={ select:()=>{if(!results.length)throw Error("unexpected query");const value=results.shift();const chain:Record<string,unknown>={then:(resolve:(v:unknown)=>unknown,reject:(e:unknown)=>unknown)=>Promise.resolve(value).then(resolve,reject)};for(const name of ["from","where","innerJoin","orderBy","limit","for"])chain[name]=()=>chain;return chain;}, execute:async()=>{}, insert:()=>({values:async(value:unknown)=>{events.push(value);}}), transaction:async(fn:(db:unknown)=>unknown)=>fn(db) };
  const app=express();app.use(express.json());app.use((req,_res,next)=>{Object.assign(req,{actor:{type:"board",userId:"admin"}});next();});
  app.use(jiraRequirementRoutes(db as unknown as Db,async()=>{if(denied)throw Object.assign(Error("denied"),{status:403});return agent;}));
  app.use((error:Error & {status?:number},_req:express.Request,res:express.Response,_next:express.NextFunction)=>{res.status(error.status??500).json({error:error.message});});
  return {app,events,db:db as unknown as Db};
}
function jira(type="编码", assignee="dev") {
  vi.stubGlobal("fetch",vi.fn(async(url:string)=>new Response(JSON.stringify(url.includes("/search?")?{total:1,issues:[{key:"ATSES-2",fields:{parent:{key:"ATSES-1"},summary:"child",issuetype:{subtask:true,name:type},status:{name:"待受理",statusCategory:{key:"new"}},assignee:{name:assignee,emailAddress:assignee+"@example.com"}}}]}:{key:"ATSES-1",fields:{issuetype:{subtask:false},subtasks:[{key:"ATSES-2"}],customfield_14702:{name:"rd",emailAddress:"rd@example.com"}}}))));
}
const memberships=[{id:"developer",name:"dev",email:"dev@example.com"},{id:"rd-owner",name:"rd",email:"rd@example.com"}];
afterEach(()=>{vi.unstubAllGlobals();vi.clearAllMocks();});
describe("requirement intake and preparation",()=>{
  const base=`/companies/${companyId}/dsp7-seats/${seatId}/jira-requirements`;
  it("enforces seat authorization before Jira access",async()=>{
    const {app,events}=fixture([],true);const fetcher=vi.fn();vi.stubGlobal("fetch",fetcher);
    expect((await request(app).post(base+"/preview").send({jiraKey:"ATSES-1",projectId})).status).toBe(403);
    expect(fetcher).not.toHaveBeenCalled();expect(events).toEqual([]);
  });
  it("previews without dispatching or leaking PAT",async()=>{
    jira();const {app,events}=fixture([[{id:projectId}],memberships,[],[agent]]);
    const response=await request(app).post(base+"/preview").send({jiraKey:"ATSES-1",projectId});
    expect(response.status).toBe(200);expect(response.body.ownerUserId).toBe("rd-owner");expect(response.body.children[0].seats[0].id).toBe(seatId);
    expect(JSON.stringify(response.body)).not.toContain("private-test-token");expect(events).toEqual([]);
  });
  it("rejects changed snapshots before writes",async()=>{
    jira();const {app,events}=fixture([memberships,[],[agent]]);
    expect((await request(app).post(base+"/import").send({jiraKey:"ATSES-1",projectId,fingerprint:"0".repeat(64)})).status).toBe(409);
    expect(mocks.create).not.toHaveBeenCalled();expect(events).toEqual([]);
  });
  it("never prepares linked code review as another execution",async()=>{
    jira("代码评审");const {app,events}=fixture([[{id:taskId,parentId:"root",originId:"http://jira.fingard.com:6001:ATSES-2"}],[{details:{jiraKey:"ATSES-1"}}],memberships,[],[agent]]);
    expect((await request(app).post(base+"/prepare").send({taskId})).status).toBe(409);
    expect(mocks.update).not.toHaveBeenCalled();expect(events).toEqual([]);
  });
  it("leaves dev intake unassigned for the reservation worker",async()=>{
    jira();const task={id:taskId,companyId,parentId:"root",projectId,originId:"http://jira.fingard.com:6001:ATSES-2",description:"keep evidence",status:"backlog",createdByUserId:"admin",assigneeUserId:"developer"};
    mocks.update.mockResolvedValue({...task,assigneeUserId:null});
    const {app,events}=fixture([[task],[{details:{jiraKey:"ATSES-1"}}],memberships,[],[agent],[agent],[task],[]]);
    const response=await request(app).post(base+"/prepare").send({taskId});
    expect(response.body).toEqual(expect.objectContaining({taskId}));expect(response.status).toBe(200);
    expect(mocks.update.mock.calls[0][1]).toMatchObject({status:"backlog",assigneeUserId:null,assigneeAgentId:null,title:"Jira 接入申请：ATSES-2 child"});
    expect(mocks.update.mock.calls[0][1].description).toContain("keep evidence");expect(events).toMatchObject([{details:{dispatchGranted:false}}]);
  });
  it("prepares an authorized seat independently of the Jira assignee and personnel mapping",async()=>{
    jira("编码","another-person");
    const task={id:taskId,companyId,parentId:"root",projectId,originId:"http://jira.fingard.com:6001:ATSES-2",description:"keep evidence",status:"backlog",createdByUserId:"admin"};
    mocks.update.mockResolvedValue({...task,assigneeUserId:null});
    const {app}=fixture([[task],[{details:{jiraKey:"ATSES-1"}}],memberships,[],[agent],[agent],[task],[]]);
    const response=await request(app).post(base+"/prepare").send({taskId});
    expect(response.status).toBe(200);
    expect(mocks.update.mock.calls[0][1]).toMatchObject({assigneeUserId:null,assigneeAgentId:null,status:"backlog"});
  });
  it("imports a human-owned root and distinct children without granting execution",async()=>{
    jira();const {app}=fixture([[{id:projectId}],memberships,[],[agent]]);
    const preview=await request(app).post(base+"/preview").send({jiraKey:"ATSES-1",projectId});
    const imported=fixture([memberships,[],[agent],[{id:projectId}],[],[]]);
    mocks.create.mockResolvedValueOnce({id:"root"}).mockResolvedValueOnce({id:taskId});
    const response=await request(imported.app).post(base+"/import").send({jiraKey:"ATSES-1",projectId,fingerprint:preview.body.fingerprint});
    expect(response.status).toBe(200);expect(response.body).toEqual({taskId:"root",existing:false});
    expect(mocks.create.mock.calls[0][1]).toMatchObject({assigneeUserId:"rd-owner",status:"backlog"});
    expect(mocks.create.mock.calls[1][1]).toMatchObject({parentId:"root",assigneeUserId:"developer",status:"backlog"});
    for(const call of mocks.create.mock.calls)expect(call[1].assigneeAgentId).toBeUndefined();
    expect(imported.events).toMatchObject([{details:{dispatchGranted:false,children:[{key:"ATSES-2",mode:"development"}]}}]);
  });
  it("returns an existing import without overwriting its task state",async()=>{
    jira();const previewFixture=fixture([[{id:projectId}],memberships,[],[agent]]);
    const preview=await request(previewFixture.app).post(base+"/preview").send({jiraKey:"ATSES-1",projectId});
    const {app,events}=fixture([memberships,[],[agent],[{id:projectId}],[{id:"root",projectId}],[{id:"import-record"}]]);
    const response=await request(app).post(base+"/import").send({jiraKey:"ATSES-1",projectId,fingerprint:preview.body.fingerprint});
    expect(response.body).toEqual({taskId:"root",existing:true});expect(mocks.create).not.toHaveBeenCalled();expect(events).toEqual([]);
  });

  it.each(["harness-linked", "human-review", "qa"])("enforces audited %s role even if editable metadata claims development",async(mode)=>{
    const {db}=fixture([[{details:{children:[{key:"ATSES-2",mode,originId:"http://jira.fingard.com:6001:ATSES-2"}]}}]]);
    const intake={version:3,status_source:"seat_rule",seat_id:seatId,project_id:projectId,jira_key:"ATSES-2"};
    const task={id:taskId,companyId,parentId:"root",projectId,createdByUserId:"admin",description:'<!-- DSP7-JIRA-INTAKE '+JSON.stringify(intake)+' -->\n<!-- DSP7-REQUIREMENT {"mode":"development"} -->'};
    await expect(platformAuthorization(db,agent,task as Parameters<typeof platformAuthorization>[2])).rejects.toMatchObject({status:403});
  });

});
