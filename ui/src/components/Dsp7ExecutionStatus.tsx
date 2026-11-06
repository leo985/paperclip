import { SeatStartupProgress } from "./SeatStartupProgress";
import { SeatWaitingGuidance } from "./SeatWaitingGuidance";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { dsp7SeatsApi } from "../api/dsp7-seats";
import { Button } from "./ui/button";
import { executionMessage } from "../lib/dsp7-execution";
import { JiraIntakeSourceStatus, useJiraIntakeSource } from "./JiraIntakeSourceStatus";

/** Execution state remains attached to the original Jira intake task. */
export function Dsp7ExecutionStatus({ issue }: { issue: { id: string; companyId: string; identifier?: string | null; description?: string | null } }) {
  let seatId = "";
  try { seatId = JSON.parse(issue.description?.match(/<!-- DSP7-JIRA-INTAKE (.*?) -->/)?.[1] ?? "{}").seat_id ?? ""; } catch { /* No execution controls for invalid metadata. */ }
  const client = useQueryClient();
  const state = useQuery({ queryKey: ["platform-dispatch", issue.companyId, seatId, issue.id], queryFn: () => dsp7SeatsApi.dispatchStatus(issue.companyId, seatId, issue.id), enabled: Boolean(seatId), refetchInterval: 3000, retry: false });
  const resume = useMutation({ mutationFn: () => dsp7SeatsApi.platformDispatch(issue.companyId, seatId, issue.id, "resume"), onSuccess: () => { void state.refetch(); void client.invalidateQueries({ queryKey: ["issues"] }); } });
  const source = useJiraIntakeSource(issue.companyId, seatId, issue.id);
  const dispatch = useMutation({ mutationFn: () => dsp7SeatsApi.platformDispatch(issue.companyId, seatId, issue.id), onSuccess: () => { void state.refetch(); void client.invalidateQueries({ queryKey: ["issues"] }); } });
  if (!seatId) return null;
  const message = executionMessage(state.data?.message);
  const labels: Record<string, string> = { startup_failed: "启动失败", registered_only: "待派单", preparing: "准备接入", waiting_online: "等待席位上线", queued: "排队中", command_pending: "等待本机领取", opening_terminal: "打开本机终端", starting: "正在启动", ready_to_start: "等待启动", running: "执行中", waiting_decision: "等待人工处理", blocked: "接入或执行受阻", done: "已完成", cancelled: "已取消", dispatch_cancelled: "已取消派单" };
  let intakeFailed = false;
  let intakeFailureMessage = "";
  try { const receipt = JSON.parse(issue.description?.match(/<!-- DSP7-INTAKE-RESULT (.*?) -->/)?.[1] ?? "{}"); intakeFailed = receipt.status === "blocked"; if (intakeFailed && typeof receipt.message === "string") intakeFailureMessage = receipt.message; } catch { /* Invalid receipts never enable retry. */ }
  const canDispatch = state.data && (!state.data.authorized || state.data.phase === "startup_failed" || (state.data.phase === "blocked" && intakeFailed)) && !["done", "cancelled", "running", "waiting_decision", "interrupted", "reconnecting"].includes(state.data.phase);
  return <section className="space-y-2 rounded-lg border border-border bg-muted p-3 text-sm" role="status">
    <JiraIntakeSourceStatus companyId={issue.companyId} seatId={seatId} taskId={issue.id} />
    <p className="font-medium">平台执行：{state.data?.phase === "retry_pending" ? "准备自动重试（最多一次）" : state.data?.phase === "interrupted" ? "执行已中断" : state.data?.phase === "reconnecting" ? "本机终端已断开，等待重连" : labels[state.data?.phase ?? ""] ?? "正在读取"}</p>
    <p>{message.text || (state.data?.phase === "blocked" ? intakeFailureMessage : "")}</p>
    {state.data?.phase === "waiting_decision" && <SeatWaitingGuidance companyId={issue.companyId} taskId={issue.id} seatId={seatId} />}
    {state.data?.startup && <SeatStartupProgress progress={state.data.startup} />}
    {canDispatch && <Button disabled={dispatch.isPending || source.isError || !source.data?.eligible} onClick={() => dispatch.mutate()}>{dispatch.isPending ? "正在核验并派单…" : state.data?.phase === "startup_failed" ? "重试启动" : state.data?.phase === "blocked" ? "修复后重新派单" : "派单并执行"}</Button>}
    {state.error && <p role="alert" className="text-destructive">{state.error.message}</p>}
    {dispatch.error && <p role="alert" className="text-destructive">{dispatch.error.message}</p>}
    {state.data?.phase === "interrupted" && <><p className="text-muted-foreground">保留原任务、对话和 Harness 阶段。异常中断最多自动重试一次，启动前重新核验 Jira、停止证明与执行锁。明确停止、条件不满足或重试用尽时，可在此手动恢复。</p><Button disabled={resume.isPending || !state.data?.canResume} onClick={() => resume.mutate()}>{resume.isPending ? "正在恢复…" : `恢复 ${issue.identifier ?? "当前任务"}`}</Button></>}
    {state.data?.phase === "interrupted" && !state.data.canResume && state.data.resumeBlockedReason && <p className="text-muted-foreground">{state.data.resumeBlockedReason}</p>}
    {resume.error && <p role="alert" className="text-destructive">{resume.error.message}</p>}
    {message.runId && <details className="space-y-2 text-xs text-muted-foreground"><summary className="cursor-pointer">技术详情</summary><p className="break-all">运行编号：<code className="font-mono">{message.runId}</code></p></details>}
  </section>;
}
