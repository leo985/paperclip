import { useEffect } from "react";
import { useSearchParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { heartbeatsApi } from "@/api/heartbeats";
import { useCompany } from "@/context/CompanyContext";
import { useBreadcrumbs } from "@/context/BreadcrumbContext";
import { localizedStatus } from "@/i18n/interface";
export function ExecutionRecords() {
  const { selectedCompanyId } = useCompany(); const { setBreadcrumbs } = useBreadcrumbs(); const [params, setParams] = useSearchParams(); const id = params.get("run");
  const runs = useQuery({ queryKey: ["focused-runs", selectedCompanyId, params.get("agent")], queryFn: () => heartbeatsApi.list(selectedCompanyId!, params.get("agent") ?? undefined, 50, { summary: true }), enabled: !!selectedCompanyId, refetchInterval: 15000 });
  const detail = useQuery({ queryKey: ["focused-run", selectedCompanyId, id], queryFn: () => heartbeatsApi.get(id!), enabled: !!id, retry: false });
  const selected = detail.data?.companyId === selectedCompanyId ? detail.data : runs.data?.find(run => run.id === id);
  const log = useQuery({ queryKey: ["focused-run-log", selectedCompanyId, id], queryFn: () => heartbeatsApi.log(id!, 0, 64000), enabled: !!selected, retry: false });
  useEffect(() => { setBreadcrumbs([{ label: "执行记录" }]); }, [setBreadcrumbs]);
  return <div className="space-y-4"><h1 className="text-2xl font-semibold">执行记录</h1><p className="text-sm text-muted-foreground">最近 50 次运行；运行结束不代表交付验收完成。具体工单证据和用量请在工单详情查看。</p>{runs.isError ? <p role="alert" className="text-destructive">运行记录加载失败。</p> : runs.isPending ? <p>正在加载…</p> : !runs.data?.length ? <p>暂无运行记录。</p> : <ul className="divide-y divide-border rounded-xl border border-border">{runs.data.map(run => <li key={run.id}><button className="flex w-full flex-wrap items-center justify-between gap-2 p-4 text-left hover:bg-accent" onClick={() => setParams({ run: run.id })}><span className="font-mono text-xs">{run.id}</span><span className="text-sm">{localizedStatus(run.status)}</span><span className="text-xs text-muted-foreground">{new Date(run.startedAt ?? run.createdAt).toLocaleString("zh-CN")}</span></button></li>)}</ul>}{selected && <section className="space-y-2 rounded-xl border border-border p-4"><h2 className="font-semibold">运行日志</h2><p className="text-xs text-muted-foreground">显示开头最多 64 KB；完整运行信息仍保留在工单中。</p>{log.isError ? <p role="alert">日志暂时不可用。</p> : <pre className="max-h-96 overflow-auto whitespace-pre-wrap break-all rounded-md bg-muted p-3 text-xs">{log.data?.content ?? "正在加载日志…"}</pre>}</section>}</div>;
}
