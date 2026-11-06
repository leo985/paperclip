// @vitest-environment jsdom
import type { ReactNode } from "react";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DeliveryPlan, DeliveryWorkItem } from "@paperclipai/shared";
import { deliveryDispatchRows, matchesDispatchView, sourceWorkEnded } from "@/lib/delivery-work-dispatch";
import { DeliveryWorkDispatch } from "./DeliveryWorkDispatch";
vi.mock("@/lib/router",()=>({Link:({to,children,...props}:{to:string;children:ReactNode})=><a href={to} {...props}>{children}</a>}));
const child=(key:string,extra:Partial<DeliveryWorkItem>={}):DeliveryWorkItem=>({key,parentKey:"MAIN-1",title:key+" 标题",type:"编码",status:"待受理",assignee:"研发甲",scheduled:true,...extra});
const plan:DeliveryPlan={demandId:"1",demandNo:"ATS3-00156",title:"需求",status:"开发中",roles:[],mains:[],scheduleCount:0,differences:[],fingerprint:"dispatch-test",sourceMode:"online_readonly",executionAllowed:false,items:[
 child("MAIN-1",{parentKey:null,title:"支付主需求",type:"产品功能需求",status:"已发版"}),child("DEV-1"),child("DESIGN-1",{type:"系统设计",assignee:"设计乙"}),child("DONE-1",{status:"已完成"}),child("VOID-1",{status:"已作废"}),child("LINKED-1"),child("QA-1",{type:"功能测试"}),child("ORPHAN-1",{parentKey:"MISSING-1"}),
]};
const tasks=[{id:"task-1",jiraKey:"LINKED-1",title:"已有执行任务",status:"blocked",runStatus:"failed",updatedAt:"2026-10-26"}];
let cleanup: (()=>void)|undefined;
afterEach(()=>{cleanup?.();cleanup=undefined;});
function mount(overrides:Partial<Parameters<typeof DeliveryWorkDispatch>[0]>={}) {
 const node=document.createElement("div");document.body.append(node);const root=createRoot(node);
 flushSync(()=>root.render(<DeliveryWorkDispatch plan={plan} tasks={tasks} admission={null} projectId="project-1" snapshotId="snapshot-1" canManage {...overrides}/>));
 cleanup=()=>{flushSync(()=>root.unmount());node.remove();};
 return {node,click:(text:string)=>{const button=[...node.querySelectorAll("button")].find(b=>b.textContent?.startsWith(text));expect(button).toBeDefined();flushSync(()=>button!.click());}};
}
describe("delivery subtask dispatch",()=>{
 it("shows only supported, unlinked and unfinished children by default without inferring from the main status",()=>{
  const rows=deliveryDispatchRows(plan,tasks);
  expect(rows.filter(r=>matchesDispatchView(r,"pending")).map(r=>r.item.key)).toEqual(["DEV-1","DESIGN-1","ORPHAN-1"]);
  expect(rows.filter(r=>matchesDispatchView(r,"all"))).toHaveLength(7);
  expect(rows.filter(r=>matchesDispatchView(r,"ended")).map(r=>r.item.key)).toEqual(["DONE-1","VOID-1"]);
  expect(sourceWorkEnded("未完成")).toBe(false);expect(sourceWorkEnded("")).toBe(false);expect(sourceWorkEnded(" Cancelled ")).toBe(true);
 });
 it("groups pending work, shows source owner and blocks coding until admission while allowing design",()=>{
  const {node}=mount();expect(node.textContent).toContain("支付主需求");expect(node.textContent).toContain("来源未返回主工单详情");expect(node.textContent).toContain("设计乙");expect(node.textContent).not.toContain("DONE-1 标题");
  expect(node.textContent).toContain("编码待准入核验");const dispatch=[...node.querySelectorAll('a[href^="/jira-intake?"]')];expect(dispatch).toHaveLength(1);expect(dispatch[0]?.getAttribute("href")).toContain("jiraKey=DESIGN-1");
 });
 it("shows history and unsupported types without a new dispatch action and uses existing task links for linked work",()=>{
  const {node,click}=mount();click("全部子单");expect(node.textContent).toContain("DONE-1 标题");expect(node.textContent).toContain("来源已结束，不派发");expect(node.textContent).toContain("此类型暂不支持从此处派发");
  click("已接入");expect(node.textContent).toContain("已有执行任务");expect(node.textContent).toContain("任务：存在阻塞 · 运行：运行失败");expect(node.querySelector('a[href="/issues/task-1"]')).not.toBeNull();expect(node.querySelector('a[href^="/jira-intake?"]')).toBeNull();
 });
 it("filters source status exactly within the selected scope and retains the parent group",()=>{
  const {node}=mount();
  flushSync(()=>node.querySelector<HTMLButtonElement>('button[aria-label="子工单来源状态"]')!.click());
  flushSync(()=>document.querySelector<HTMLInputElement>('input[aria-label="子工单来源状态：已完成"]')!.click());
  expect(node.querySelectorAll("tbody tr")).toHaveLength(1);expect(node.textContent).toContain("DONE-1 标题");expect(node.textContent).toContain("支付主需求");expect(node.textContent).not.toContain("VOID-1 标题");expect(node.querySelector('a[href^="/jira-intake?"]')).toBeNull();
 });
 it("does not lose older linked runs or offer a second dispatch when a task is cancelled",()=>{
  const both=[...tasks,{...tasks[0]!,id:"task-2",status:"cancelled",runStatus:"cancelled"}];
  expect(deliveryDispatchRows(plan,both).find(r=>r.item.key==="LINKED-1")?.linked).toHaveLength(2);
  const {node,click}=mount({tasks:both});click("已接入");expect(node.querySelector('a[href="/issues/task-2"]')).not.toBeNull();expect(node.textContent).toContain("查看任务记录");expect(node.querySelector('a[href^="/jira-intake?"]')).toBeNull();
 });
 it("respects manage access and offers an explicit empty state",()=>{
  const {node}=mount({canManage:false,plan:{...plan,items:[child("DESIGN-1",{type:"系统设计"})]}});expect(node.textContent).toContain("需管理员安排执行");expect(node.querySelector('a[href^="/jira-intake?"]')).toBeNull();
 });
 it("explains an empty pending scope and lets the user inspect all historical children",()=>{
  const {node,click}=mount({plan:{...plan,items:[child("DONE-1",{status:"已完成"})]}});expect(node.textContent).toContain("暂无待安排的设计或编码子单");click("查看全部子单");expect(node.textContent).toContain("DONE-1 标题");
 });
});
