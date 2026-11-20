// @vitest-environment jsdom
import { act, useState } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import type { DeliveryMonthlyEntries } from "@paperclipai/shared";
import { DeliveryMonthlyBoard } from "./DeliveryMonthlyBoard";
const state=vi.hoisted(()=>({post:vi.fn(),monthlyQuery:undefined as undefined|(()=>Promise<unknown>),initial:"",current:new URLSearchParams(),items:[] as DeliveryMonthlyEntries["items"]}));
vi.mock("@/lib/router",()=>({
  useNavigate:()=>vi.fn(),
  useSearchParams:()=>{
    const [params,setParams]=useState(()=>new URLSearchParams(state.initial));state.current=params;
    return [params,(value: string | ((previous:URLSearchParams)=>URLSearchParams))=>setParams(previous=>typeof value==="function"?value(previous):new URLSearchParams(value))];
  },
  Link:({to,children}: {to:string;children:React.ReactNode})=><a href={to}>{children}</a>,
}));
vi.mock("@/api/client",()=>({api:{post:state.post}}));
vi.mock("@tanstack/react-query",()=>({
  useQueryClient:()=>({}),
  useMutation:()=>({}),
  useQuery:({queryKey,queryFn,enabled}:{queryKey:string[];queryFn:()=>Promise<unknown>;enabled?:boolean})=>{
    if(queryKey[0]==="delivery-monthly-schedule")return {data:enabled?{enabled:true,time:"06:00",nextRunAt:"2026-11-20T22:00:00Z"}:undefined};
    if(queryKey[0]==="delivery-monthly")state.monthlyQuery=queryFn;
    return {refetch:queryFn,data:queryKey[0]==="delivery-connection"?{revision:1,credentialsConfigured:true}:{month:"2026-11",collectedAt:"2026-11-08T00:00:00Z",items:state.items}};
  },
}));
vi.mock("./DeliveryMonthlyBulkSync",()=>({DeliveryMonthlyBulkSync:()=>null}));
vi.mock("./SearchableSelect",()=>({SearchableSelect:({value,groups,onValueChange,placeholder}:{value:string;groups:{options:{key:string;value:string;label:string}[]}[];onValueChange:(value:string)=>void;placeholder:string})=><select aria-label={placeholder} value={value} onChange={e=>onValueChange(e.target.value)}>{groups.flatMap(group=>group.options).map(option=><option key={option.key} value={option.value}>{option.label}</option>)}</select>}));
vi.mock("./SourceStatusMultiSelect",()=>({SourceStatusMultiSelect:({onChange}:{onChange:(values:string[])=>void})=><button onClick={()=>onChange(['"待开发"'])}>选择待开发</button>}));
Object.assign(globalThis,{IS_REACT_ACT_ENVIRONMENT:true});
let cleanup:(()=>Promise<void>)|undefined;
afterEach(async()=>{await cleanup?.();vi.unstubAllGlobals();cleanup=undefined;state.items=[];state.post.mockReset();state.monthlyQuery=undefined;});
async function mount(initial:string){
  state.initial=initial;
  const node=document.createElement("div");document.body.append(node);const root=createRoot(node);
  await act(async()=>root.render(<DeliveryMonthlyBoard companyId="c" projectId="p" canManage/>));
  cleanup=async()=>{await act(async()=>root.unmount());node.remove();};
  return {node,click:async(text:string)=>{const button=[...node.querySelectorAll("button")].find(b=>b.textContent?.startsWith(text));expect(button).toBeDefined();await act(async()=>button!.click());}};
}
it("shows legacy admission filters in their single visible control and clears all filters",async()=>{
  const {node,click}=await mount("projectId=p&month=2026-11&mRisk=entry_unconfigured&mStatus=%22待开发%22&mq=测试&mSort=start");
  expect((node.querySelector('[aria-label="月度交付链准入"]') as HTMLSelectElement).value).toBe("unconfigured");
  expect(node.querySelector('[aria-label="月度交付风险"]')?.textContent).not.toContain("准入");
  expect(node.querySelector('[aria-label="月度交付链准入"]')?.textContent).not.toContain("待同步");
  await click("清除全部筛选");
  expect(state.current.toString()).toBe("projectId=p&month=2026-11");
  expect((node.querySelector('[aria-label="月度条目搜索"]') as HTMLInputElement).value).toBe("");
});
it("switches between coarse progress and detailed source status without conflicting conditions",async()=>{
  const {click}=await mount("month=2026-11&mStatus=%22待开发%22&mRisk=past_plan");
  await click("已完成");expect(state.current.get("mProgress")).toBe("completed");expect(state.current.has("mStatus")).toBe(false);
  await click("选择待开发");expect(state.current.has("mProgress")).toBe(false);expect(state.current.get("mStatus")).toBe('"待开发"');
  expect(state.current.get("mRisk")).toBe("past_plan");
});
it("filters by analysis owner before pagination and clears selection, preserving URL context",async()=>{
  state.items=Array.from({length:25},(_,index)=>({demandNo:`ATS3-${String(index).padStart(3,"0")}`,title:"需求",owner:"拆分人员",analysisOwner:index===24?"目标分析人员":"其他分析人员",sourceStatus:"待开发",startDate:"",endDate:"",workCount:0,snapshotId:`s-${index}`,admission:null}));
  const {node,click}=await mount("projectId=p&month=2026-11");
  expect(node.querySelector('[aria-label="条目分析负责人筛选"]')).not.toBeNull();
  await click("下一页");
  await act(async()=>{(node.querySelector('input[aria-label="选择 ATS3-020"]') as HTMLInputElement).click();});
  expect(node.textContent).toContain("预览批量同步（1）");
  const select=node.querySelector('[aria-label="全部分析负责人"]') as HTMLSelectElement;
  await act(async()=>{select.value='"目标分析人员"';select.dispatchEvent(new Event("change",{bubbles:true}));});
  expect(state.current.get("mAnalysisOwner")).toBe('"目标分析人员"');
  expect(node.textContent).toContain("显示 1 / 25 个条目");
  expect(node.textContent).toContain("预览批量同步（0）");
  expect([...node.querySelectorAll("tbody tr")].map(row=>row.textContent?.includes("ATS3-024"))).toEqual([true]);
  expect(node.querySelector('a[href*="snapshotId=s-24"]')?.getAttribute("href")).toContain("mAnalysisOwner=");
  await click("清除全部筛选");
  expect(state.current.toString()).toBe("projectId=p&month=2026-11");
  expect(select.value).toBe("");
  expect(node.querySelectorAll("tbody tr")).toHaveLength(20);
});
it("restores analysis owner from the URL without widening an absent month's selection",async()=>{
  const {node}=await mount("projectId=p&month=2026-11&mAnalysisOwner=%22本月未返回人员%22");
  expect(state.current.get("mAnalysisOwner")).toBe('"本月未返回人员"');
  expect(node.textContent).toContain("已启用 1 项筛选");
});

