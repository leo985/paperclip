import { useState } from "react";
import type { AnalysisExecution, AnalysisQingzhouOptions } from "@paperclipai/shared";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

export function AnalysisQingzhouOptionsFields({ value, onChange, disabled }: { value: AnalysisQingzhouOptions; onChange: (value: AnalysisQingzhouOptions) => void; disabled?: boolean }) {
  function change(key: keyof AnalysisQingzhouOptions, input: string) { onChange({ ...value, [key]: input || undefined }); }
  return <fieldset disabled={disabled} className="space-y-3">
    <legend className="text-sm font-medium">轻舟分析保存参数</legend>
    <p className="text-xs text-muted-foreground">留空沿用轻舟已有值；缺少时默认共性业务、1 小时，日期取本次运行起止日期。轻舟可能按业务共性重新分配评审人，请核对。</p>
    <div className="grid gap-3 sm:grid-cols-2">
      <label className="space-y-2 text-sm"><span className="block">业务共性</span><select aria-label="轻舟分析业务共性" className="w-full rounded-md border border-border bg-background p-2 text-sm" value={value.workGenerality ?? ""} onChange={e => change("workGenerality", e.target.value)}><option value="">沿用来源，缺少时共性业务</option><option value="1">共性业务</option><option value="2">纯个性业务</option></select></label>
      <label className="space-y-2 text-sm"><span className="block">分析工时（小时）</span><Input type="number" min="0.01" max="10000" step="0.01" aria-label="轻舟分析工时" value={value.workHour ?? ""} placeholder="沿用来源，缺少时 1 小时" onChange={e => change("workHour", e.target.value)}/></label>
      <label className="space-y-2 text-sm"><span className="block">分析开始日期</span><Input type="date" aria-label="轻舟分析开始日期" value={value.startDate ?? ""} onChange={e => change("startDate", e.target.value)}/></label>
      <label className="space-y-2 text-sm"><span className="block">分析结束日期</span><Input type="date" aria-label="轻舟分析结束日期" value={value.endDate ?? ""} onChange={e => change("endDate", e.target.value)}/></label>
    </div>
  </fieldset>;
}

export function AnalysisQingzhouWriteback({ execution, canManage, busy, onRetry }: { execution: AnalysisExecution; canManage: boolean; busy: boolean; onRetry: (options: AnalysisQingzhouOptions) => void }) {
  const [options, setOptions] = useState<AnalysisQingzhouOptions>(execution.qingzhouWriteback?.options ?? {});
  if (!execution.demandNo) return null;
  const receipt = execution.qingzhouWriteback;
  return <section className="space-y-3 rounded-lg border border-border p-4" aria-label="轻舟分析内容回写">
    <h3 className="font-semibold">轻舟分析交付</h3>
    <p className="text-sm">{execution.demandNo} · {receipt?.status === "saved" ? "已保存并回读核验" : receipt?.status === "failed" ? "回写未完成" : execution.delivery ? "等待回写或结果确认" : "批准当前版本并完成交付后，自动保存并提交轻舟评审"}</p>
    <p className="text-xs text-muted-foreground">仅上传当前版本的分析正文，使用执行席位单独配置的轻舟账号；账号须有该条目分析负责人的保存权限。未配置时请先到席位的接单设置配置。正文回读一致后，使用轻舟已配置的评审人申请评审；状态核验为“分析完成待评审”才算提交成功。正式评审由轻舟评审人处理。</p>
    {receipt?.status === "saved" && <p className="text-sm">{receipt.reviewStatus === "submitted" ? "已提交轻舟评审 · 分析完成待评审" : receipt.reviewStatus === "failed" ? "正文已保存 · 提交轻舟评审未完成" : "正文已保存 · 尚未提交或核验轻舟评审"}</p>}
    {receipt?.reviewVerifiedAt && <p className="text-xs text-muted-foreground">评审状态核验于 {new Date(receipt.reviewVerifiedAt).toLocaleString()}</p>}
    {receipt?.reviewError && <p role="alert" className="text-sm text-destructive">{receipt.reviewError}</p>}
    {receipt?.savedAt && <p className="text-xs text-muted-foreground">核验于 {new Date(receipt.savedAt).toLocaleString()}</p>}
    {receipt?.error && <p role="alert" className="text-sm text-destructive">{receipt.error}</p>}
    {execution.delivery && (receipt?.status !== "saved" || receipt.reviewStatus !== "submitted") && canManage && <form className="space-y-3" onSubmit={event => { event.preventDefault(); onRetry(options); }}>
      {receipt?.status !== "saved" && <AnalysisQingzhouOptionsFields value={options} onChange={setOptions} disabled={busy}/>}
      <div className="flex justify-end"><Button type="submit" variant="outline" disabled={busy}>{receipt?.status === "saved" ? "重试提交轻舟评审" : "重试保存并提交评审"}</Button></div>
    </form>}
  </section>;
}
