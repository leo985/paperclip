import { useQuery } from "@tanstack/react-query";
import { dsp7SeatsApi } from "../api/dsp7-seats";
import { Button } from "./ui/button";

export function useJiraIntakeSource(companyId: string, seatId: string, taskId: string) {
  return useQuery({ queryKey: ["jira-intake-source", companyId, seatId, taskId], queryFn: () => dsp7SeatsApi.syncIntake(companyId, seatId, taskId), enabled: Boolean(seatId && taskId), staleTime: 15000, refetchInterval: 30000, refetchOnWindowFocus: true, retry: false });
}

export function JiraIntakeSourceStatus({ companyId, seatId, taskId }: { companyId: string; seatId: string; taskId: string }) {
  const source = useJiraIntakeSource(companyId, seatId, taskId);
  return <div className="space-y-2 rounded-md border border-border p-3 text-sm" aria-label="Jira 来源状态">
    <div className="flex flex-wrap items-center justify-between gap-2"><p className="font-medium">Jira 当前信息</p><Button variant="outline" size="sm" disabled={source.isFetching} onClick={() => void source.refetch()}>{source.isFetching ? "正在同步…" : "同步 Jira 状态"}</Button></div>
    {source.data && <><p>{source.data.jiraKey} · {source.data.status} · {source.data.issueType}</p><p>经办人：{source.data.assigneeName ?? source.data.assignee ?? "未指派"}{source.data.assigneeName && source.data.assignee ? `（${source.data.assignee}）` : ""}</p><p className="text-muted-foreground">{source.data.summary}</p><p className="text-xs text-muted-foreground">{source.isError ? "上次成功同步" : "最近同步"}：{new Date(source.data.checkedAt).toLocaleString("zh-CN")} · 页面打开时每 30 秒刷新，派单前再次核验</p>{source.data.reasons.map(reason => <p key={reason} className="text-destructive">{reason}</p>)}</>}
    {source.isPending && <p>正在读取 Jira 当前状态与经办人…</p>}
    {source.error && <p role="alert" className="text-destructive">{source.error.message}。同步失败期间不可据旧信息派单。</p>}
    <p className="text-xs text-muted-foreground">Jira 反映来源工单；下方平台状态反映实际执行。Jira 改派不会自动启动电脑。</p>
  </div>;
}