it("filters the two intake categories independently while retaining overlapping demands",async()=>{
  const base={title:"需求",owner:"研发",sourceStatus:"待开发",startDate:"",endDate:"",workCount:0,snapshotId:null,admission:null};
  state.items=[{...base,demandNo:"SCHED-1",inSchedule:true,inExpectedDeliveryMonth:false},{...base,demandNo:"BOTH-1",inSchedule:true,inExpectedDeliveryMonth:true},{...base,demandNo:"TWGF-00919",inSchedule:false,inExpectedDeliveryMonth:true,expectedDeliveryDate:"2026-11-01",workCountKnown:false}];
  const {node,click}=await mount("projectId=p&month=2026-11");
  expect(node.querySelectorAll("tbody tr")).toHaveLength(3);
  const select=node.querySelector('[aria-label="月度条目归属分类"]') as HTMLSelectElement;
  await act(async()=>{select.value="expected";select.dispatchEvent(new Event("change",{bubbles:true}));});
  expect(state.current.get("mScope")).toBe("expected");expect(node.querySelectorAll("tbody tr")).toHaveLength(2);
  expect(node.textContent).toContain("工单数量待同步核对");
  await act(async()=>{select.value="scheduled";select.dispatchEvent(new Event("change",{bubbles:true}));});
  expect(node.querySelectorAll("tbody tr")).toHaveLength(2);expect(node.querySelector("tbody")?.textContent).not.toContain("TWGF-00919");
  await click("清除全部筛选");expect(state.current.has("mScope")).toBe(false);expect(node.querySelectorAll("tbody tr")).toHaveLength(3);
});

it("groups common filters together and collapses optional tools by default",async()=>{
  vi.stubGlobal("ResizeObserver", class {
    observe() {}
    unobserve() {}
    disconnect() {}
  });
  const {node,click}=await mount("month=2026-11");
  const panel=node.querySelector('[aria-label="月度条目筛选"]')!;
  for(const label of ["排期月份","月度条目搜索","月度条目归属分类","月度交付风险","月度来源进度"])expect(panel.querySelector(`[aria-label="${label}"]`)).not.toBeNull();
  expect(panel.querySelector('[aria-label="按条目编号精确查询"]')).not.toBeNull();
  expect(panel.querySelector('[aria-label="按条目编号精确查询"] h2')).toBeNull();
  expect((node.querySelector('[aria-label="更多筛选"]') as HTMLDetailsElement).open).toBe(false);
  expect((node.querySelector('[aria-label="整月同步操作"]') as HTMLDetailsElement).open).toBe(false);
  const toolbarButtons=[...panel.querySelectorAll("button")].map(button=>button.textContent);
  expect(toolbarButtons.slice(0,2)).toEqual(["刷新条目","定时同步"]);
  expect(document.querySelector('[role="dialog"][aria-label="定时同步"]')).toBeNull();
  await click("定时同步");
  const settings=document.querySelector('[role="dialog"][aria-label="定时同步"]');
  expect(settings?.querySelector<HTMLInputElement>('input[type="time"]')?.value).toBe("06:00");
  expect(settings?.textContent).toContain("下次运行");
  await click("定时同步");
  expect(document.querySelector('[role="dialog"][aria-label="定时同步"]')).toBeNull();
});
it("exposes restored advanced conditions instead of hiding their active controls",async()=>{
  const {node}=await mount('month=2026-11&mSync=unsynced');
  expect((node.querySelector('[aria-label="更多筛选"]') as HTMLDetailsElement).open).toBe(true);
  expect((node.querySelector('[aria-label="月度同步情况"]') as HTMLSelectElement).value).toBe("unsynced");
});

it("manual refresh bypasses source cache only for that read",async()=>{
  const {click}=await mount("projectId=p&month=2026-11");
  await state.monthlyQuery!();expect(state.post).toHaveBeenLastCalledWith("/companies/c/delivery-connections/monthly",{projectId:"p",expectedRevision:1,month:"2026-11"});
  await click("刷新条目");expect(state.post).toHaveBeenLastCalledWith("/companies/c/delivery-connections/monthly",{projectId:"p",expectedRevision:1,month:"2026-11",forceRefresh:true});
  await state.monthlyQuery!();expect(state.post.mock.calls.at(-1)![1]).not.toHaveProperty("forceRefresh");
});
