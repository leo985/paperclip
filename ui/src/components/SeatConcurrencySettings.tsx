import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { dsp7SeatsApi, type RegisteredSeat } from "@/api/dsp7-seats";
import { Button } from "./ui/button";
import { Input } from "./ui/input";

export function SeatConcurrencySettings({ companyId, seat }: { companyId: string; seat: RegisteredSeat }) {
  const cache = useQueryClient();
  const [value, setValue] = useState(String(seat.maxConcurrentRuns ?? 1));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const supported = seat.executionTransport === "outbound" && seat.presence?.capabilities?.includes("seat-concurrency-v1");
  async function save(event: React.FormEvent) {
    event.preventDefault(); const count = Number(value);
    if (!Number.isInteger(count) || count < 1 || count > 50) { setError("请输入 1–50 的整数。"); return; }
    setBusy(true); setError(""); setMessage("");
    try {
      await dsp7SeatsApi.saveConcurrency(companyId, seat.agentId, count);
      await cache.invalidateQueries({ queryKey: ["dsp7-registered-seats", companyId] });
      setMessage("并发数已保存；超出上限的工单排队，已有运行继续。");
    } catch (error) { setError(error instanceof Error ? error.message : "并发数保存失败，请重试。"); }
    finally { setBusy(false); }
  }
  return <form onSubmit={save} className="space-y-3 rounded-md border border-border p-3">
    <h3 className="text-sm font-medium">并发执行</h3>
    <p className="text-sm text-muted-foreground">每个席位独立设置。等待人工处理的运行也占用名额；达到上限后，新工单排队，空出名额后继续执行。调低上限不会中断已有运行。</p>
    {!supported && <p className="text-sm">请更新本机主动连接客户端并等待上线，以启用多工单并发。</p>}
    <label className="block space-y-1 text-sm">最大并发工单数<Input aria-label="最大并发工单数" type="number" min={1} max={supported ? 50 : 1} step={1} value={value} disabled={busy || !seat.canConfigure} onChange={event => setValue(event.target.value)} /></label>
    {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
    {message && <p role="status" className="text-sm">{message}</p>}
    {seat.canConfigure && <div className="flex items-center justify-between gap-3"><Button type="button" variant="outline" disabled={busy} onClick={() => { setValue(String(seat.maxConcurrentRuns ?? 1)); setError(""); setMessage(""); }}>重置</Button><Button disabled={busy || value === String(seat.maxConcurrentRuns ?? 1)}>{busy ? "正在保存…" : "保存并发数"}</Button></div>}
  </form>;
}
