import { useQuery } from "@tanstack/react-query";
import type { DeliveryConnection, Project } from "@paperclipai/shared";
import { api } from "@/api/client";
import { dsp7SeatsApi } from "@/api/dsp7-seats";
import { seatReadiness } from "@/lib/issue-management";
import { Link } from "@/lib/router";
import { Button } from "./ui/button";

export function ProjectReadiness({ project }: { project: Project }) {
  const companyId = project.companyId;
  const connection = useQuery({ queryKey: ["delivery-connection", companyId, project.id], queryFn: () => api.get<DeliveryConnection | null>(`/companies/${companyId}/delivery-connections?projectId=${project.id}`), retry: false });
  const seats = useQuery({ queryKey: ["dsp7-registered-seats", companyId], queryFn: () => dsp7SeatsApi.list(companyId), retry: false });
  const repos = project.workspaces.filter(w => w.repoUrl);
  const baselines = repos.filter(w => w.repoRef || w.defaultRef);
  const bound = seats.data?.filter(s => s.dispatch?.projectId === project.id) ?? [];
  const sourceHref = "/delivery?" + new URLSearchParams({ projectId: project.id, view: "sources" });
  return <section className="space-y-3 rounded-lg border border-border p-4" aria-label="项目接入准备情况">
    <div className="flex flex-wrap items-center justify-between gap-2"><h2 className="font-semibold">项目接入准备情况</h2><Button size="sm" variant="outline" disabled={connection.isFetching || seats.isFetching} onClick={() => { void connection.refetch(); void seats.refetch(); }}>重新检查配置</Button></div>
    <p className="text-xs text-muted-foreground">分别查看配置与实际验证。保存仓库 URL 不代表执行电脑已经能够拉取；本区检查不启动任务。</p>
    <dl className="grid gap-3 md:grid-cols-3"><div className="space-y-2"><dt className="text-sm font-medium">共享仓库与基线</dt><dd className="text-sm">{repos.length} 个仓库 · {baselines.length} 个已配置基线</dd><dd className="text-xs text-muted-foreground">{!repos.length ? "待添加业务仓库。" : baselines.length < repos.length ? "部分仓库缺少基线分支或标签。" : "配置已保存，仓库访问由执行电脑核验。"}</dd><dd><Link className="text-xs underline" to={`/projects/${project.urlKey ?? project.id}/configuration`}>查看仓库配置</Link></dd></div>
      <div className="space-y-2"><dt className="text-sm font-medium">轻舟与 Jira 来源</dt><dd className="text-sm">{connection.isPending ? "检查中" : connection.isError ? "状态读取失败" : !connection.data ? "尚未配置" : connection.data.lastCheckStatus === "verified" ? "来源连接已验证" : connection.data.credentialsConfigured ? "已配置，待连接验证" : "来源凭据待配置"}</dd><dd className="text-xs text-muted-foreground">{connection.isError || connection.isPending ? "连接检查时间待读取。" : connection.data?.lastCheckedAt ? `最近连接检查：${new Date(connection.data.lastCheckedAt).toLocaleString("zh-CN")}` : "尚无连接验证时间。"} 项目 Jira 凭据：{connection.isError || connection.isPending ? "待读取核实" : connection.data?.jiraCredentialsConfigured ? "已配置" : "未配置或使用席位旧配置"}</dd><dd><Link className="text-xs underline" to={sourceHref}>查看来源与连接检查</Link></dd></div>
      <div className="space-y-2"><dt className="text-sm font-medium">执行席位</dt><dd className="text-sm">{seats.isPending ? "检查中" : seats.isError ? "状态读取失败" : `${bound.length} 个绑定席位 · ${bound.filter(s => seatReadiness(s).ready).length} 个接单配置就绪`}</dd><dd className="text-xs text-muted-foreground">{seats.isError || seats.isPending ? "绑定关系尚未核实，请查看席位设置。" : bound.length ? bound.map(s => `${s.name}：${seatReadiness(s).ready ? "待逐单核验" : seatReadiness(s).reasons[0]}`).join("；") : "在席位接单设置中绑定本项目和仓库。"}</dd><dd><Link className="text-xs underline" to="/seats">核对席位、设备与接单规则</Link></dd></div></dl>
    <details className="text-xs text-muted-foreground"><summary className="cursor-pointer">实际开工仍需核验的条件</summary><p className="pt-2">本机仓库映射与访问、基线、模型认证、工单状态、预算、执行锁及交付门禁由原启动流程逐项检查；通知送达需在席位通知设置中实际验证。配置就绪不会授予派单权限。</p></details>
    {(connection.isError || seats.isError) && <p role="alert" className="text-sm text-destructive">部分检查读取失败，不能认定项目可开工，请重新检查或进入对应配置页面。</p>}
  </section>;
}
