import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { DeliveryOnlineSource } from "./DeliveryOnlineSource";
function render(configured: boolean, seats: unknown[] = []) {
  const cache = new QueryClient();
  cache.setQueryData(["delivery-connection", "company", "project"], configured ? { id: "source", revision: 1, jiraAgentId: null, jiraBaseUrl:"http://jira.fingard.com:6001", jiraCredentialsConfigured:true,jiraConnectionMode:"project", organizationId: "123", credentialsConfigured: true, lastCheckStatus: "authentication_required" } : null);
  cache.setQueryData(["delivery-source-agents", "company"], seats);
  return renderToStaticMarkup(<QueryClientProvider client={cache}><DeliveryOnlineSource companyId="company" projectId="project" onPlan={() => {}} /></QueryClientProvider>);
}
describe("delivery online source UI", () => {
  it("makes first-time setup and missing project connections actionable", () => {
    const html = render(false);expect(html).toContain("首次配置需要填写轻舟账号和密码");expect(html).toContain("项目 Jira 连接");expect(html).toContain("Jira PAT");expect(html).not.toContain("Jira 连接席位");expect(html).toContain("保存并查看组织条目");expect(html).toContain("更多操作");expect(html).toContain("补录指定条目");expect(html).not.toContain("排期查询范围");expect(html).toContain("轻舟排期组织");expect(html).toContain("读取组织");expect(html).not.toContain("轻舟组织编号");expect(html).not.toContain("派单并执行");
  });
  it("explains retained encrypted credentials and uses project Jira credentials without a seat selector", () => {
    const html = render(true, [{ id: "seat", name: "当前项目席位", adapterConfig: { dsp7Seat: {}, dsp7JiraDispatch: { projectId: "project" } } }, { id: "other", name: "其他项目席位", adapterConfig: { dsp7Seat: {}, dsp7JiraDispatch: { projectId: "other" } } }]);
    expect(html).toContain("已保存加密凭据");expect(html).toContain("需要核对账号凭据");expect(html).not.toContain("当前项目席位");expect(html).not.toContain("其他项目席位");expect(html).toContain('type="password"');
  });
});
