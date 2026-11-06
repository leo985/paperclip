// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { BUILTIN_DELIVERY_TEMPLATE, type DeliveryChainAdmission } from "@paperclipai/shared";
import { DeliveryChainAdmissionPanel } from "./DeliveryChainAdmissionPanel";
vi.mock("@/context/CompanyContext",()=>({useCompany:()=>({selectedCompany:null})}));
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT:boolean }).IS_REACT_ACT_ENVIRONMENT=true;
let root:Root,node:HTMLDivElement;
afterEach(async()=>{await act(async()=>root?.unmount());node?.remove();});
async function render(admission:DeliveryChainAdmission){
  node=document.createElement("div");document.body.append(node);root=createRoot(node);
  await act(async()=>root.render(<MemoryRouter><DeliveryChainAdmissionPanel admission={admission}/></MemoryRouter>));
}
describe("chain entry admission presentation",()=>{
  it("shows the configured start node and each objective check result",async()=>{
    await render({state:"blocked",ready:false,template:BUILTIN_DELIVERY_TEMPLATE,startStage:"analysis",checks:[{key:"title",label:"条目标题已填写",passed:true},{key:"owner",label:"需求拆分人员已指定",passed:false}],reasons:["需求拆分人员已指定：未满足"]});
    expect(node.textContent).toContain("开始节点：需求分析");
    expect(node.textContent).toContain("已满足 · 条目标题已填写");
    expect(node.textContent).toContain("未满足 · 需求拆分人员已指定");
    expect(node.querySelector("a")?.getAttribute("href")).toBe("/delivery-chain");
  });
  it("does not offer to re-admit a chain that has already started",async()=>{
    await render({state:"admitted",ready:true,template:null,startStage:null,checks:[],reasons:["条目已进入交付链；后续阶段条件与阻塞在对应阶段核验"]});
    expect(node.textContent).toContain("交付链准入 · 已准入");
    expect(node.querySelector("form")).toBeNull();
  });
});
