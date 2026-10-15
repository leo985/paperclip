import { useQuery } from "@tanstack/react-query";
import { instanceSettingsApi } from "@/api/instanceSettings";
import { queryKeys } from "@/lib/queryKeys";
import { useCompany } from "@/context/CompanyContext";
import { useDialogActions } from "@/context/DialogContext";
import { Button } from "@/components/ui/button";
import { SmokeLabDashboardCard } from "@/components/SmokeLabDashboardCard";
import { useEffect } from "react";
import { Link } from "@/lib/router";
import { useBreadcrumbs } from "@/context/BreadcrumbContext";
import { useManagementAccess } from "@/hooks/useManagementAccess";
const groups = [
  { title: "人员与权限", description: "组织成员、邀请和人员联邦", links: [["组织成员与权限", "/company/settings/members"], ["人员联邦", "/company/settings/personnel", "instance"], ["实例访问权限", "/company/settings/instance/access", "instance"]] },
  { title: "项目与执行配置", description: "项目仓库、执行身份及运行通道", links: [["项目与仓库", "/projects"], ["执行智能体", "/agents/all"], ["执行环境", "/company/settings/instance/environments", "instance"], ["组织设置", "/company/settings"]] },
  { title: "用量与审计", description: "组织费用、预算和操作记录", links: [["用量与费用", "/costs"], ["审计记录", "/activity"], ["运行诊断", "/dashboard/live"]] },
  { title: "高级管理", description: "按需使用；当前研发主流程由 Jira 与 Harness 承担", links: [["公共协作技能", "/skills"], ["连接器", "/apps"], ["例行任务", "/routines"], ["目标", "/goals"], ["交付产物", "/artifacts"], ["工作区", "/workspaces"], ["流水线", "/pipelines"], ["实验案例", "/cases"], ["实验状态看板", "/status"], ["智能体会议室", "/board-chat"], ["凭据", "/company/settings/secrets"], ["组织导入", "/company/import"], ["组织导出", "/company/export"], ["实验开关", "/company/settings/instance/experimental", "instance"], ["插件", "/company/settings/instance/plugins", "instance"]] },
];
export function ManagementCenter() {
  const { setBreadcrumbs } = useBreadcrumbs(); const { isInstanceAdmin } = useManagementAccess();
  const { selectedCompanyId } = useCompany();
  const { openNewIssue, openOnboarding } = useDialogActions();
  const flags = useQuery({ queryKey: queryKeys.instance.experimentalSettings, queryFn: instanceSettingsApi.getExperimental });
  const featureByPath: Record<string, keyof NonNullable<typeof flags.data>> = { "/apps": "enableApps", "/goals": "enableGoalsSidebarLink", "/workspaces": "enableIsolatedWorkspaces", "/pipelines": "enablePipelines", "/cases": "enableCases", "/status": "enableStatusCards", "/board-chat": "enableConferenceRoomChat" };
  useEffect(() => setBreadcrumbs([{ label: "管理中心" }]), [setBreadcrumbs]);
  return <div className="space-y-5"><header><h1 className="text-2xl font-semibold">管理中心</h1><p className="mt-2 text-sm text-muted-foreground">日常入口保持简洁，高级能力按权限与原有开关开放。</p></header><div className="flex flex-wrap gap-2"><Button variant="outline" onClick={() => openNewIssue()}>自由创建平台任务</Button>{isInstanceAdmin && <Button variant="outline" onClick={() => openOnboarding()}>创建组织 / 初始化</Button>}</div><div className="grid gap-4 md:grid-cols-2">{groups.map(group => <section key={group.title} className="space-y-3 rounded-xl border border-border bg-card p-5"><h2 className="font-semibold">{group.title}</h2><p className="text-sm text-muted-foreground">{group.description}</p><div className="flex flex-wrap gap-2">{group.links.filter(link => (link[2] !== "instance" || isInstanceAdmin) && (!featureByPath[link[1]!] || flags.data?.[featureByPath[link[1]!]!] === true)).map(([label, to]) => <Link key={to} to={to} className="rounded-lg border border-border px-3 py-2 text-sm hover:bg-accent">{label}</Link>)}</div></section>)}</div>{selectedCompanyId && <SmokeLabDashboardCard companyId={selectedCompanyId} />}</div>;
}
