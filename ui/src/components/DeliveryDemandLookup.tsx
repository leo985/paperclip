import { useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { DeliveryConnection, DeliveryDemandLookup as LookupResult, DeliverySnapshot } from "@paperclipai/shared";
import { api } from "@/api/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Link, useNavigate } from "@/lib/router";

export function DeliveryDemandLookup({ companyId, projectId, compact = false, month }: { companyId: string; projectId: string; compact?: boolean; month?: string }) {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const base = `/companies/${companyId}/delivery-connections`;
  const connection = useQuery({ queryKey: ["delivery-connection", companyId, projectId], queryFn: () => api.get<DeliveryConnection | null>(`${base}?projectId=${projectId}`) });
  const [demandNo, setDemandNo] = useState("");
  const [result, setResult] = useState<LookupResult | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState<"lookup" | "sync" | null>(null);
  const alive = useRef(true), lock = useRef(false);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  useEffect(() => { setResult(null); setError(""); }, [connection.data?.revision]);
  async function lookup() {
    if (lock.current) return;
    const key = demandNo.trim().toUpperCase();
    setResult(null); setError("");
    if (!/^[A-Z][A-Z0-9]*-\d+$/.test(key)) { setError("请填写完整条目编号，例如 TWGF-00919"); return; }
    if (!connection.data?.credentialsConfigured) return;
    lock.current = true; setBusy("lookup"); setDemandNo(key);
    try {
      const response = await api.post<LookupResult>(`${base}/lookup`, { projectId, expectedRevision: connection.data.revision, demandNo: key });
      if (alive.current) setResult(response);
    } catch (cause) { if (alive.current) setError(cause instanceof Error ? cause.message : "条目查询失败，请重试"); }
    finally { lock.current = false; if (alive.current) setBusy(null); }
  }
  const syncMonth = month && /^\d{4}-(0[1-9]|1[0-2])$/.test(month) ? month :
    new Intl.DateTimeFormat("sv-SE", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit" }).format(new Date());
  function detailHref(targetProjectId: string, snapshotId: string) {
    return "/delivery?" + new URLSearchParams({ projectId: targetProjectId, snapshotId, ...(month ? { month } : {}) });
  }
  async function syncAndOpen() {
    if (lock.current || !result || !connection.data?.credentialsConfigured) return;
    lock.current = true; setBusy("sync"); setError("");
    try {
      const { snapshot } = await api.post<{ snapshot: DeliverySnapshot }>(`${base}/sync`, {
        projectId, expectedRevision: connection.data.revision, demandNo: result.demandNo, months: [syncMonth],
      });
      if (!alive.current) return;
      void qc.invalidateQueries({ queryKey: ["delivery-entries", companyId] });
      void qc.invalidateQueries({ queryKey: ["delivery-monthly", companyId, projectId] });
      navigate(detailHref(snapshot.projectId, snapshot.id));
    } catch (cause) {
      if (alive.current) setError(cause instanceof Error ? cause.message : "来源同步失败，请重试");
    } finally {
      lock.current = false; if (alive.current) setBusy(null);
    }
  }
  const saved = result?.savedEntries ?? (result?.snapshotId ? [{ projectId, projectName: "", snapshotId: result.snapshotId }] : []);
  const defaultEntry = saved.find(entry => entry.projectId === projectId) ?? (saved.length === 1 ? saved[0] : undefined);
  const sourceHref = "/delivery?" + new URLSearchParams({ projectId, view: "sources", ...(month ? { month } : {}), ...(result ? { demandNo: result.demandNo } : {}) });
  return <section className={compact ? "space-y-2" : "space-y-3 rounded-lg border border-border p-4"} aria-label="按条目编号精确查询">
    {!compact && <h2 className="font-semibold">按条目编号精确查询</h2>}
    {!compact && <p className="text-sm text-muted-foreground">直接查询轻舟，不受排期月份、列表筛选或是否已纳管限制。查询不会保存快照或派单；来源可见范围以当前项目配置的轻舟账号权限为准。</p>}
    <form className="flex flex-wrap items-end gap-3" onSubmit={event => { event.preventDefault(); void lookup(); }}>
      <label className="space-y-2 text-sm"><span className="block">完整条目编号</span><Input aria-label="精确查询条目编号" maxLength={100} value={demandNo} disabled={!!busy} onChange={event => { setDemandNo(event.target.value); setResult(null); setError(""); }} placeholder="例如 TWGF-00919" /></label>
      <Button type="submit" disabled={!!busy || !connection.data?.credentialsConfigured}>{busy === "lookup" ? "正在查询…" : "精确查询"}</Button>
      {compact && <span className="py-2 text-xs text-muted-foreground">直接查询轻舟，可查未纳管条目，不受月份和筛选限制。</span>}
    </form>
    {connection.isPending && <p role="status" className="text-sm">正在读取项目来源配置…</p>}
    {connection.isError && <p role="alert" className="text-sm text-destructive">来源配置读取失败。<Button variant="outline" onClick={() => void connection.refetch()}>重试</Button></p>}
    {!connection.isPending && !connection.isError && !connection.data?.credentialsConfigured && <p className="text-sm">请先<Link className="underline" to={sourceHref}>配置项目轻舟来源</Link>。</p>}
    {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
    {result && <article className="space-y-3" aria-label="条目精确查询结果">
      <h3 className="font-medium">{defaultEntry ? (
        <Link className="underline" to={detailHref(defaultEntry.projectId, defaultEntry.snapshotId)}>
          {result.demandNo} · {result.title || "来源未提供标题"}
        </Link>
      ) : <>{result.demandNo} · {result.title || "来源未提供标题"}</>}</h3>
      <p className="text-sm">来源状态：{result.sourceStatus || "未提供"} · 来源负责人：{result.owner || "未提供"} · 条目分析负责人：{result.analysisOwner || "未提供"}</p>
      <div className="flex flex-wrap gap-3">
        {saved.map(entry => <Button key={entry.projectId} variant="outline" asChild>
          <Link to={detailHref(entry.projectId, entry.snapshotId)}>
            {entry.projectName ? `查看条目详情（${entry.projectName}）` : "查看条目详情"}
          </Link>
        </Button>)}
        {!saved.length && <>
          <Button type="button" variant="outline" disabled={!!busy} onClick={() => void syncAndOpen()}>
            {busy === "sync" ? "正在同步工单…" : "同步工单并打开详情"}
          </Button>
          <Button variant="outline" asChild><Link to={sourceHref}>补录来源与工单</Link></Button>
        </>}
      </div>
      {!saved.length && <p className="text-sm text-muted-foreground">本组织尚未保存条目版本。可按 {syncMonth} 同步后查看详情，或补录其他排期月份。</p>}
    </article>}
  </section>;
}
