import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { dsp7SeatsApi } from "@/api/dsp7-seats";
import { agentsApi } from "@/api/agents";
import { Link, useNavigate } from "@/lib/router";
import { agentUrl } from "@/lib/utils";
import { Button } from "../ui/button";

/** Association means reusing the executor; never hire a second machine owner. */
export function RegisteredSeatConnection({ companyId }: { companyId: string }) {
  const navigate = useNavigate();
  const [seatId, setSeatId] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const seats = useQuery({ queryKey: ["dsp7-registered-seats", companyId], queryFn: () => dsp7SeatsApi.list(companyId), retry: false });
  const seat = seats.data?.find(item => item.agentId === seatId);
  async function associate() {
    if (!seat?.usable || busy) return;
    setBusy(true); setError(null);
    try {
      await dsp7SeatsApi.verify(companyId, seat);
      const agent = await agentsApi.get(seat.agentId, companyId);
      navigate(agentUrl(agent));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "无法关联席位");
      void seats.refetch();
    } finally { setBusy(false); }
  }
  return <section className="mb-6 space-y-3 rounded-md border border-border p-4">
    <h3 className="text-sm font-medium">关联已登记的本机席位</h3>
    <Link to="/seats" className="text-xs underline">打开席位管理：在线状态、网页检查与启动</Link>
    <p className="text-xs text-muted-foreground">使用 Harness 开发时，选择研发电脑已登记的席位，复用它的现有智能体和执行配置。</p>
    <select aria-label="已登记的本机席位" className="w-full rounded-md border border-border bg-background p-2 text-sm" value={seatId} disabled={busy} onChange={event => { setSeatId(event.target.value); setError(null); }}>
      <option value="">请选择本机席位</option>
      {(seats.data ?? []).map(item => <option key={item.agentId} value={item.agentId}>{item.name} — {item.environmentName}{item.usable ? "" : "（需刷新登记）"}</option>)}
    </select>
    {seat && <div className="space-y-2 text-xs">
      <p>执行智能体：{seat.agentName}；环境：{seat.environmentName}</p>
      {seat.runtime && <dl className="space-y-1 break-all">
        <dt className="text-muted-foreground">Claude</dt><dd>{seat.runtime.claudeCommand} · {seat.runtime.claudeVersion}</dd>
        <dt className="text-muted-foreground">配置来源</dt><dd>{seat.runtime.claudeSettingsFile ?? "本机 Claude 默认配置"}</dd>
        <dt className="text-muted-foreground">Harness 根目录</dt><dd>{seat.runtime.harnessRoot}</dd>
        <dt className="text-muted-foreground">最近本机检查</dt><dd>{new Date(seat.runtime.checkedAt).toLocaleString()} · 登记版本 {seat.runtime.revision}</dd>
      </dl>}
      <p className={seat.usable ? "text-muted-foreground" : "text-destructive"}>{seat.message}</p>
    </div>}
    {(error || seats.error) && <p role="alert" className="text-sm text-destructive">{error ?? seats.error?.message}</p>}
    {seats.data?.length === 0 && <p className="text-xs text-muted-foreground">没有获授权的席位。管理员完成初始绑定后，在研发电脑执行 harness seat register。</p>}
    <p className="text-xs text-muted-foreground">登记有效期为 24 小时，不表示电脑当前在线。本机执行 harness seat check 可刷新；配置变更后执行 harness seat register。下方手动配置用于创建独立智能体。</p>
    <div className="flex items-center justify-between gap-3"><Button type="button" variant="ghost" disabled={busy || seats.isFetching} onClick={() => void seats.refetch()}>刷新席位</Button><Button type="button" disabled={!seat?.usable || busy} onClick={() => void associate()}>{busy ? "正在核对…" : "使用此席位，打开已有智能体"}</Button></div>
  </section>;
}
