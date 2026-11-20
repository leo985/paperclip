// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DeliveryAdmission, DeliverySnapshot } from "@paperclipai/shared";
import { DeliveryAdmissionPanel } from "./DeliveryAdmissionPanel";
import { sourceCodingCompleted } from "@/lib/delivery-entry-stages";
vi.mock("@/lib/router",()=>import("react-router-dom"));
const {post}=vi.hoisted(()=>({post:vi.fn()}));
vi.mock("@/api/client",()=>({api:{post}}));
const snapshot:DeliverySnapshot={id:"snapshot",projectId:"project",demandNo:"XLTZ-00008",sourceOrigin:"qingzhou",collectedAt:"2026-11-05",createdAt:"2026-11-05",plan:{demandId:"1",demandNo:"XLTZ-00008",title:"需求",status:"开发中",roles:[],mains:[],scheduleCount:1,differences:[],fingerprint:"source-version",sourceMode:"online_readonly",executionAllowed:false,items:[{key:"CODE",parentKey:"MAIN",type:"编码",title:"编码",status:"已完成",assignee:"研发",scheduled:true},{key:"REVIEW",parentKey:"MAIN",type:"代码评审",title:"代码评审",status:"待受理",assignee:"评审",scheduled:true}]}};
const admission:DeliveryAdmission={ready:false,reasons:["尚未登记正式结论"],analysisExecutionId:null,evidence:null};
let cleanup:(()=>void)|undefined;
afterEach(async()=>{await act(async()=>cleanup?.());cleanup=undefined;vi.clearAllMocks();});
async function mount(extra:Partial<Parameters<typeof DeliveryAdmissionPanel>[0]>={}) {
 const node=document.createElement("div");document.body.append(node);const root=createRoot(node);const client=new QueryClient();
 await act(async()=>root.render(<QueryClientProvider client={client}><MemoryRouter><DeliveryAdmissionPanel companyId="company" snapshot={snapshot} admission={admission} canManage {...extra}/></MemoryRouter></QueryClientProvider>));
 cleanup=()=>{root.unmount();client.clear();node.remove();};return node;
}
describe("entry-level admission presentation",()=>{
 it("shows only a summary and overview link in a stage without duplicate registration or dispatch actions",async()=>{
  const node=await mount({compact:true,overviewHref:"/delivery?snapshotId=snapshot&tab=overview#delivery-admission"});
  expect(node.querySelector('[aria-label="编码阶段准入摘要"]')).not.toBeNull();
  expect(node.textContent).toContain("条目新增编码准入 · 待登记");
  expect(node.querySelector("a")?.getAttribute("href")).toBe("/delivery?snapshotId=snapshot&tab=overview#delivery-admission");
  expect(node.querySelector("form")).toBeNull();expect(node.querySelectorAll("a")).toHaveLength(1);expect(post).not.toHaveBeenCalled();
 });
 it("does not tell completed historical coding to repeat analysis or start another coding task",async()=>{
  const node=await mount();
  expect(node.querySelector("#delivery-admission")).not.toBeNull();expect(node.textContent).toContain("无需为历史工单重新执行需求分析");
  expect(node.textContent).toContain("后续新增编码任务仍需核验准入条件");
  expect(node.textContent).not.toContain("创建或查看需求分析");expect(node.textContent).not.toContain("编码待准入");
  expect(node.querySelector('a[href^="/jira-intake"]')).toBeNull();
  expect(node.querySelector('a[href*="tab=work"]')).not.toBeNull();
  expect(node.querySelector("form")).not.toBeNull();expect(node.querySelector('input[type="url"]')).not.toBeNull();expect(post).not.toHaveBeenCalled();
 });
 it("retains the admission warning for unfinished coding and limits registration to managers",async()=>{
  const unfinished={...snapshot,plan:{...snapshot.plan,items:snapshot.plan.items.map(i=>i.key==="CODE"?{...i,status:"待受理"}:i)}};
  const node=await mount({snapshot:unfinished,canManage:false});
  expect(node.textContent).toContain("条目新增编码准入 · 待登记");
  expect(node.textContent).toContain("CODE · 编码 · 待受理");
  expect(node.textContent).toContain("尚未登记正式结论");expect(node.querySelector("form")).toBeNull();
 });
 it("names the entry and keeps each main issue's source work separate from the admission status", async () => {
  const [coding] = snapshot.plan.items;
  const multiMain = {
   ...snapshot,
   plan: {
    ...snapshot.plan,
    mains: [{key:"ATSES-493227",sourceId:"493227",title:"对接 BPM"}],
    items: [
     {...coding,parentKey:"ATSES-493227",key:"ATSES-493228",type:"设计评审",status:"已完成"},
     {...coding,parentKey:"ATSES-494852",key:"ATSES-494854",type:"系统设计",status:"待受理"},
     {...coding,parentKey:"ATSES-494852",key:"ATSES-494855",status:"待受理"},
    ],
   },
  };
  const node = await mount({snapshot:multiMain});
  expect(node.textContent).toContain("登记范围：XLTZ-00008 · 当前来源版本 · 2 张关联主工单");
  expect(node.querySelector("h2")?.textContent).toBe("条目新增编码准入 · 待登记");
  const [first, second] = [...node.querySelectorAll("tbody tr")];
  expect(first?.textContent).toContain("ATSES-493228 · 设计评审 · 已完成");
  expect(first?.querySelector("td:last-child")?.textContent).toBe("来源未提供");
  expect(second?.textContent).toContain("ATSES-494854 · 系统设计 · 待受理");
  expect(second?.textContent).toContain("ATSES-494855 · 编码 · 待受理");
  expect(second?.querySelector("th a")?.getAttribute("href")).toBe("#delivery-main-snapshot-ATSES-494852");
 });
 it("keeps registered admission results in the compact view",async()=>{
  const node=await mount({compact:true,admission:{...admission,ready:true,reasons:[]}});
  expect(node.textContent).toContain("条目新增编码准入 · 已通过");expect(node.textContent).not.toContain("未登记");
 });
 it("recognizes history only from positive completion of every coding child",()=>{
  expect(sourceCodingCompleted(snapshot.plan)).toBe(true);
  for(const status of ["已关闭","已取消","未知",""]){
   expect(sourceCodingCompleted({...snapshot.plan,items:snapshot.plan.items.map(i=>i.key==="CODE"?{...i,status}:i)})).toBe(false);
  }
  expect(sourceCodingCompleted({...snapshot.plan,items:snapshot.plan.items.filter(i=>i.key!=="CODE")})).toBe(false);
  expect(sourceCodingCompleted({...snapshot.plan,items:[...snapshot.plan.items,{...snapshot.plan.items[0],key:"FRONT",status:"待受理"}]})).toBe(false);
 });
});
