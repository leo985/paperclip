import { SeatRunControl } from "@/components/SeatRunControl";
import { useEffect, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { heartbeatsApi } from "@/api/heartbeats";
import { Button } from "@/components/ui/button";
import { useCompany } from "@/context/CompanyContext";
import { useBreadcrumbs } from "@/context/BreadcrumbContext";
import { Link } from "@/lib/router";
import { useManagementIssues } from "@/hooks/useManagementIssues";
import { dsp7SeatsApi } from "@/api/dsp7-seats";
import { Input } from "@/components/ui/input";
import { runIssueId } from "@/lib/management-runs";
import { localizedStatus } from "@/i18n/interface";

const LOG_PAGE_BYTES = 16_000;
const LIST_STALE_MS = 15_000;

export function ExecutionRecords() {
  const { selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const [params, setParams] = useSearchParams();
  const id = params.get("run");
  const tasks = useManagementIssues(selectedCompanyId ?? "");
  const seats = useQuery({ queryKey: ["dsp7-registered-seats", selectedCompanyId], queryFn: () => dsp7SeatsApi.list(selectedCompanyId!), enabled: !!selectedCompanyId });
  const taskMap = new Map((tasks.data?.pages.flat() ?? []).map(task => [task.id, task]));
  const search = params.get("q") ?? "";
  const status = params.get("status") ?? "";
  const agentId = params.get("agent");
  const runs = useQuery({
    queryKey: ["focused-runs", selectedCompanyId, agentId],
    queryFn: ({ signal }) => heartbeatsApi.list(selectedCompanyId!, agentId ?? undefined, 50, { summary: true }, { signal }),
    enabled: !!selectedCompanyId,
    staleTime: LIST_STALE_MS,
    refetchInterval: LIST_STALE_MS,
  });
  const visibleRuns = (runs.data ?? []).filter(run => {
    const task = taskMap.get(runIssueId(run) ?? "");
    const seat = seats.data?.find(s => s.agentId === run.agentId);
    return (!status || run.status === status) && (!search.trim() || `${task?.title ?? ""} ${task?.identifier ?? ""} ${run.id} ${seat?.name ?? ""} ${seat?.owner?.name ?? ""}`.toLocaleLowerCase().includes(search.trim().toLocaleLowerCase()));
  });
  const listedRun = runs.data?.find(run => run.id === id && run.companyId === selectedCompanyId);
  // Listing already authorizes and identifies recent runs. Only deep links to
  // older runs need the expensive detail/projection endpoint before reading logs.
  const detail = useQuery({
    queryKey: ["focused-run", selectedCompanyId, id],
    queryFn: ({ signal }) => heartbeatsApi.get(id!, { signal }),
    enabled: !!selectedCompanyId && !!id && (runs.isSuccess || runs.isError) && !listedRun,
    staleTime: LIST_STALE_MS,
    retry: false,
  });
  const selected = listedRun ?? (detail.data?.companyId === selectedCompanyId ? detail.data : undefined);
  useEffect(() => { setBreadcrumbs([{ label: "执行记录" }]); }, [setBreadcrumbs]);
  function selectRun(runId: string) {
    setParams(previous => {
      const next = new URLSearchParams(previous);
      next.set("run", runId);
      return next;
    });
  }
  return <div className="space-y-4">
    <h1 className="text-2xl font-semibold">执行记录</h1>
    <p className="text-sm text-muted-foreground">最近 50 次运行，每 15 秒更新列表；运行结束不代表交付验收完成。具体工单证据和用量请在工单详情查看。</p>
    <div className="flex flex-wrap items-center gap-3"><Input aria-label="搜索执行记录" className="w-full md:w-80" placeholder="搜索工单、席位、负责人或运行编号" value={search} onChange={e => setParams(previous => { const next = new URLSearchParams(previous); e.target.value ? next.set("q", e.target.value) : next.delete("q"); return next; }, { replace: true })}/><label className="text-sm">运行状态 <select aria-label="执行记录状态" className="rounded-md border border-border bg-background p-2" value={status} onChange={e => setParams(previous => { const next = new URLSearchParams(previous); e.target.value ? next.set("status", e.target.value) : next.delete("status"); return next; }, { replace: true })}><option value="">全部状态</option>{["running", "queued", "failed", "timed_out", "succeeded", "cancelled"].map(value => <option key={value} value={value}>{localizedStatus(value)}</option>)}</select></label></div>
    {(tasks.isPending || tasks.hasNextPage || seats.isPending) && <p role="status" className="text-sm text-muted-foreground">正在补全关联工单和席位信息，按名称搜索的结果暂不完整。</p>}
    {(tasks.isError || seats.isError) && <p role="alert" className="text-sm text-destructive">关联工单或席位信息读取失败，运行列表仍可查看；按名称搜索的结果可能不完整。</p>}
    {runs.isError ? <div role="alert" className="space-y-2"><p className="text-destructive">运行记录加载失败。</p><Button variant="outline" onClick={() => void runs.refetch()}>重新加载</Button></div> : runs.isPending ? <p role="status">正在加载运行记录…</p> : !visibleRuns.length ? <p>当前最近 50 次运行中暂无匹配记录，可调整搜索或状态。</p> : <ul className="divide-y divide-border rounded-xl border border-border">{visibleRuns.map(run => {
      const issueId = runIssueId(run), task = taskMap.get(issueId ?? ""), seat = seats.data?.find(s => s.agentId === run.agentId);
      return <li key={run.id} className="space-y-2 p-4"><button type="button" aria-pressed={run.id === id} className={`flex w-full flex-wrap items-center justify-between gap-2 rounded-md p-2 text-left hover:bg-accent ${run.id === id ? "bg-accent" : ""}`} onClick={() => selectRun(run.id)}><span className="text-sm font-medium">{task ? `${task.identifier ?? "工单"} · ${task.title}` : issueId ? "关联工单待核实" : "独立运行（未关联工单）"}</span><span className="text-sm">{localizedStatus(run.status)}</span><span className="text-xs text-muted-foreground">{new Date(run.startedAt ?? run.createdAt).toLocaleString("zh-CN")}</span></button><p className="text-xs text-muted-foreground">{seat?.name ?? "执行智能体信息待同步"} · 席位负责人：{seat?.owner?.name ?? "待核实"}</p>{run.error && <p className="line-clamp-2 text-sm text-destructive">失败摘要：{run.error}</p>}{run.nextAction && <p className="text-sm">下一步：{run.nextAction}</p>}<div className="flex flex-wrap items-center gap-3 text-xs">{task && <Link className="underline" to={`/issues/${task.identifier ?? task.id}`}>查看工单、决策与恢复</Link>}<button type="button" className="underline" onClick={() => selectRun(run.id)}>查看本次运行</button><details className="text-muted-foreground"><summary className="cursor-pointer">运行标识</summary><code className="break-all font-mono">{run.id}</code></details></div></li>;
    })}</ul>}

    {!!id && !selected && detail.isFetching && <p role="status">正在加载所选运行…</p>}
    {!!id && !selected && (detail.isError || detail.isSuccess) && <p role="alert" className="text-destructive">该运行不存在、不可访问或不属于当前组织。</p>}
    {selected && <SeatRunControl key={"control:"+selectedCompanyId+":"+selected.id} companyId={selectedCompanyId!} runId={selected.id} />}
    {selected && <RunLogPreview key={"log:"+selectedCompanyId+":"+selected.id} companyId={selectedCompanyId!} runId={selected.id} />}
  </div>;
}

function RunLogPreview({ companyId, runId }: { companyId: string; runId: string }) {
  const [limit, setLimit] = useState(LOG_PAGE_BYTES);
  const maxPreviewBytes = 256_000;
  // Always read a prefix rather than concatenate independently decoded byte
  // ranges: a UTF-8 character at a page boundary must not become two replacements.
  const log = useQuery({
    queryKey: ["focused-run-log-preview", companyId, runId, limit],
    queryFn: ({ signal }) => heartbeatsApi.log(runId, 0, limit, { signal }),
    placeholderData: keepPreviousData,
    staleTime: LIST_STALE_MS,
    retry: false,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });
  return <section className="space-y-3 rounded-xl border border-border p-4">
    <div className="flex flex-wrap items-center justify-between gap-2"><h2 className="font-semibold">运行日志</h2><div className="flex flex-wrap items-center gap-2"><span className="font-mono text-xs text-muted-foreground">{runId}</span><Button variant="outline" disabled={log.isFetching} onClick={() => void log.refetch()}>刷新日志</Button></div></div>
    <p className="text-xs text-muted-foreground">首次读取开头最多 16 KB，按需扩大预览，最多 256 KB。点击“刷新日志”读取最新快照。</p>
    {log.isPending && <p role="status">正在加载日志…</p>}
    {log.data?.content && <pre className="max-h-96 overflow-auto whitespace-pre-wrap break-all rounded-md bg-muted p-3 text-xs">{log.data.content}</pre>}
    {log.isError && <div role="alert" className="space-y-2"><p>日志暂时不可用。</p><Button variant="outline" onClick={() => void log.refetch()}>重试读取日志</Button></div>}
    {log.isSuccess && !log.data?.content && <p className="text-sm text-muted-foreground">本次运行暂无日志输出。</p>}
    {log.data?.nextOffset !== undefined && limit < maxPreviewBytes && <Button variant="outline" disabled={log.isFetching} onClick={() => setLimit(value => Math.min(maxPreviewBytes, value * 2))}>{log.isFetching ? "正在加载…" : "查看更多日志"}</Button>}
    {log.data?.nextOffset !== undefined && limit >= maxPreviewBytes && <p className="text-xs text-muted-foreground">已达到本页预览上限；其余运行信息请在工单详情查看。</p>}
  </section>;
}
