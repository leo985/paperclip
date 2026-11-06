import { afterEach, describe, expect, it, vi } from "vitest";
import type { Db, agents } from "@paperclipai/db";
vi.mock("./dsp7-seat-owners.js", () => ({ canConfigureSeat: () => true, seatOwnerId: (seat:any) => seat?.ownerUserId ?? null }));
vi.mock("./dsp7-jira-dispatch.js", () => ({ dispatchAuthorization: vi.fn() }));
vi.mock("../services/secrets.js", () => ({ secretService: () => ({ resolveSecretValue: async (_company:string,id:string) => id==="group-secret"?JSON.stringify({webhookUrl:"https://oapi.dingtalk.com/robot/send?access_token=fixture-group-token",signingSecret:"SEC0123456789abcdef"}):"fixture-secret" }) }));
const analysis=vi.hoisted(()=>({wait:vi.fn()}));
const delivery=vi.hoisted(()=>({wait:vi.fn()}));
vi.mock("../services/delivery-workflows.js",()=>({deliveryWaitScope:delivery.wait}));
vi.mock("../services/analysis-executions.js",()=>({analysisWaitScope:analysis.wait}));
import { PgDialect } from "drizzle-orm/pg-core";
import { notifySeatBot, validateSeatBotTarget, validateSeatGroupTarget } from "./dsp7-seat-bots.js";

