// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { SeatClientUpgrade } from "./SeatClientUpgrade";
const mocks=vi.hoisted(()=>({admin:true,status:vi.fn(),request:vi.fn(),cancel:vi.fn()}));
vi.mock("@/hooks/useManagementAccess",()=>({useManagementAccess:()=>({canManage:mocks.admin})}));
vi.mock("@/api/dsp7-seats",()=>({dsp7SeatsApi:{upgradeStatus:mocks.status,requestUpgrade:mocks.request,cancelUpgrade:mocks.cancel}}));
(globalThis as any).IS_REACT_ACT_ENVIRONMENT=true;
const seat:any={agentId:"seat",name:"test",canConfigure:true,online:true,presence:{bridgeVersion:"a".repeat(64),capabilities:["seat-admin-upgrade-v1"],checks:[]}};
let root:Root,container:HTMLDivElement,cache:QueryClient;
async function show(value=seat){container=document.createElement("div");document.body.append(container);root=createRoot(container);cache=new QueryClient({defaultOptions:{queries:{retry:false}}});await act(async()=>{root.render(<QueryClientProvider client={cache}><SeatClientUpgrade companyId="company" seat={value}/></QueryClientProvider>);});await act(async()=>{await new Promise(resolve=>setTimeout(resolve,20));});}
const button=(label:string)=>[...container.querySelectorAll("button")].find(item=>item.textContent===label);
beforeEach(()=>{vi.clearAllMocks();mocks.admin=true;mocks.status.mockResolvedValue(null);mocks.request.mockResolvedValue({});vi.stubGlobal("fetch",vi.fn().mockResolvedValue({ok:true,json:async()=>({sha256:"b".repeat(64)})}));});
afterEach(async()=>{await act(async()=>root?.unmount());container?.remove();cache?.clear();vi.unstubAllGlobals();});
it("only explicit admin action dispatches a target version",async()=>{await show();expect(button("下发客户端升级")?.disabled).toBe(false);expect(mocks.request).not.toHaveBeenCalled();await act(async()=>button("下发客户端升级")!.click());expect(mocks.request).toHaveBeenCalledWith("company","seat","b".repeat(64));});
it("ordinary seat owners cannot dispatch upgrades",async()=>{mocks.admin=false;await show();expect(button("下发客户端升级")).toBeUndefined();expect(mocks.request).not.toHaveBeenCalled();});
it("unsupported clients require bootstrap and cannot dispatch",async()=>{await show({...seat,presence:{...seat.presence,capabilities:[]}});expect(button("下发客户端升级")?.disabled).toBe(true);expect(container.textContent).toContain("请先在原电脑按下方步骤更新一次");});
it("queued requests expose explicit cancellation",async()=>{mocks.status.mockResolvedValue({requestId:"request",targetSha256:"b".repeat(64),status:"queued",message:"等待"});await show();await act(async()=>button("取消升级请求")!.click());expect(mocks.cancel).toHaveBeenCalledWith("company","seat","request","b".repeat(64));});
