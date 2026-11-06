// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import { api } from "@/api/client";
import { PersonnelFederation } from "./PersonnelFederation";
const company=vi.hoisted(()=>({selectedCompanyId:"organization-b",companies:[{id:"organization-a",name:"研发一组"},{id:"organization-b",name:"研发二组"}]}));
vi.mock("@/context/CompanyContext",()=>({useCompany:()=>company}));
vi.mock("@/api/client",()=>({api:{get:vi.fn(),post:vi.fn()}}));
(globalThis as typeof globalThis & {IS_REACT_ACT_ENVIRONMENT:boolean}).IS_REACT_ACT_ENVIRONMENT=true;
let root:Root,container:HTMLDivElement,cache:QueryClient;
async function render(){
 container=document.createElement("div");document.body.append(container);cache=new QueryClient({defaultOptions:{queries:{retry:false}}});root=createRoot(container);
 vi.mocked(api.get).mockResolvedValue({sources:[],departments:[],existingAccounts:[],people:[{id:"shared-person",sourceId:"source-from-a",name:"共享研发人员",username:"developer",email:null,departmentIds:[],active:true,userId:"existing-account",loginConfigured:true}]});
 await act(async()=>root.render(<QueryClientProvider client={cache}><PersonnelFederation/></QueryClientProvider>));
 await act(async()=>{await new Promise(resolve=>setTimeout(resolve,0));});
}
afterEach(async()=>{await act(async()=>root?.unmount());container?.remove();cache?.clear();vi.clearAllMocks();});
describe("shared personnel management",()=>{
 it("loads the instance directory while an unrelated organization is selected",async()=>{
  await render();expect(api.get).toHaveBeenCalledWith("/instance/personnel-federation");expect(container.textContent).toContain("共享研发人员");expect(api.post).not.toHaveBeenCalled();
 });
 it("adds an existing directory identity to the selected organization without resynchronizing it",async()=>{
  await render();vi.mocked(api.post).mockResolvedValue({ok:true});
  const button=[...container.querySelectorAll("button")].find(button=>button.textContent==="加入组织")!;
  await act(async()=>button.click());
  expect(api.post).toHaveBeenCalledWith("/instance/personnel-federation/people/shared-person/membership",{companyId:"organization-b"});
  expect(vi.mocked(api.post).mock.calls).toHaveLength(1);
 });
});

describe("initialized account repair",()=>{
 it("shows repair for generated initialized accounts and requires reason plus identity confirmation",async()=>{
  await render();
  vi.mocked(api.get).mockResolvedValue({sources:[],departments:[],existingAccounts:[{id:"original",name:"李巍",email:"liw2386@fingard.com"}],people:[{id:"shared-person",sourceId:"source",name:"李巍",username:"liw2386@fingard.com",departmentIds:[],active:true,userId:"generated",managedAccount:true,loginConfigured:true}]});
  await act(async()=>{await cache.invalidateQueries();await new Promise(resolve=>setTimeout(resolve,0));});
  const repair=[...container.querySelectorAll("button")].find(b=>b.textContent==="重新关联账号")!;
  expect(repair).toBeTruthy();
  await act(async()=>repair.click());
  const dialog=document.querySelector('[role="dialog"]')!;
  expect(dialog.textContent).toContain("generated");
  expect(dialog.textContent).toContain("不会合并或转移");
  const submit=[...dialog.querySelectorAll("button")].find(b=>b.textContent==="确认重新关联")!;
  expect(submit.disabled).toBe(true);
  const select=dialog.querySelector("select")!;
  const reason=dialog.querySelector("input:not([type=checkbox])")!;
  await act(async()=>{
   select.value="original";select.dispatchEvent(new Event("change",{bubbles:true}));
   Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,"value")!.set!.call(reason,"已核对同一人的原网站账号");
   reason.dispatchEvent(new Event("input",{bubbles:true}));
  });
  expect(submit.disabled).toBe(true);
  await act(async()=>{(dialog.querySelector("input[type=checkbox]") as HTMLInputElement).click();});
  expect(submit.disabled).toBe(false);
  vi.mocked(api.post).mockResolvedValue({ok:true});
  await act(async()=>submit.click());
  expect(api.post).toHaveBeenCalledWith("/instance/personnel-federation/people/shared-person/relink",{userId:"original",expectedUserId:"generated",reason:"已核对同一人的原网站账号",confirm:true});
 });
});