const agent = { id: "seat", companyId: "company" } as typeof agents.$inferSelect;
const alert = { id: "run:native:question:tool", taskId: "task", message: "等待人工处理", elapsedMinutes: 30, level: "urgent" };
const policy = { jiraKeys: ["ATSES-1"], reminderMinutes: 10, escalationMinutes: 30, dingtalk: { botId: "bot", userId: "owner" } };
const task = { id: "task", assigneeAgentId: "seat", description: "DSP7-PILOT:ATSES-1" };
const bot = { entityId: "bot", details: { id: "bot", name: "Fixture bot", enabled: true, corpId: "corp", appKey: "app", secretId: "secret", robotCode: "configured-robot" } };
function fixture(results: unknown[][]) {
  const predicates: Array<ReturnType<PgDialect["sqlToQuery"]>>=[];
  const events: Array<{details: Record<string, unknown>}> = [];
  const db = {
    select: vi.fn(() => {
      if (!results.length) throw new Error("Unexpected database query");
      const value = results.shift();
      const chain: Record<string, unknown> = { then: (ok: (v: unknown) => unknown, no: (v: unknown) => unknown) => Promise.resolve(value).then(ok, no) };
      for (const name of ["from", "where", "innerJoin", "orderBy", "limit"]) chain[name] = () => chain;
      chain.where=(condition:any)=>{predicates.push(new PgDialect().sqlToQuery(condition));return chain;};
      return chain;
    }),
    insert: () => ({ values: async (event: typeof events[number]) => {events.push(event);} }),
    execute: async () => {},
    transaction: async (run: (tx: unknown) => unknown) => run(db),
  };
  return { db: db as unknown as Db, events, predicates };
}
afterEach(() => {vi.unstubAllGlobals();analysis.wait.mockReset();delivery.wait.mockReset();});
describe("seat notification delivery orchestration", () => {
  it.each([{botId:"foreign-bot",corpId:"corp",enabled:true},{botId:"bot",corpId:"corp",enabled:false},{botId:"bot",corpId:"other-corp",enabled:true}])("rejects wrong-bot or disabled group targets before identity lookup", async fields => {
    const {db}=fixture([[{entityId:"group",details:{id:"group",...fields}}]]);
    await expect(validateSeatGroupTarget(db,agent,{botId:"bot",userId:"owner",groupId:"group"},bot.details)).rejects.toThrow("通知群不存在");
  });
  it("does not resend reserved personal and group buckets after an uncertain result", async () => {
    const {db,events}=fixture([[task],[{id:"personal-reserved"}],[{id:"group-reserved"}]]);
    const fetcher=vi.fn();vi.stubGlobal("fetch",fetcher);
    await notifySeatBot(db,agent,{...policy,dingtalk:{...policy.dingtalk,groupId:"group"}},[{...alert,elapsedMinutes:0}]);
    expect(fetcher).not.toHaveBeenCalled();expect(events).toEqual([]);
  });
  it("sends personal and group messages separately, mentioning the actual seat owner", async () => {
    const groupPolicy={...policy,dingtalk:{...policy.dingtalk,groupId:"group"}};
    const current={...agent,name:"研发电脑",adapterConfig:{dsp7Seat:{ownerUserId:"platform-owner"},dsp7SeatPolicy:groupPolicy,dsp7SeatPresence:{lastSeenAt:new Date().toISOString(),alerts:[alert]}}};
    const group={entityId:"group",details:{id:"group",botId:"bot",corpId:"corp",enabled:true,name:"研发群",secretId:"group-secret"}};
    const {db,events,predicates}=fixture([[task],[],[bot],[{id:"dm-person"}],[{prefix:"DSP"}],[],[bot],[{id:"dm-person"}],[current],[task],[group],[{externalId:"actual-seat-owner",name:"负责人"}],[{prefix:"DSP"}]]);
    const fetcher=vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({accessToken:"token"})))
      .mockResolvedValueOnce(new Response(JSON.stringify({processQueryKey:"dm-receipt"})))
      .mockResolvedValueOnce(new Response(JSON.stringify({errcode:0})));
    vi.stubGlobal("fetch",fetcher);
    await notifySeatBot(db,agent,groupPolicy,[{...alert,elapsedMinutes:0}]);
    expect(fetcher).toHaveBeenCalledTimes(3);
    const body=JSON.parse(fetcher.mock.calls[2][1].body);
    expect(body.at).toEqual({atUserIds:["actual-seat-owner"],isAtAll:false});
    expect(body.text.content).toContain("@actual-seat-owner");
    expect(body.at.atUserIds).not.toContain("owner");
    expect(events.filter(e=>e.details.status==="submitted").map(e=>e.details.channel)).toEqual(["message","group"]);
    expect(events.at(-1)?.details).toMatchObject({groupId:"group",groupName:"研发群",mentionedUserId:"actual-seat-owner"});
    expect(predicates.some(p=>p.params.includes("platform-owner")&&p.params.includes("corp"))).toBe(true);
    expect(JSON.stringify(events)).not.toMatch(/fixture-group-token|SEC0123456789abcdef/);
  });
  it("keeps group delivery available after personal send failure", async () => {
    const groupPolicy={...policy,dingtalk:{...policy.dingtalk,groupId:"group"}};
    const current={...agent,name:"研发电脑",adapterConfig:{dsp7Seat:{ownerUserId:"platform-owner"},dsp7SeatPolicy:groupPolicy,dsp7SeatPresence:{lastSeenAt:new Date().toISOString(),alerts:[alert]}}};
    const group={entityId:"group",details:{id:"group",botId:"bot",corpId:"corp",enabled:true,name:"研发群",secretId:"group-secret"}};
    const {db,events}=fixture([[task],[],[bot],[{id:"person"}],[{prefix:"DSP"}],[],[bot],[{id:"person"}],[current],[task],[group],[{externalId:"actual-seat-owner",name:"负责人"}],[{prefix:"DSP"}]]);
    const fetcher=vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({accessToken:"token"})))
      .mockResolvedValueOnce(new Response("{}",{status:403})).mockResolvedValueOnce(new Response(JSON.stringify({errcode:0})));
    vi.stubGlobal("fetch",fetcher);
    await notifySeatBot(db,agent,groupPolicy,[{...alert,elapsedMinutes:0}]);
    expect(events.filter(e=>e.details.status!=="sending").map(e=>[e.details.channel,e.details.status])).toEqual([["message","failed"],["group","submitted"]]);
  });
  it("does not leak a group message after the wait resolves", async () => {
    const groupPolicy={...policy,dingtalk:{...policy.dingtalk,groupId:"group"}};
    const current={...agent,adapterConfig:{dsp7SeatPolicy:groupPolicy,dsp7SeatPresence:{lastSeenAt:new Date().toISOString(),alerts:[]}}};
    const {db,events}=fixture([[task],[{id:"personal-already-reserved"}],[],[bot],[{id:"person"}],[current],[task]]);
    const fetcher=vi.fn();vi.stubGlobal("fetch",fetcher);
    await notifySeatBot(db,agent,groupPolicy,[{...alert,elapsedMinutes:0}]);
    expect(fetcher).not.toHaveBeenCalled();expect(events.at(-1)?.details).toMatchObject({channel:"group",status:"skipped"});
  });
  it("allows active shared DingTalk recipients without organization membership",async()=>{
    const {db,predicates}=fixture([[bot],[{id:"shared-person"}]]);
    await validateSeatBotTarget(db,"target-company",{botId:"bot",userId:"owner"});
    const query=predicates.at(-1)!;
    expect(query.sql).not.toContain('company_memberships');
    expect(query.sql).toContain('"personnel_people"."active"');
    expect(query.sql).toContain('"personnel_sources"."enabled"');
    expect(predicates[0].params).toContain('target-company');
    expect(query.sql).not.toContain('"personnel_people"."company_id"');
    expect(query.sql).not.toContain('"personnel_sources"."company_id"');
    expect(query.params).toEqual(expect.arrayContaining(["owner","DingTalk","corp",true]));
  });
  it("rejects a recipient absent from the active same-enterprise directory before sending",async()=>{
    const {db}=fixture([[bot],[]]);
    await expect(validateSeatBotTarget(db,"target-company",{botId:"bot",userId:"outsider"})).rejects.toThrow("接收人必须");
  });
  it("notifies only the assigned human reviewer task after dependency activation",async()=>{
    delivery.wait.mockResolvedValue({flow:{snapshotId:"source"},stage:{executionMode:"human",reviewerUserId:"reviewer"}});
    const {db,events}=fixture([[{id:"task",description:"DELIVERY-WORKFLOW",assigneeAgentId:null,assigneeUserId:"reviewer"}],[],[bot],[{id:"person"}],[{prefix:"DSP"}]]);
    const fetcher=vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({accessToken:"token"}))).mockResolvedValueOnce(new Response(JSON.stringify({processQueryKey:"receipt"})));
    vi.stubGlobal("fetch",fetcher);
    await notifySeatBot(db,agent,policy,[{...alert,id:"delivery:task:digest",elapsedMinutes:0,level:"warning"}]);
    expect(events.at(-1)?.details).toMatchObject({status:"submitted",channel:"message"});expect(fetcher).toHaveBeenCalledTimes(2);
  });
  it("does not send a human review notification after task reassignment",async()=>{
    delivery.wait.mockResolvedValue({flow:{snapshotId:"source"},stage:{executionMode:"human",reviewerUserId:"reviewer"}});
    const {db,events}=fixture([[{id:"task",description:"DELIVERY-WORKFLOW",assigneeUserId:"other"}]]);
    const fetcher=vi.fn();vi.stubGlobal("fetch",fetcher);
    await notifySeatBot(db,agent,policy,[{...alert,id:"delivery:task:digest"}]);expect(fetcher).not.toHaveBeenCalled();expect(events).toEqual([]);
  });
  it("allows a live analysis decision without inventing a Jira pilot", async()=>{
    analysis.wait.mockResolvedValue({task:{id:"task"}});
    const {db,events}=fixture([[{id:"task",assigneeAgentId:"seat",description:"Independent analysis"}],[],[bot],[{id:"person"}],[{prefix:"DSP"}]]);
    const fetcher=vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({accessToken:"fixture-token"}))).mockResolvedValueOnce(new Response(JSON.stringify({processQueryKey:"receipt"})));
    vi.stubGlobal("fetch",fetcher);
    await notifySeatBot(db,agent,policy,[{...alert,id:"analysis:run:digest",elapsedMinutes:0,level:"warning"}]);
    expect(analysis.wait).toHaveBeenCalled();expect(fetcher).toHaveBeenCalledTimes(2);expect(events.at(-1)?.details).toMatchObject({status:"submitted",channel:"message"});
  });
  it("does not notify from an analysis alert after its authorization or decision expires",async()=>{
    analysis.wait.mockResolvedValue(null);
    const {db,events}=fixture([[{id:"task",assigneeAgentId:"seat",description:"Independent analysis"}]]);const fetcher=vi.fn();vi.stubGlobal("fetch",fetcher);
    await notifySeatBot(db,agent,policy,[{...alert,id:"analysis:old-run:digest"}]);expect(fetcher).not.toHaveBeenCalled();expect(events).toEqual([]);
  });
  it("sends one actual DING and records its receipt", async () => {
    const {db, events} = fixture([[task], [], [bot], [{id: "person"}], [{prefix: "DSP"}], [{config: {dsp7SeatPresence: {lastSeenAt: new Date().toISOString(), alerts: [alert]}}}], [task]]);
    const fetcher = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({accessToken: "fixture-token"}))).mockResolvedValueOnce(new Response(JSON.stringify({openDingId: "real-receipt"})));
    vi.stubGlobal("fetch", fetcher);
    await notifySeatBot(db, agent, policy, [alert]);
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(String(fetcher.mock.calls[1][0])).toBe("https://api.dingtalk.com/v1.0/robot/ding/send");
    expect(events.at(-1)?.details).toMatchObject({status: "submitted", channel: "ding", openDingId: "real-receipt"});
    expect(JSON.stringify(events)).not.toContain("fixture-token");expect(JSON.stringify(events)).not.toContain("fixture-secret");
  });
  it("does not send when the wait was resolved during token acquisition", async () => {
    const {db, events} = fixture([[task], [], [bot], [{id: "person"}], [{prefix: "DSP"}], [{config: {dsp7SeatPresence: {lastSeenAt: new Date().toISOString(), alerts: []}}}], [task]]);
    const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify({accessToken: "token"})));vi.stubGlobal("fetch", fetcher);
    await notifySeatBot(db, agent, policy, [alert]);
    expect(fetcher).toHaveBeenCalledTimes(1);expect(events.at(-1)?.details).toMatchObject({status: "skipped",channel: "ding"});
  });
  it("respects the durable reservation across heartbeats, including uncertain prior delivery", async () => {
    const {db, events} = fixture([[task], [{id: "prior-ding-reservation"}], [{id: "prior-message-reservation"}]]);
    const fetcher=vi.fn();vi.stubGlobal("fetch",fetcher);
    await notifySeatBot(db,agent,policy,[alert]);expect(fetcher).not.toHaveBeenCalled();expect(events).toEqual([]);
  });
  it("sends nothing for completed, cancelled, reassigned or cross-company tasks", async () => {
    const {db, events}=fixture([[]]);const fetcher=vi.fn();vi.stubGlobal("fetch",fetcher);
    await notifySeatBot(db,agent,policy,[alert]);expect(fetcher).not.toHaveBeenCalled();expect(events).toEqual([]);
  });
});
