// @vitest-environment jsdom
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Project } from "@paperclipai/shared";
import { Dsp7JiraIntake } from "./Dsp7JiraIntake";
const mock=vi.hoisted(()=>({matching:vi.fn(),agents:vi.fn(),registry:vi.fn(),verify:vi.fn(),preview:vi.fn(),create:vi.fn()}));
vi.mock("@/hooks/useManagementAccess",()=>({useManagementAccess:()=>({canOperate:true,loading:false})}));
vi.mock("../api/delivery-workflows",()=>({deliveryWorkflowApi:{seats:mock.matching}}));
vi.mock("../api/agents",()=>({agentsApi:{list:mock.agents}}));
vi.mock("../api/dsp7-seats",()=>({dsp7SeatsApi:{list:mock.registry,verify:mock.verify,previewIntake:mock.preview}}));
vi.mock("../api/issues",()=>({issuesApi:{create:mock.create}}));
vi.mock("../lib/router",()=>({Link:({to,children}:any)=><a href={to}>{children}</a>}));
vi.mock("./SeatStartupProgress",()=>({SeatStartupProgress:()=>null}));
vi.mock("./JiraIntakeSourceStatus",()=>({JiraIntakeSourceStatus:()=>null}));
const project={id:"project",companyId:"company"} as Project;
const agent=(id:string)=>({id,name:id,status:"idle",adapterConfig:{dsp7WebJiraIntake:true,dsp7Seat:{name:id}}});
const seat=(id:string)=>({agentId:id,name:id,usable:true,online:false,environmentName:"本机",runtime:{revision:1},dispatch:{projectId:"project"},presence:{capabilities:["platform-dispatch-v1"]}});
const match=(id:string,key="DEV-1")=>({id,jiraKeys:[key]});
let node:HTMLDivElement,root:Root,client:QueryClient;
function render(props:Partial<Parameters<typeof Dsp7JiraIntake>[0]>={}) { flushSync(()=>root.render(<QueryClientProvider client={client}><Dsp7JiraIntake project={project} initialJiraKey="DEV-1" snapshotId="snapshot" {...props}/></QueryClientProvider>)); }
async function ready(){await vi.waitFor(()=>expect(mock.registry).toHaveBeenCalled());await vi.waitFor(()=>expect(node.textContent).not.toContain("正在按 Jira 工单负责人匹配席位"));}
beforeEach(()=>{vi.clearAllMocks();localStorage.clear();mock.agents.mockResolvedValue([agent("owner-seat"),agent("other-person")]);mock.registry.mockResolvedValue([seat("owner-seat"),seat("other-person")]);mock.matching.mockResolvedValue([match("owner-seat")]);client=new QueryClient({defaultOptions:{queries:{retry:false},mutations:{retry:false}}});node=document.createElement("div");document.body.append(node);root=createRoot(node);});
afterEach(()=>{flushSync(()=>root.unmount());client.clear();node.remove();});
describe("Jira intake owner seat default",()=>{
 it("autoselects the unique assignee seat without requiring a select and does not start a task",async()=>{
  render();await ready();await vi.waitFor(()=>expect(node.textContent).toContain("已按工单负责人自动匹配执行席位：owner-seat"));
  expect(mock.matching).toHaveBeenCalledWith("company","snapshot",["DEV-1"]);
  expect(node.querySelector('select[aria-label="执行席位"]')).toBeNull();
  expect(node.querySelector<HTMLButtonElement>('button[type="submit"]')?.disabled).toBe(false);
  expect(mock.verify).not.toHaveBeenCalled();expect(mock.create).not.toHaveBeenCalled();
 });
 it("offers only the current assignee's seats when several match",async()=>{
  mock.agents.mockResolvedValue([agent("owner-seat"),agent("owner-second"),agent("other-person")]);mock.registry.mockResolvedValue([seat("owner-seat"),seat("owner-second"),seat("other-person")]);mock.matching.mockResolvedValue([match("owner-seat"),match("owner-second")]);
  render();await ready();await vi.waitFor(()=>expect(node.querySelectorAll('select[aria-label="执行席位"] option')).toHaveLength(3));
  expect([...node.querySelectorAll('select[aria-label="执行席位"] option')].map(o=>(o as HTMLOptionElement).value)).toEqual(["","owner-seat","owner-second"]);
  expect(node.querySelector<HTMLButtonElement>('button[type="submit"]')?.disabled).toBe(true);
 });
 it.each(["empty","error","wrong-project","invalid-registration"])("fails clearly without selecting someone else (%s)",async(mode)=>{
  if(mode==="empty")mock.matching.mockResolvedValue([]);
  if(mode==="error")mock.matching.mockRejectedValue(new Error("Jira 不可用"));
  if(mode==="wrong-project")mock.registry.mockResolvedValue([{...seat("owner-seat"),dispatch:{projectId:"other"}}]);
  if(mode==="invalid-registration")mock.registry.mockResolvedValue([{...seat("owner-seat"),usable:false}]);
  render();await ready();await vi.waitFor(()=>expect(node.querySelector<HTMLButtonElement>('button[type="submit"]')?.disabled).toBe(true));
  expect(node.textContent).toContain(mode==="error"?"负责人席位匹配失败":mode==="invalid-registration"?"已按工单负责人自动匹配执行席位":"工单负责人未配置");
  expect(mock.create).not.toHaveBeenCalled();
 });
 it("rechecks the current assignee on confirmation and blocks a changed binding",async()=>{
  render();await ready();await vi.waitFor(()=>expect(node.textContent).toContain("自动匹配执行席位：owner-seat"));mock.matching.mockResolvedValue([match("other-person")]);
  flushSync(()=>node.querySelector('form')!.dispatchEvent(new Event("submit",{bubbles:true,cancelable:true})));
  await vi.waitFor(()=>expect(node.textContent).toContain("Jira 工单负责人或席位配置已变化"));
  expect(mock.verify).not.toHaveBeenCalled();expect(mock.create).not.toHaveBeenCalled();
 });
 it("clears a manual choice when the Jira key changes and matches the new owner",async()=>{
  mock.matching.mockResolvedValue([match("owner-seat"),match("other-person")]);render();await ready();await vi.waitFor(()=>expect(node.querySelector('select')).not.toBeNull());
  const select=node.querySelector('select')!;flushSync(()=>{select.value="owner-seat";select.dispatchEvent(new Event("change",{bubbles:true}));});
  mock.matching.mockResolvedValue([match("other-person","DEV-2")]);const input=node.querySelector<HTMLInputElement>('input[placeholder="ATSES-XXXXX"]')!;
  flushSync(()=>{Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,"value")!.set!.call(input,"DEV-2");input.dispatchEvent(new Event("input",{bubbles:true}));});
  await vi.waitFor(()=>expect(node.textContent).toContain("自动匹配执行席位：other-person"));expect(node.querySelector('select')).toBeNull();
 });
 it("preserves explicit seat entry points without owner auto-routing",async()=>{
  render({initialSeatId:"other-person"});await vi.waitFor(()=>expect(node.querySelector('select')?.value).toBe("other-person"));expect(mock.matching).not.toHaveBeenCalled();
 });
});
