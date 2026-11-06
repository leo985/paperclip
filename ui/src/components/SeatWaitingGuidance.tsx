import { useQuery } from "@tanstack/react-query";
import { dsp7SeatsApi } from "@/api/dsp7-seats";

/** Only a live alert for this task and run can identify a native Claude wait. */
export function SeatWaitingGuidance({ companyId, taskId, seatId, runId }: {
  companyId: string; taskId: string; seatId: string; runId?: string;
}) {
  const seats = useQuery({
    queryKey: ["dsp7-registered-seats", companyId],
    queryFn: () => dsp7SeatsApi.list(companyId),
    refetchInterval: 5000,
    retry: false,
  });
  const seat = seats.data?.find(s => s.agentId === seatId);
  const presence = seat?.presence;
  const native = !seats.isError && seat?.online && presence?.state === "waiting_decision"
    && presence.activeTaskId === taskId && presence.runId
    && (!runId || presence.runId === runId)
    && presence.alerts.find(a => a.taskId === taskId && a.id.startsWith(`${presence.runId}:native:`));
  if (!native) return null;
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const command = uuid.test(companyId) && uuid.test(presence.runId!)
    ? `harness --company ${companyId} attach-run ${presence.runId}` : null;
  return <div className="space-y-2 text-sm" aria-label="本机 Claude 待处理指引">
    <p className="font-medium">等待本机 Claude 处理 · {seat.name}</p>
    <p>{native.message}</p>
    <p>在该席位电脑打开本任务的 Claude 终端，查看当前问题或权限请求，再按终端选项回答、允许或拒绝。网页评论和会话记录不能代替终端操作。</p>
    {command && <><p className="text-xs text-muted-foreground">找不到原终端时，在该席位电脑执行以下命令重连本次运行：</p><code className="block break-all rounded-md bg-muted p-2 font-mono text-xs">{command}</code></>}
    <p className="text-xs text-muted-foreground">处理后以本机上报恢复执行为准。</p>
  </div>;
}
