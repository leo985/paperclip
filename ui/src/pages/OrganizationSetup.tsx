import { useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { accessApi } from "@/api/access";
import { projectsApi } from "@/api/projects";
import { dsp7SeatsApi } from "@/api/dsp7-seats";
import { useCompany } from "@/context/CompanyContext";
import { useBreadcrumbs } from "@/context/BreadcrumbContext";
import { useDialogActions } from "@/context/DialogContext";
import { useManagementAccess } from "@/hooks/useManagementAccess";
import { queryKeys } from "@/lib/queryKeys";
import { Link } from "@/lib/router";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";

export function OrganizationSetup() {
  const { selectedCompanyId: id, selectedCompany } = useCompany();
  const { canManage, isInstanceAdmin, loading } = useManagementAccess();
  const { setBreadcrumbs } = useBreadcrumbs();
  const { openNewAgent } = useDialogActions();
  const enabled = !!id && canManage;
  const members = useQuery({ queryKey: queryKeys.access.companyMembers(id ?? ""), queryFn: () => accessApi.listMembers(id!), enabled, staleTime: 30000, retry: false });
  const projects = useQuery({ queryKey: queryKeys.projects.list(id ?? ""), queryFn: () => projectsApi.list(id!), enabled, staleTime: 30000, retry: false });
  const seats = useQuery({ queryKey: ["dsp7-registered-seats", id], queryFn: () => dsp7SeatsApi.list(id!), enabled, staleTime: 30000, retry: false });
  useEffect(() => { setBreadcrumbs([{ label: "组织初始化" }]); }, [setBreadcrumbs]);
  if (loading) return <p className="text-sm text-muted-foreground">正在核验组织权限…</p>;
  if (!canManage) return <Card className="space-y-3 p-4"><h1 className="font-semibold">组织初始化</h1><p className="text-sm">此清单由组织管理员配置。研发人员可到席位页查看自己的电脑。</p><Button asChild><Link to="/seats">打开我的席位</Link></Button></Card>;
  const activeMembers = members.data?.members.filter(m => m.status === "active") ?? [];
  const repos = (projects.data ?? []).filter(p => !p.archivedAt && p.status !== "cancelled").flatMap(p => p.workspaces.filter(w => w.repoUrl && (w.repoRef || w.defaultRef)).map(w => ({ projectId: p.id, workspaceId: w.id })));
  const registered = (seats.data ?? []).filter(s => s.owner && s.runtime);
  const ready = registered.filter(s => s.usable && s.dispatch?.enabled && s.dispatch.jiraPatConfigured && s.dispatch.jiraAssignee && s.dispatch.readyStatuses.length && s.dispatch.issueTypes.length && repos.some(r => r.projectId === s.dispatch!.projectId && r.workspaceId === s.dispatch!.workspaceId));
  const notifications = ready.filter(s => s.policy.dingtalk?.botId && s.policy.dingtalk.userId);
  const rows = [
    { title: "添加或同步研发人员", done: activeMembers.length > 1, pending: members.isPending, error: members.isError, detail: members.data ? `当前 ${activeMembers.length} 位已启用成员${activeMembers.length <= 1 ? "，请按需添加研发人员或配置人员联邦。" : "；可继续同步或邀请团队成员。"}` : "读取组织成员", actions: [{ label: "管理成员", to: "/company/settings/members" }, ...(isInstanceAdmin ? [{ label: "人员联邦", to: "/company/settings/instance/personnel" }] : [])] },
    { title: "配置项目与共享仓库", done: repos.length > 0, pending: projects.isPending, error: projects.isError, detail: `已配置 ${repos.length} 个包含仓库 URL 和基线分支的工作区。初始化示例项目不等于业务仓库。`, actions: [{ label: "配置项目仓库", to: "/projects" }] },
    { title: "接入研发电脑并指定负责人", done: registered.length > 0, pending: seats.isPending, error: seats.isError, detail: `已登记 ${registered.length} 个有负责人和设备信息的席位，其中 ${registered.filter(s => s.online).length} 个在线。接入流程会登记执行智能体并复用电脑上的 Claude 配置。`, actions: [{ label: "接入或管理席位", to: "/seats?view=admin" }] },
    { title: "配置 Jira 接单规则", done: ready.length > 0, pending: seats.isPending || projects.isPending, error: seats.isError || projects.isError, detail: `${ready.length} 个席位已启用规则，并配置 PAT、Jira 统计账号、工单状态、类型及有效项目仓库。仍需本机绑定仓库、在线空闲，并逐单核验 Jira。`, actions: [{ label: "配置席位接单范围", to: "/seats" }] },
    { title: "配置阻塞通知（推荐）", done: notifications.length > 0, pending: seats.isPending || projects.isPending, error: seats.isError || projects.isError, detail: `${notifications.length} 个已配置接单的席位选择了钉钉机器人和接收人。这里只核对配置，不代表消息已送达；建议另行验证通知。`, actions: [{ label: "配置席位通知", to: "/seats" }] },
  ];
  const complete = rows.filter(r => r.done && !r.error).length;
  const refreshing = members.isFetching || projects.isFetching || seats.isFetching;
  return <div className="space-y-5">
    <header className="space-y-3"><p className="text-sm text-primary">智研协同平台 · 组织配置</p><h1 className="text-2xl font-semibold">{selectedCompany?.name} · 初始化清单</h1><p className="text-sm text-muted-foreground">组织已创建。以下步骤可分次完成，离开页面不会删除组织或已保存的配置。已有组织、席位和历史任务均可继续使用。</p><div className="flex flex-wrap items-center justify-between gap-3"><p className="text-sm">已完成 {complete} / {rows.length} 项配置 · 通知为推荐项，不作为开工门禁</p><Button variant="outline" disabled={refreshing} onClick={() => { void members.refetch(); void projects.refetch(); void seats.refetch(); }}>{refreshing ? "正在检查…" : "重新检查配置"}</Button></div></header>
    {selectedCompany?.requireBoardApprovalForNewAgents && <Card className="space-y-2 p-4"><h2 className="font-medium">此组织启用了新智能体审批</h2><p className="text-sm text-muted-foreground">快速接入席位会受到该策略限制，请先由管理员核对组织审批策略，不会自动关闭审批。</p><Button asChild variant="outline"><Link to="/company/settings">查看组织设置</Link></Button></Card>}
    <ol className="space-y-3">{rows.map((row, index) => <li key={row.title}><Card className="space-y-3 p-4"><div className="flex flex-wrap items-center justify-between gap-2"><h2 className="font-semibold">{index + 1}. {row.title}</h2><span className={row.error ? "text-sm text-destructive" : "text-sm text-muted-foreground"}>{row.error ? "状态未知" : row.pending ? "检查中" : row.done ? "已配置" : "待配置"}</span></div><p className="text-sm text-muted-foreground">{row.error ? "配置读取失败，不能据此判断是否完成。请重新检查，或进入对应页面核对权限和配置。" : row.detail}</p><div className="flex flex-wrap gap-2">{row.actions.map(action => <Button key={action.to} asChild variant="outline" size="sm"><Link to={action.to}>{action.label}</Link></Button>)}</div></Card></li>)}</ol>
    <Card className="space-y-3 p-4"><h2 className="font-semibold">配置完成后如何开工？</h2><p className="text-sm text-muted-foreground">管理员从项目页或 Jira 接入页明确派单。席位登录上线后，满足规则且空闲时自动执行；需求与联调环境确认、独占执行和交付门禁仍然生效。初始化清单不会发起模型调用或创建示例任务。</p><div className="flex flex-wrap gap-2"><Button asChild><Link to="/dashboard">进入协同工作台</Link></Button><Button asChild variant="outline"><Link to="/jira-intake">接入 Jira 工单</Link></Button></div></Card>
    <details className="rounded-md border border-border p-4"><summary className="cursor-pointer text-sm font-medium">高级：独立通用智能体</summary><p className="my-3 text-sm text-muted-foreground">服务器助手或独立分析智能体可在这里添加。个人研发电脑应走席位接入流程；旧的独立智能体不会自动绑定电脑，也不会被本次调整删除或停用。</p><Button variant="outline" onClick={openNewAgent}>添加通用智能体</Button></details>
  </div>;
}
