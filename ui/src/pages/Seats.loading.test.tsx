// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, expect, it, vi } from "vitest";
import { Seats } from "./Seats";
const state = vi.hoisted(() => ({ crumbs: vi.fn(), report: vi.fn(), device: vi.fn(), intake: vi.fn(), admin: vi.fn() }));
vi.mock("@/lib/router", async () => import("react-router-dom"));
vi.mock("@/context/CompanyContext", () => ({ useCompany: () => ({ selectedCompanyId: "company" }) }));
vi.mock("@/context/BreadcrumbContext", () => ({ useBreadcrumbs: () => ({ setBreadcrumbs: state.crumbs }) }));
vi.mock("@/hooks/useManagementAccess", () => ({ useManagementAccess: () => ({ canManage: true, canOperate: true }) }));
vi.mock("@/components/SeatObservability", () => ({ SeatObservability: (props: { active: boolean }) => { state.report(props.active); return <p>统计内容</p>; } }));
vi.mock("@/components/SeatDevicePanel", () => ({ SeatDevicePanel: (props: { active: boolean }) => { state.device(props.active); return <input aria-label="设备草稿" defaultValue="原配置"/>; } }));
vi.mock("@/components/JiraSeatDispatch", () => ({ JiraSeatDispatch: () => { state.intake(); return null; } }));
vi.mock("@/components/SeatQingzhouAccount", () => ({ SeatQingzhouAccount: () => null }));
vi.mock("@/components/SeatBotManager", () => ({ SeatBotManager: () => { state.admin(); return null; } }));
vi.mock("@/components/SeatNotificationGroupManager", () => ({ SeatNotificationGroupManager: () => null }));
vi.mock("@/components/DeleteSeatButton", () => ({ DeleteSeatButton: () => null }));
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
let cleanup: () => Promise<void>;
afterEach(async () => { await cleanup?.(); vi.clearAllMocks(); });
async function mount(query = "") {
 const node=document.createElement("div");document.body.append(node);const root=createRoot(node);
 const cache=new QueryClient({defaultOptions:{queries:{retry:false,staleTime:Infinity}}});
 cache.setQueryData(["dsp7-registered-seats","company"],[{agentId:"seat",name:"刘小波",agentName:"刘小波",environmentName:"电脑",owner:null,canConfigure:true,isMine:true,online:true,usable:true,runtime:null,policy:{mode:"manual",jiraKeys:[],reminderMinutes:10,escalationMinutes:30},presence:{state:"idle",lastSeenAt:new Date().toISOString(),checks:[],alerts:[],tasks:[],activeTaskId:null}}]);
 cache.setQueryData(["dsp7-seat-commands","company","seat"],[]);
 cleanup=async()=>{await act(async()=>root.unmount());cache.clear();node.remove();};
 await act(async()=>root.render(<QueryClientProvider client={cache}><MemoryRouter initialEntries={["/DSP/seats?seat=seat"+query]}><Seats/></MemoryRouter></QueryClientProvider>));
 return {node,cache};
}
async function tab(node:HTMLElement,label:string){const button=[...node.querySelectorAll<HTMLButtonElement>('[role="tab"]')].find(b=>b.textContent===label)!;await act(async()=>{button.dispatchEvent(new MouseEvent("mousedown",{bubbles:true,button:0}));button.click();});}
it("opens the seat workbench without mounting hidden reports or settings",async()=>{
 const {node}=await mount();expect(node.textContent).toContain("刘小波");expect(state.report).not.toHaveBeenCalled();expect(state.admin).not.toHaveBeenCalled();expect(state.intake).not.toHaveBeenCalled();expect(state.device).not.toHaveBeenCalled();
});
it("loads the linked device tab and preserves drafts while pausing hidden work",async()=>{
 const {node,cache}=await mount("&tab=device");expect(state.device).toHaveBeenLastCalledWith(true);expect(state.report).not.toHaveBeenCalled();
 const input=node.querySelector<HTMLInputElement>('[aria-label="设备草稿"]')!;input.value="未保存修改";
 await tab(node,"运行概览");expect(state.device).toHaveBeenLastCalledWith(false);
 await tab(node,"设备与诊断");expect(node.querySelector<HTMLInputElement>('[aria-label="设备草稿"]')!.value).toBe("未保存修改");
 await tab(node,"统计分析");expect(state.report).toHaveBeenLastCalledWith(true);expect(state.device).toHaveBeenLastCalledWith(false);
 expect(cache.getQueryCache().find({queryKey:["dsp7-seat-commands","company","seat"]})!.isActive()).toBe(false);
 await tab(node,"运行工作台");expect(state.report).toHaveBeenLastCalledWith(false);expect(state.device).toHaveBeenLastCalledWith(true);
});
it("loads a statistics deep link without mounting the workbench settings",async()=>{
 await mount("&view=reports&tab=device");expect(state.report).toHaveBeenLastCalledWith(true);expect(state.device).not.toHaveBeenCalled();expect(state.intake).not.toHaveBeenCalled();expect(state.admin).not.toHaveBeenCalled();
});
