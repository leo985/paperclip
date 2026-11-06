import { useQuery } from "@tanstack/react-query";
import type { SeatRunControl as Control } from "@paperclipai/shared";
import { api } from "@/api/client";
import { Button } from "@/components/ui/button";

export function SeatRunControl({ companyId, runId }: { companyId: string; runId: string }) {
  const query = useQuery({ queryKey: ["seat-run-control", companyId, runId], queryFn: () => api.get<Control>(`/companies/${companyId}/seat-run-control/${runId}`), refetchInterval: 5000 });
  const data = query.data;
  if (data?.mode === "not_applicable") return null;
  return <section aria-label="执行治理与用量对账" className="space-y-2 rounded-xl border border-border p-4 text-sm">
    <h2 className="font-semibold">执行治理与用量对账</h2>
    {query.isError ? <p role="alert">治理信息加载失败。<Button variant="outline" onClick={() => void query.refetch()}>重试</Button></p> : !data ? <p>正在读取执行状态…</p> : <>
      <p>{data.mode === "legacy" ? "旧执行通道：未启用本批执行许可，不标记为全程受控。" : "观测费用模式：许可定期续验；断网到期要求停止受管进程。"}</p>
      <p>进程树：{data.stopStatus === "verified" ? "本机已回报受管进程树停止证明" : data.stopStatus === "running" ? "执行中或等待执行" : "停止待核验；不能据此启动替代进程"}</p>
      <p>计量：{data.meteringStatus === "final_reported" ? "最终汇总已对账" : data.meteringStatus === "partial_observation" ? "已采集部分用量；尚无最终汇总" : "尚未获得有效用量，不等于零消耗"}</p>
      {data.tokens && <p className="font-mono">输入 {data.tokens.inputTokens.toLocaleString()} · 输出 {data.tokens.outputTokens.toLocaleString()} · 缓存读取 {data.tokens.cachedInputTokens.toLocaleString()}</p>}
      <p className="text-muted-foreground">{data.costStatus === "unpriced" ? "实际费用未计价；Token 可见不代表已知中转或订阅费用。不保证零超支。" : "费用以已入账记录为准。"}{data.observedAt && ` 最近观测：${new Date(data.observedAt).toLocaleString()}`}</p>
      {data.route && <p className="break-all text-muted-foreground">执行路由：{data.route.repository} · {data.route.profile} · {data.route.commit.slice(0, 12)}</p>}
    </>}
  </section>;
}
