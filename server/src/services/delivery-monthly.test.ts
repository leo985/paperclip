import { describe, expect, it, vi } from "vitest";
import { readMonthlyDelivery } from "./delivery-monthly.js";
const input={organizationId:"123",month:"2026-10",credentials:async()=>({username:"fixture",password:"secret"})};
function source(options:{truncated?:boolean;wrongOrg?:boolean;empty?:boolean;badIdentity?:boolean;splitter?:string|null;omitSplitter?:boolean;lookupSplitter?:string|null;requirementer?:string|null;omitRequirementer?:boolean;lookupRequirementer?:string|null;missingDemand?:boolean;omitStatus?:boolean}={}) {
  return vi.fn(async(target:URL|string|Request)=>{
    const url=new URL(String(target));let result;
    if(url.pathname==="/api/auth/login")result={accessToken:"fixture-token"};
    else if(url.searchParams.get("uc")==="UC_PROJ2_SCHEDULE_ALLOT_SEARCH")result={success:true,code:"0",total:options.truncated?3:2,rows:[{organizationId:options.wrongOrg?"456":"123",urid:"101"},{organizationId:options.wrongOrg?"456":"123",urid:"102"}]};
    else if(url.searchParams.get("uc")==="UC_PROJ2_DEMAND_ITEM_ALL_SEARCH")result={success:true,code:"0",total:options.missingDemand?0:1,rows:options.missingDemand?[]:[{urid:"200",demandNo:"ATS3-00156",splitter_show:options.lookupSplitter,requirementer_show:options.lookupRequirementer,demandState_show:"开发中",assignee_show:"经办人",developDirector_show:"研发负责人"}]};
    else {
      expect(url.searchParams.get("number")).toBe("");
      result={success:true,code:"0",data:options.empty?[]:[{urid:options.badIdentity&&url.searchParams.get("manageId")==="102"?"201":"200",demandNo:"ATS3-00156",theme:"月度条目",demandState_show:options.omitStatus?undefined:"待需求分析",splitter_show:options.splitter === undefined ? "负责人" : options.splitter,requirementer_show:options.requirementer === undefined ? "分析负责人" : options.requirementer,developDirector_show:"研发负责人",assignee_show:"经办人",children:[{issueNo:"ATSES-1",preStartDate:"2026-10-05",children:[{issueNo:"ATSES-2",preEndDate:"2026-10-20"}]}]}]};
    }
    if(options.omitSplitter && Array.isArray(result.data))for(const root of result.data)Reflect.deleteProperty(root,"splitter_show");
    if(options.omitRequirementer && Array.isArray(result.data))for(const root of result.data)Reflect.deleteProperty(root,"requirementer_show");
    return new Response(JSON.stringify(result));
  });
}
describe("monthly read-only delivery",()=>{
  it("includes a DSP demand due this month even without membership of the configured group's schedule",async()=>{
    const fetcher=vi.fn(async(target:URL|string|Request,init?:RequestInit)=>{
      const url=new URL(String(target));if(url.pathname==="/api/auth/login")return new Response(JSON.stringify({accessToken:"fixture-token"}));
      if(url.searchParams.get("uc")==="UC_PROJ2_SCHEDULE_ALLOT_SEARCH")return new Response(JSON.stringify({success:true,code:"0",total:0,rows:[]}));
      expect(url.searchParams.get("uc")).toBe("UC_PROJ2_DEMAND_ITEM_ALL_SEARCH");
      expect((init!.body as URLSearchParams).get("subProductAttribution")).toBe("DSP");
      return new Response(JSON.stringify({success:true,code:"0",total:1,rows:[{urid:"200",demandNo:"TWGF-00919",theme:"跨组DSP条目",subProductAttribution:"DSP",estimatedDeliveryDate:"2026-11-01",projectGroup:"456",requirementer_show:"分析人员",demandState_show:"待需求分析"}]}));
    });
    const result=await readMonthlyDelivery({...input,month:"2026-11",subProductAttribution:"DSP"},fetcher as typeof fetch);
    expect(result.items).toHaveLength(1);expect(result.items[0]).toMatchObject({demandNo:"TWGF-00919",analysisOwner:"分析人员",expectedDeliveryDate:"2026-11-01",workCountKnown:false});
    expect(fetcher).toHaveBeenCalledTimes(3);
  });
  it("merges scheduled and expected-delivery demands, keeping both memberships without duplication",async()=>{
    const row=(urid:string,demandNo:string)=>({urid,demandNo,theme:demandNo,subProductAttribution:"DSP",estimatedDeliveryDate:"2026-11-01",splitter_show:"研发",requirementer_show:"分析",demandState_show:"待开发",children:null});
    const fetcher=async(target:URL|string|Request,init?:RequestInit)=>{
      const url=new URL(String(target)),uc=url.searchParams.get("uc");let data;
      if(url.pathname==="/api/auth/login")return new Response(JSON.stringify({accessToken:"fixture-token"}));
      if(uc==="UC_PROJ2_SCHEDULE_ALLOT_SEARCH")data={total:1,rows:[{organizationId:"123",urid:"100"}]};
      else if(uc==="UC_PROJ2_SCHEDULE_ISSUE_SEARCH")data={data:[row("200","SCHED-1"),row("201","BOTH-1")]};
      else {const key=(init!.body as URLSearchParams).get("demandNo");data=key?{total:1,rows:[{...row("200",key),estimatedDeliveryDate:"2026-10-01"}]}:{total:2,rows:[row("201","BOTH-1"),row("202","TWGF-00919")]};}
      return new Response(JSON.stringify({success:true,code:"0",...data}));
    };
    const result=await readMonthlyDelivery({...input,month:"2026-11",subProductAttribution:"DSP"},fetcher as typeof fetch);
    expect(result.items.map(x=>x.demandNo)).toEqual(["BOTH-1","SCHED-1","TWGF-00919"]);
    expect(result.items.find(x=>x.demandNo==="BOTH-1")).toMatchObject({inSchedule:true,inExpectedDeliveryMonth:true});
    expect(result.items.find(x=>x.demandNo==="SCHED-1")).toMatchObject({inSchedule:true,inExpectedDeliveryMonth:false});
    expect(result.items.find(x=>x.demandNo==="TWGF-00919")).toMatchObject({inSchedule:false,inExpectedDeliveryMonth:true,workCountKnown:false});
  });
  it("reads the analysis owner independently from the splitter without extra lookups",async()=>{
    const fetcher=source({requirementer:"分析人员",splitter:"拆分人员"});
    expect((await readMonthlyDelivery(input,fetcher as typeof fetch)).items[0]).toMatchObject({analysisOwner:"分析人员",owner:"拆分人员"});
    expect(fetcher.mock.calls.filter(([target])=>new URL(String(target)).searchParams.get("uc")==="UC_PROJ2_DEMAND_ITEM_ALL_SEARCH")).toHaveLength(0);
  });
  it("resolves omitted analysis owners once, sharing lookup with status and splitter",async()=>{
    const fetcher=source({omitRequirementer:true,omitSplitter:true,omitStatus:true,lookupRequirementer:"分析人员",lookupSplitter:"拆分人员"});
    expect((await readMonthlyDelivery(input,fetcher as typeof fetch)).items[0]).toMatchObject({analysisOwner:"分析人员",owner:"拆分人员",sourceStatus:"开发中"});
    expect(fetcher.mock.calls.filter(([target])=>new URL(String(target)).searchParams.get("uc")==="UC_PROJ2_DEMAND_ITEM_ALL_SEARCH")).toHaveLength(1);
  });
  it.each([null,"","   "])("preserves an explicit missing analysis owner %j during other field lookups",async(requirementer)=>{
    const result=await readMonthlyDelivery(input,source({requirementer,omitStatus:true,lookupRequirementer:"其他分析人员"}) as typeof fetch);
    expect(result.items[0]!.analysisOwner?.trim()).toBe("");
  });
  it("reports failed analysis owner reads instead of returning a missing owner",async()=>{
    await expect(readMonthlyDelivery(input,source({omitRequirementer:true,missingDemand:true}) as typeof fetch)).rejects.toMatchObject({code:"invalid_response"});
  });
  it("fills omitted demand status once without replacing an explicit empty splitter",async()=>{
    const fetcher=source({omitStatus:true,splitter:"",lookupSplitter:"其他人"});
    expect((await readMonthlyDelivery(input,fetcher as typeof fetch)).items[0]).toMatchObject({sourceStatus:"开发中",owner:""});
    expect(fetcher.mock.calls.filter(([target])=>new URL(String(target)).searchParams.get("uc")==="UC_PROJ2_DEMAND_ITEM_ALL_SEARCH")).toHaveLength(1);
  });
  it("keeps eight owner reads busy without waiting for a slow batch member", async () => {
    const pending = new Map<string, () => void>();
    let active = 0, peak = 0;
    const fetcher = async (target: URL | string | Request, init?: RequestInit) => {
      const url = new URL(String(target)), op = url.searchParams.get("uc");
      if (url.pathname === "/api/auth/login") return new Response(JSON.stringify({accessToken:"fixture-token"}));
      if (op === "UC_PROJ2_SCHEDULE_ALLOT_SEARCH") return new Response(JSON.stringify({success:true,code:"0",total:1,rows:[{organizationId:"123",urid:"101"}]}));
      if (op === "UC_PROJ2_SCHEDULE_ISSUE_SEARCH") return new Response(JSON.stringify({success:true,code:"0",data:Array.from({length:10},(_,i)=>({urid:String(200+i),demandNo:`ATS3-${i}`,children:null}))}));
      const demandNo = (init!.body as URLSearchParams).get("demandNo")!;
      active++; peak = Math.max(peak, active);
      await new Promise<void>(resolve => pending.set(demandNo, resolve)); active--;
      return new Response(JSON.stringify({success:true,code:"0",total:1,rows:[{urid:"200",demandNo,splitter_show:demandNo}]}));
    };
    const result = readMonthlyDelivery(input, fetcher as typeof fetch);
    await vi.waitFor(() => expect(pending.size).toBe(8));
    pending.get("ATS3-7")!();
    await vi.waitFor(() => expect(pending.has("ATS3-8")).toBe(true));
    // The first seven are still pending; a batch barrier would not start #8.
    pending.get("ATS3-8")!();
    await vi.waitFor(() => expect(pending.has("ATS3-9")).toBe(true));
    for (const resolve of pending.values()) resolve();
    const read = await result;
    expect(read.items).toHaveLength(10); expect(read.items.every(item=>item.owner===item.demandNo)).toBe(true);
    expect(peak).toBe(8);
  });
  it("resolves omitted schedule splitters from exact demand lookup once per unique entry",async()=>{
    const fetcher=source({omitSplitter:true,lookupSplitter:"0474-尚志佳"});
    expect((await readMonthlyDelivery(input,fetcher as typeof fetch)).items[0]!.owner).toBe("0474-尚志佳");
    expect(fetcher.mock.calls.filter(([target])=>new URL(String(target)).searchParams.get("uc")==="UC_PROJ2_DEMAND_ITEM_ALL_SEARCH")).toHaveLength(1);
  });
  it.each([undefined,null,"","   "])("marks missing demand splitter %j without falling back to other personnel",async(lookupSplitter)=>{
    const result=await readMonthlyDelivery(input,source({omitSplitter:true,lookupSplitter}) as typeof fetch);
    expect(result.items[0]!.owner.trim()).toBe("");
  });
  it("rejects an unresolved demand rather than treating a failed lookup as missing owner",async()=>{
    await expect(readMonthlyDelivery(input,source({omitSplitter:true,missingDemand:true}) as typeof fetch)).rejects.toMatchObject({code:"invalid_response"});
  });
  it.each([null,"","   "])("leaves owner missing when the demand splitter is %j despite other owners",async(splitter)=>{
    const result=await readMonthlyDelivery(input,source({splitter}) as typeof fetch);
    expect(result.items[0]!.owner.trim()).toBe("");
  });
  it("merges repeated month contexts by exact identity and deduplicates work",async()=>{
    const fetcher=source();const r=await readMonthlyDelivery(input,fetcher as typeof fetch);
    expect(r).toMatchObject({month:"2026-10",executionAllowed:false,items:[{demandNo:"ATS3-00156",owner:"负责人",workCount:2,startDate:"2026-10-05",endDate:"2026-10-20",snapshotId:null,admission:null}]});
    expect(JSON.stringify(r)).not.toMatch(/secret|fixture-token/);
  });
  it("returns a real empty result without querying unrelated organizations",async()=>{
    const fetcher=source({wrongOrg:true});expect((await readMonthlyDelivery(input,fetcher as typeof fetch)).items).toEqual([]);expect(fetcher).toHaveBeenCalledTimes(2);
    expect((await readMonthlyDelivery(input,source({empty:true}) as typeof fetch)).items).toEqual([]);
  });
  it("rejects truncated plans, malformed month and conflicting business identities",async()=>{
    await expect(readMonthlyDelivery(input,source({truncated:true}) as typeof fetch)).rejects.toMatchObject({code:"incomplete_response"});
    await expect(readMonthlyDelivery(input,source({badIdentity:true}) as typeof fetch)).rejects.toMatchObject({code:"invalid_response"});
    const fetcher=source();await expect(readMonthlyDelivery({...input,month:"2026-99"},fetcher as typeof fetch)).rejects.toMatchObject({code:"invalid_response"});expect(fetcher).not.toHaveBeenCalled();
  });
  it("accepts Qingzhou null child lists as leaves, including an empty demand root",async()=>{
    const fetcher=vi.fn(async(target:URL|string|Request)=>{
      const url=new URL(String(target));
      if(url.pathname==="/api/auth/login")return new Response(JSON.stringify({accessToken:"fixture-token"}));
      if(url.searchParams.get("uc")==="UC_PROJ2_SCHEDULE_ALLOT_SEARCH")return new Response(JSON.stringify({success:true,code:"0",total:1,rows:[{organizationId:"123",urid:"101"}]}));
      return new Response(JSON.stringify({success:true,code:"0",data:[{urid:"200",demandNo:"ATS3-00156",splitter_show:null,requirementer_show:null,demandState_show:"待需求分析",children:[{issueNo:"ATSES-1",children:[{issueNo:"ATSES-2",preStartDate:"2026-10-05",preEndDate:"2026-10-20",children:null}]}]},{urid:"201",demandNo:"ATS3-00157",splitter_show:null,requirementer_show:null,demandState_show:"待需求分析",children:null}]}));
    });
    expect((await readMonthlyDelivery(input,fetcher as typeof fetch)).items).toMatchObject([{demandNo:"ATS3-00156",workCount:2,startDate:"2026-10-05",endDate:"2026-10-20"},{demandNo:"ATS3-00157",workCount:0}]);
  });
  it("still rejects non-null malformed child containers instead of silently dropping work",async()=>{
    for(const children of [{},"",0]){
      const fetcher=async(target:URL|string|Request)=>{
        const url=new URL(String(target));
        if(url.pathname==="/api/auth/login")return new Response(JSON.stringify({accessToken:"fixture-token"}));
        if(url.searchParams.get("uc")==="UC_PROJ2_SCHEDULE_ALLOT_SEARCH")return new Response(JSON.stringify({success:true,code:"0",total:1,rows:[{organizationId:"123",urid:"101"}]}));
        return new Response(JSON.stringify({success:true,code:"0",data:[{urid:"200",demandNo:"ATS3-00156",splitter_show:null,children:[{issueNo:"ATSES-1",children}]}]}));
      };
      await expect(readMonthlyDelivery(input,fetcher as typeof fetch)).rejects.toMatchObject({code:"invalid_response"});
    }
  });

});

