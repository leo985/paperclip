import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { projectsApi } from "@/api/projects";
import { useCompany } from "@/context/CompanyContext";
import { useBreadcrumbs } from "@/context/BreadcrumbContext";
import { queryKeys } from "@/lib/queryKeys";
import { Dsp7JiraIntake } from "@/components/Dsp7JiraIntake";
import { Link } from "@/lib/router";
export function JiraIntake() {
  const { selectedCompanyId } = useCompany(); const { setBreadcrumbs } = useBreadcrumbs(); const [id, setId] = useState("");
  const projects = useQuery({ queryKey: queryKeys.projects.list(selectedCompanyId!), queryFn: () => projectsApi.list(selectedCompanyId!), enabled: !!selectedCompanyId });
  const list = projects.data ?? []; const project = list.find(p => p.id === id) ?? (list.length === 1 ? list[0] : undefined);
  useEffect(() => { setBreadcrumbs([{ label: "接入 Jira 工单" }]); setId(""); }, [setBreadcrumbs, selectedCompanyId]);
  return <div className="space-y-5"><h1 className="text-2xl font-semibold">接入 Jira 工单</h1><p className="text-sm text-muted-foreground">日常推荐 Jira 指派后自动执行。此入口用于人工登记已有 Jira 子工单，不创建另一套需求来源。</p><Link to="/seats" className="text-sm text-primary underline">配置自动接单规则</Link>{projects.isPending ? <p>正在加载项目…</p> : projects.isError ? <p role="alert" className="text-destructive">项目加载失败，请刷新重试。</p> : !list.length ? <p>尚未配置项目，请联系管理员配置共享项目与仓库。</p> : <><label className="block space-y-2 text-sm"><span>所属项目</span><select value={project?.id ?? id} onChange={e => setId(e.target.value)} className="block w-full max-w-md rounded-md border border-border bg-background p-2"><option value="">请选择项目</option>{list.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}</select></label>{project && <Dsp7JiraIntake key={project.id} project={project} />}</>}</div>;
}
