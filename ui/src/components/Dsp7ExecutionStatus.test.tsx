import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { describe, expect, it, vi } from "vitest";
import { Dsp7ExecutionStatus } from "./Dsp7ExecutionStatus";
vi.mock("../hooks/useManagementAccess", () => ({ useManagementAccess: () => ({ canManage: true, loading: false }) }));
function render(phase:string,eligible=true,authorized=false,canRetryStartup=true) {
 const cache=new QueryClient();
 cache.setQueryData(["platform-dispatch","company","seat","task"],{phase,authorized,message:null,canRetryStartup,retryStartupBlockedReason:canRetryStartup?null:"工单仍有活动运行，不能重复启动"});
 cache.setQueryData(["jira-intake-source","company","seat","task"],{jiraKey:"ATSES-513404",summary:"测试",status:"修复中",issueType:"线上问题",assignee:"zhangzl",checkedAt:new Date().toISOString(),eligible,reasons:eligible?[]:["状态不在允许开工范围"]});
 return renderToStaticMarkup(<QueryClientProvider client={cache}><Dsp7ExecutionStatus issue={{id:"task",companyId:"company",description:'<!-- DSP7-JIRA-INTAKE {"seat_id":"seat"} -->'}}/></QueryClientProvider>);
}
describe("intake task source and dispatch controls",()=>{
 it("shows source refresh and dispatch on a pending intake",()=>{const html=render("registered_only");expect(html).toContain("同步 Jira 状态");expect(html).toContain("zhangzl");expect(html).toContain("派单并执行");expect(html).not.toMatch(/ disabled=""[^>]*>派单并执行/);});
 it("disables dispatch while the fresh source is ineligible",()=>{const html=render("registered_only",false);expect(html).toContain("状态不在允许开工范围");expect(html).toMatch(/ disabled=""[^>]*>派单并执行/);});
 it("offers explicit retry after a failed startup",()=>{expect(render("startup_failed",true,true)).toContain("重试启动");});
 it("blocks retry until the server confirms the previous execution stopped",()=>{const html=render("startup_failed",true,true,false);expect(html).toContain("工单仍有活动运行，不能重复启动");expect(html).toMatch(/ disabled=""[^>]*>重试启动/);});
 it("offers admin revocation for blocked or ended-session tasks, but not terminal tasks",()=>{
   expect(render("blocked",true,true)).toContain("撤销本次执行");
   expect(render("interrupted",true,true)).toContain("撤销本次执行");
   expect(render("done",true,true)).not.toContain("撤销本次执行");
   expect(render("cancelled",true,true)).not.toContain("撤销本次执行");
 });
 it("never offers new dispatch for completed or running work",()=>{expect(render("done")).not.toContain("派单并执行");expect(render("running",true,true)).not.toContain("派单并执行");});
});