it("starts the schedule tree while expected delivery is still pending and drains on failure", async () => {
  let release!: () => void;
  const expected = new Promise<void>(resolve => { release = resolve; });
  const calls: string[] = [];
  const fetcher = async (target: URL | string | Request) => {
    const url = new URL(String(target)), op = url.searchParams.get("uc")!;
    if (url.pathname === "/api/auth/login") return Response.json({ accessToken: "fixture-token" });
    calls.push(op);
    if (op === "UC_PROJ2_DEMAND_ITEM_ALL_SEARCH") { await expected; return Response.json({ success: true, code: "0", total: 0, rows: [] }); }
    if (op === "UC_PROJ2_SCHEDULE_ALLOT_SEARCH") return Response.json({ success: true, code: "0", total: 1, rows: [{ organizationId: "123", urid: "101" }] });
    return Response.json({ success: true, code: "0", data: [] });
  };
  const timings: Record<string, number> = {};
  const pending = readMonthlyDelivery({ ...input, subProductAttribution: "DSP", timings }, fetcher as typeof fetch);
  await vi.waitFor(() => expect(calls).toContain("UC_PROJ2_SCHEDULE_ISSUE_SEARCH"));
  release(); expect((await pending).items).toEqual([]);
  expect(Object.keys(timings)).toEqual(expect.arrayContaining(["authentication", "expected", "plans", "trees", "lookups"]));
});

it("keeps failed parallel reads accounted for until their sibling settles", async () => {
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  let treeStarted = false, settled = false;
  const fetcher = async (target: URL | string | Request) => {
    const url = new URL(String(target)), op = url.searchParams.get("uc");
    if (url.pathname === "/api/auth/login") return Response.json({ accessToken: "fixture-token" });
    if (op === "UC_PROJ2_DEMAND_ITEM_ALL_SEARCH") return new Response("failed", { status: 503 });
    if (op === "UC_PROJ2_SCHEDULE_ALLOT_SEARCH") return Response.json({ success: true, code: "0", total: 1, rows: [{ organizationId: "123", urid: "101" }] });
    treeStarted = true; await held;
    return Response.json({ success: true, code: "0", data: [] });
  };
  const pending = readMonthlyDelivery({ ...input, subProductAttribution: "DSP" }, fetcher as typeof fetch).finally(() => { settled = true; });
  const rejection = expect(pending).rejects.toMatchObject({ code: "source_rejected" });
  await vi.waitFor(() => expect(treeStarted).toBe(true));
  expect(settled).toBe(false);
  release(); await rejection;
});
