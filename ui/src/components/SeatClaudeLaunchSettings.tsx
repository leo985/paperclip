import { useEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { seatLaunchOptionsSchema } from "@paperclipai/shared";
import { dsp7SeatsApi, type RegisteredSeat } from "@/api/dsp7-seats";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";

export function SeatClaudeLaunchSettings({ companyId, seat }: { companyId: string; seat: RegisteredSeat }) {
  const saved = (seat.launchOptions?.extraArgs ?? []).join(" ");
  const [draft, setDraft] = useState(saved);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [failed, setFailed] = useState(false);
  const queryClient = useQueryClient();
  useEffect(() => { setDraft(saved); setMessage(""); }, [saved, seat.agentId]);
  const supported = seat.presence?.capabilities?.includes("seat-launch-options-v1");
  async function save() {
    const args = draft.trim() ? draft.trim().split(/\s+/) : [];
    const parsed = seatLaunchOptionsSchema.safeParse({ extraArgs: args });
    if (!parsed.success) { setFailed(true); setMessage("参数无效、重复或冲突，请检查下方支持的参数与取值。"); return; }
    setBusy(true); setMessage("");
    try {
      await dsp7SeatsApi.saveLaunchOptions(companyId, seat.agentId, args);
      await queryClient.invalidateQueries({ queryKey: ["dsp7-registered-seats", companyId] });
      setFailed(false); setMessage("已保存，下一次新建 Claude 会话时生效。");
    } catch (error) { setFailed(true); setMessage(error instanceof Error ? error.message : "保存失败"); }
    finally { setBusy(false); }
  }
  return <section className="space-y-3 rounded-md border border-border p-3" aria-label="Claude 启动参数">
    <h3 className="font-medium">Claude 启动参数</h3>
    <p className="text-sm text-muted-foreground">对下一次新建的 Harness 工单、分析及交付会话生效。网页保存后覆盖本机同类参数；保存为空可恢复原生权限确认。尚未配置时沿用本机设置。</p>
    {!supported && <p className="text-sm text-muted-foreground">请先通过上方步骤更新本机接入桥并等待上线，才能保存启动参数。</p>}
    <label className="block space-y-2 text-sm"><span>启动参数（空格或换行分隔）</span><Textarea value={draft} onChange={event => setDraft(event.target.value)} disabled={!seat.canConfigure || !supported || busy} placeholder="--dangerously-skip-permissions" /></label>
    <p className="text-xs text-muted-foreground">支持 --dangerously-skip-permissions、--model 模型名、--effort low|medium|high|max、--permission-mode default|acceptEdits|plan|dontAsk|auto。跳过权限确认不能与权限模式同时配置。会话标识、采集 hooks 由平台管理。</p>
    <p className="text-sm text-muted-foreground">--dangerously-skip-permissions 会跳过 Claude 工具权限确认；Harness 业务审批仍需处理。运行中的会话不受影响。</p>
    {message && <p role={failed ? "alert" : "status"} className={failed ? "text-sm text-destructive" : "text-sm text-muted-foreground"}>{message}</p>}
    {seat.canConfigure && <div className="flex items-center justify-between gap-3"><Button variant="outline" disabled={busy} onClick={() => { setDraft(saved); setMessage(""); }}>取消修改</Button><Button disabled={!supported || busy} onClick={() => void save()}>{busy ? "保存中…" : "保存启动参数"}</Button></div>}
  </section>;
}
