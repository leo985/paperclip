import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { Issue } from "@paperclipai/shared";
vi.mock("@/lib/router",()=>({Link:({to,children,...props}:{to:string;children:React.ReactNode})=><a href={to} {...props}>{children}</a>,useNavigate:()=>vi.fn()}));
import { JiraRequirementPanel } from "./JiraRequirementPanel";
const item=(key:string,mode:string)=>({key,summary:"真实子工单",issueType:mode==="harness-linked"?"代码评审":"功能测试",status:"待受理",done:false,assignee:{login:"dev",name:"负责人",email:null},mode,skill:null,note:"执行说明",userId:"user",seats:[]});
function render(children:unknown[],url="http://jira.example.com") {
  const meta={version:1,key:"ATSES-1",summary:"主需求",owner:{login:"rd",name:"研发负责人",email:null},ownerUserId:"rd",children,jiraBaseUrl:url,connectionSeatId:"seat"};
  const task={id:"root",companyId:"company",description:`<!-- DSP7-REQUIREMENT ${JSON.stringify(meta)} -->`} as Issue;
  const cache=new QueryClient();cache.setQueryData(["jira-requirement-children","company","root"],children.map((child:any)=>({id:child.key,companyId:"company",originId:url+":"+child.key,status:"backlog"})));cache.setQueryData(["dsp7-registered-seats","company"],[]);
  return renderToStaticMarkup(<QueryClientProvider client={cache}><JiraRequirementPanel issue={task}/></QueryClientProvider>);
}
describe("requirement overview UI",()=>{
  it("does not offer another dispatch for linked code review",()=>{
    const html=render([item("ATSES-2","harness-linked")]);expect(html).toContain("随编码交付，不另派单");expect(html).toContain("无需再次派发");expect(html).not.toContain("派单并执行");expect(html).toContain("待接入");
  });
  it("keeps QA visible and states unavailable runtime support",()=>{
    const html=render([item("ATSES-3","qa")]);expect(html).toContain("测试 Harness");expect(html).toContain("尚未提供 QA 执行通道");expect(html).not.toContain("派单并执行");
  });
  it("ignores malformed or unsafe editable metadata",()=>{
    expect(render([{mode:"invented"}])).toBe("");expect(render([],"javascript:alert(1)")).toBe("");
  });
});
