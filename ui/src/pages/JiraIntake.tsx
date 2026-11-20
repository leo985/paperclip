import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { dsp7SeatsApi } from "@/api/dsp7-seats";
import { projectsApi } from "@/api/projects";
import { useCompany } from "@/context/CompanyContext";
import { useBreadcrumbs } from "@/context/BreadcrumbContext";
import { queryKeys } from "@/lib/queryKeys";
import { JiraRequirementIntake } from "@/components/JiraRequirementIntake";
import { Dsp7JiraIntake } from "@/components/Dsp7JiraIntake";
import { Link, useSearchParams } from "@/lib/router";
export function JiraIntake() {
  const [params] = useSearchParams();
  const initialSeatId = params.get("seat") ?? "";
  const { selectedCompanyId } = useCompany(); const { setBreadcrumbs } = useBreadcrumbs(); const [id, setId] = useState("");
  const projects = useQuery({ queryKey: queryKeys.projects.list(selectedCompanyId!), queryFn: () => projectsApi.list(selectedCompanyId!), enabled: !!selectedCompanyId });
  const seats = useQuery({ queryKey: ["dsp7-registered-seats", selectedCompanyId], queryFn: () => dsp7SeatsApi.list(selectedCompanyId!), enabled: !!selectedCompanyId && !!initialSeatId });
  const preferredProject = seats.data?.find(seat => seat.agentId === initialSeatId)?.dispatch?.projectId;
  const list = projects.data ?? []; const project = list.find(p => p.id === (id || params.get("projectId") || preferredProject)) ?? (list.length === 1 ? list[0] : undefined);
  useEffect(() => { setBreadcrumbs([{ label: "接入 Jira 工单" }]); setId(""); }, [setBreadcrumbs, selectedCompanyId]);
  return <div className="space-y-5"><h1 className="text-2xl font-semibold">Jira 工单执行</h1><p className="text-sm text-muted-foreground">在智研平台接入并派发 Jira 子工单，查看执行进度，或恢复已中断的任务。</p><Link to={"/delivery?"+new URLSearchParams({...(project?{projectId:project.id}:{}),...(params.get("snapshotId")?{snapshotId:params.get("snapshotId")!}:{})})} className="mr-4 text-sm text-primary underline">返回需求条目</Link><Link to="/seats" className="text-sm text-primary underline">配置席位接单规则</Link>{projects.isPending ? <p>正在加载项目…</p> : projects.isError ? <p role="alert" className="text-destructive">项目加载失败，请刷新重试。</p> : !list.length ? <p>尚未配置项目，请联系管理员配置共享项目与仓库。</p> : <><label className="block space-y-2 text-sm"><span>所属项目</span><select value={project?.id ?? id} onChange={e => setId(e.target.value)} className="block w-full max-w-md rounded-md border border-border bg-background p-2"><option value="">请选择项目</option>{list.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}</select></label>{import.meta.env.VITE_JIRA_REQUIREMENT_INTAKE === "true" && project && <JiraRequirementIntake key={`requirement:${project.id}`} project={project} />}{project && <Dsp7JiraIntake key={`${project.id}:${initialSeatId}:${params.get("jiraKey")??""}:${params.get("snapshotId")??""}`} project={project} initialSeatId={initialSeatId} initialJiraKey={params.get("jiraKey")??""} snapshotId={params.get("snapshotId")??""} />}</>}</div>;
}
