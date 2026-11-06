import { describe, expect, it, vi } from "vitest";
import { readMonthlyDelivery } from "./delivery-monthly.js";
const input={organizationId:"123",month:"2026-10",credentials:async()=>({username:"fixture",password:"secret"})};
function source(options:{truncated?:boolean;wrongOrg?:boolean;empty?:boolean;badIdentity?:boolean;splitter?:string|null;omitSplitter?:boolean;lookupSplitter?:string|null;missingDemand?:boolean;omitStatus?:boolean}={}) {
  return vi.fn(async(target:URL|string|Request)=>{
    const url=new URL(String(target));let result;
    if(url.pathname==="/api/auth/login")result={accessToken:"fixture-token"};
    else if(url.searchParams.get("uc")==="UC_PROJ2_SCHEDULE_ALLOT_SEARCH")result={success:true,code:"0",total:options.truncated?3:2,rows:[{organizationId:options.wrongOrg?"456":"123",urid:"101"},{organizationId:options.wrongOrg?"456":"123",urid:"102"}]};
    else if(url.searchParams.get("uc")==="UC_PROJ2_DEMAND_ITEM_ALL_SEARCH")result={success:true,code:"0",total:options.missingDemand?0:1,rows:options.missingDemand?[]:[{urid:"200",demandNo:"ATS3-00156",splitter_show:options.lookupSplitter,demandState_show:"开发中",assignee_show:"经办人",developDirector_show:"研发负责人"}]};
    else {
      expect(url.searchParams.get("number")).toBe("");
      result={success:true,code:"0",data:options.empty?[]:[{urid:options.badIdentity&&url.searchParams.get("manageId")==="102"?"201":"200",demandNo:"ATS3-00156",theme:"月度条目",demandState_show:options.omitStatus?undefined:"待需求分析",splitter_show:options.splitter === undefined ? "负责人" : options.splitter,developDirector_show:"研发负责人",assignee_show:"经办人",children:[{issueNo:"ATSES-1",preStartDate:"2026-10-05",children:[{issueNo:"ATSES-2",preEndDate:"2026-10-20"}]}]}]};
    }
    if(options.omitSplitter && Array.isArray(result.data))for(const root of result.data)Reflect.deleteProperty(root,"splitter_show");
    return new Response(JSON.stringify(result));
  });
}
describe("monthly read-only delivery",()=>{
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
      return new Response(JSON.stringify({success:true,code:"0",data:[{urid:"200",demandNo:"ATS3-00156",splitter_show:null,demandState_show:"待需求分析",children:[{issueNo:"ATSES-1",children:[{issueNo:"ATSES-2",preStartDate:"2026-10-05",preEndDate:"2026-10-20",children:null}]}]},{urid:"201",demandNo:"ATS3-00157",splitter_show:null,demandState_show:"待需求分析",children:null}]}));
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
