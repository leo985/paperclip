// @vitest-environment jsdom
import {act} from "react";
import {createRoot} from "react-dom/client";
import {QueryClient,QueryClientProvider} from "@tanstack/react-query";
import {afterEach,expect,it,vi} from "vitest";
import {DeliveryWorkflowTaskLink} from "./DeliveryWorkflowTaskLink";
const mocks=vi.hoisted(()=>({read:vi.fn()}));
vi.mock("@/api/delivery-workflows",()=>({deliveryWorkflowApi:{forTask:mocks.read}}));
vi.mock("@/lib/router",()=>({Link:({to,children}:any)=><a href={to}>{children}</a>}));
Object.assign(globalThis,{IS_REACT_ACT_ENVIRONMENT:true});
let cleanup=()=>{};afterEach(()=>cleanup());
async function mount(){const node=document.createElement('div');document.body.append(node);const root=createRoot(node),client=new QueryClient({defaultOptions:{queries:{retry:false}}});cleanup=()=>{root.unmount();client.clear();node.remove();};await act(async()=>{root.render(<QueryClientProvider client={client}><DeliveryWorkflowTaskLink companyId="company" taskId="task"/></QueryClientProvider>);});return node;}
it("links an assigned human action to the exact instance node",async()=>{
 mocks.read.mockResolvedValue({workflowId:'flow',demandNo:'ENTRY-1',stage:{taskId:'task',stage:'design',executionMode:'human',state:'review'},href:'/delivery?snapshotId=snapshot&taskId=task#delivery-node-task',actions:[{actionLabel:'提交人工交付'}]});
 const node=await mount();await vi.waitFor(()=>expect(node.textContent).toContain('提交人工交付'));
 expect(node.textContent).toContain('待人工办理');expect(node.querySelector('a')?.href).toContain('#delivery-node-task');
});
it("shows a read-only waiting node and surfaces lookup errors",async()=>{
 mocks.read.mockResolvedValue({workflowId:'flow',demandNo:'ENTRY-1',stage:{taskId:'task',stage:'coding',state:'pending'},href:'/delivery#delivery-node-task',actions:[]});
 const node=await mount();await vi.waitFor(()=>expect(node.textContent).toContain('等待前置条件'));expect(node.querySelector('a')?.textContent).toBe('查看交付链节点与前置');
});
