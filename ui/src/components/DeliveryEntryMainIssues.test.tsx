// @vitest-environment jsdom
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import type { DeliverySnapshot, DeliveryWorkItem } from "@paperclipai/shared";
import { DeliveryEntryMainIssues } from "./DeliveryEntryMainIssues";
const item=(key:string,parentKey:string|null,title=key):DeliveryWorkItem=>({key,parentKey,title,type:parentKey?"系统设计":"产品功能需求",status:"待受理",assignee:"user123 研发甲",scheduled:true});
const snapshot=(items:DeliveryWorkItem[],mains:DeliverySnapshot["plan"]["mains"]=[]):DeliverySnapshot=>({id:"snapshot",demandNo:"LYYL-00021",plan:{items,mains}} as DeliverySnapshot);
let cleanup:()=>void;
afterEach(()=>cleanup?.());
function mount(data:DeliverySnapshot){const node=document.createElement("div"),root=createRoot(node);flushSync(()=>root.render(<DeliveryEntryMainIssues snapshot={data}/>));cleanup=()=>flushSync(()=>root.unmount());return node;}
describe("entry parent issue hierarchy",()=>{
 it("shows the actual parent identity and source facts separately from the entry and children",()=>{
  const node=mount(snapshot([item("ATSES-505103",null,"杭州银行主需求"),item("ATSES-513671","ATSES-505103"),item("ATSES-513674","ATSES-505103")],[{key:"ATSES-505103",title:"旧标题",sourceId:"1"}]));
  expect(node.querySelectorAll("li")).toHaveLength(1);expect(node.querySelector("h3")?.textContent).toBe("ATSES-505103 · 产品功能需求");
  expect(node.textContent).toContain("条目 LYYL-00021 → Jira 主工单 → 各阶段子工单");expect(node.textContent).toContain("杭州银行主需求");expect(node.textContent).not.toContain("旧标题");expect(node.textContent).toContain("来源状态：待受理");expect(node.textContent).toContain("负责人：user123 研发甲");expect(node.textContent).toContain("关联子工单：2 张");
 });
 it("includes all distinct source parents and orphan references without inventing missing facts",()=>{
  const node=mount(snapshot([item("CHILD-1","MAIN-1"),item("CHILD-2","MAIN-2"),item("STANDALONE-1",null)],[{key:"MAIN-1",title:"主需求一",sourceId:"1"},{key:"MAIN-1",title:"重复关联",sourceId:"2"},{key:"MAIN-3",title:"主需求三",sourceId:"3"}]));
  expect(node.querySelectorAll("li")).toHaveLength(3);expect(node.textContent).not.toContain("STANDALONE-1");expect(node.textContent).toContain("主需求一");expect(node.textContent).toContain("来源未返回主工单详情");expect(node.textContent).toContain("来源状态：未提供");expect(node.textContent).toContain("负责人：未提供");expect(node.textContent).toContain("关联子工单：0 张");expect(node.textContent).toContain("请同步来源后核对");
 });
 it("explains an empty main issue source instead of treating the entry as a Jira parent",()=>{
  const node=mount(snapshot([]));expect(node.querySelectorAll("li")).toHaveLength(0);expect(node.textContent).toContain("条目编号不等于 Jira 主工单编号");
 });
});
