import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { readJiraRequirementMetadata, type Issue, type JiraRequirementRootMetadata, type JiraRequirementItem } from "@paperclipai/shared";
import { issuesApi } from "@/api/issues";
import { dsp7SeatsApi } from "@/api/dsp7-seats";
import { jiraRequirementsApi } from "@/api/jira-requirements";
import { Link } from "@/lib/router";
import { Button } from "./ui/button";
import { requirementModeLabels } from "./JiraRequirementIntake";
export const readRequirementMetadata = readJiraRequirementMetadata;
export function JiraRequirementPanel({ issue }: { issue: Issue }) {
  const meta = readRequirementMetadata(issue.description);
  return meta ? "rootKey" in meta ? <div className="space-y-2 rounded-lg border border-border bg-muted p-4 text-sm"><p>{requirementModeLabels[meta.mode]} · {meta.note}</p>{issue.parentId && <Link className="underline" to={`/issues/${issue.parentId}`}>查看主需求 {meta.rootKey}</Link>}<p className="text-muted-foreground">Jira 状态及负责人为接入时快照；实际执行与交付按对应 Harness 门禁核验。</p></div> : <RequirementOverview issue={issue} meta={meta} /> : null;
}
function RequirementOverview({ issue, meta }: { issue: Issue; meta: JiraRequirementRootMetadata }) {
  const tasks = useQuery({ queryKey: ["jira-requirement-children", issue.companyId, issue.id], queryFn: () => issuesApi.listAll(issue.companyId, { parentId: issue.id }), refetchInterval: 10000 });
  const seats = useQuery({ queryKey: ["dsp7-registered-seats", issue.companyId], queryFn: () => dsp7SeatsApi.list(issue.companyId) });
  return <section className="space-y-4 rounded-lg border border-border p-4"><div><h2 className="text-lg font-semibold">需求交付总览</h2><p className="text-sm">研发负责人：{meta.owner?.name ?? "待核对"} · Jira 主需求：{meta.key}</p><p className="text-xs text-muted-foreground">此表汇总真实子工单。Jira 列为接入快照，平台列为当前任务状态；不会把运行结束直接视为交付验收，也不会自动启动全部子工单。</p></div>
    {tasks.isPending && <p>正在加载子工单…</p>}{tasks.isError && <p role="alert" className="text-destructive">子工单读取失败，请刷新重试。</p>}
    {seats.isError && <p role="alert" className="text-sm text-destructive">执行席位读取失败，派单暂不可用。</p>}
    {tasks.data && <div className="overflow-x-auto"><table className="w-full text-left text-sm"><thead><tr className="border-b border-border"><th className="p-2">子工单／负责人</th><th className="p-2">执行方式</th><th className="p-2">状态</th><th className="p-2">操作</th></tr></thead><tbody>{(meta.children ?? []).map(item => {
      const task = tasks.data.find(child => child.originId === `${meta.jiraBaseUrl}:${item.key}` || readJiraRequirementMetadata(child.description)?.key === item.key);
      return <RequirementRow key={item.key} companyId={issue.companyId} item={item} task={task} seats={seats.data ?? []} jiraBaseUrl={meta.jiraBaseUrl} />;
    })}</tbody></table></div>}
    <p className="text-sm text-muted-foreground">代码评审由研发 Harness 在编码流程中关联真实评审单、被审版本和独立 Tracker 回执。多个编码／评审子单的关联由 Harness 核验，不按同父关系猜测。</p>
  </section>;
}
function RequirementRow({ companyId, item, task, seats, jiraBaseUrl }: { companyId: string; item: JiraRequirementItem; task?: Issue; seats: Awaited<ReturnType<typeof dsp7SeatsApi.list>>; jiraBaseUrl: string }) {
  const cache = useQueryClient(); const [chosen, setChosen] = useState("");
  const candidates = seats.filter(seat => seat.canConfigure && seat.owner && seat.dispatch?.projectId === task?.projectId && seat.dispatch?.issueTypes?.includes(item.issueType));
  const target = chosen || (candidates.length === 1 ? candidates[0].agentId : "");
  const prepared = task?.description?.includes("DSP7-JIRA-INTAKE");
  const dispatch = useMutation({ mutationFn: async () => { await jiraRequirementsApi.prepare(companyId, target, task!.id); return dsp7SeatsApi.platformDispatch(companyId, target, task!.id); }, onSuccess: () => cache.invalidateQueries({ queryKey: ["jira-requirement-children", companyId] }) });
  const canPrepare = item.mode === "development" && task && ["backlog", "todo"].includes(task.status) && !prepared && !item.done;
  const jiraHref = `${jiraBaseUrl}/browse/${encodeURIComponent(item.key)}`;
  return <tr className="border-b border-border align-top"><td className="space-y-1 p-2">{task ? <Link className="underline" to={`/issues/${task.id}`}>{item.key}</Link> : item.key}<p>{item.summary}</p><p>{item.assignee?.name ?? "Jira 未指派"}</p><p className="text-xs text-muted-foreground">{item.issueType}</p></td><td className="p-2">{requirementModeLabels[item.mode]}<p className="text-xs text-muted-foreground">{item.note}</p></td><td className="space-y-1 p-2"><p>Jira：{item.status}（快照）</p><p>平台：{task ? ({ backlog: "待接入", todo: "待执行", in_progress: "处理中", blocked: "阻塞", done: "已完成", cancelled: "已取消", in_review: "待验收" }[task.status] ?? task.status) : "未找到记录"}</p></td><td className="space-y-2 p-2">
    {canPrepare && <><select aria-label={`${item.key} 执行席位`} className="w-full rounded-md border border-border bg-background p-2" value={target} onChange={event => setChosen(event.target.value)} disabled={dispatch.isPending}><option value="">请选择执行席位</option>{candidates.map(seat => <option key={seat.agentId} value={seat.agentId}>{seat.name} · {seat.online ? "在线" : "离线，授权后等待上线"}</option>)}</select><Button variant="outline" disabled={!target || dispatch.isPending} onClick={() => dispatch.mutate()}>{dispatch.isPending ? "正在派单…" : "派单并执行"}</Button>{!candidates.length && <p className="text-xs text-muted-foreground">未找到可派发的匹配席位，请核对席位授权、项目及工单类型。</p>}</>}
    {prepared && task && <Link className="block underline" to={`/issues/${task.id}`}>查看派单与运行</Link>}
    {item.mode === "human-review" && <a className="block underline" href={jiraHref} target="_blank" rel="noreferrer">在 Jira 正式评审</a>}
    {item.mode === "harness-linked" && <p className="text-xs text-muted-foreground">无需再次派发。查看研发 Harness 的评审交付证据。</p>}
    {item.mode === "qa" && <p className="text-xs text-muted-foreground">由测试席位 Agent 在测试 Harness 执行；当前桥接器尚未提供 QA 执行通道，不能使用研发派单入口代替。</p>}
    <a className="block text-xs underline" href={jiraHref} target="_blank" rel="noreferrer">查看 Jira</a>
    {dispatch.error && <p role="alert" className="text-xs text-destructive">{dispatch.error.message}。若已完成准备，可打开子工单重试派单。</p>}
  </td></tr>;
}
