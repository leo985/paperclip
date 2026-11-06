import type { SeatStartupProgress as Progress } from "../api/dsp7-seats";
import { formatDateTime } from "../lib/utils";

const labels: Record<string, string> = {
  authorized: "网页已授权", command_created: "指令已生成", received: "本机已收到",
  validating: "本机开始核验", runtime_verified: "运行环境已核验", jira_verified: "Jira 与仓库已核验",
  run_requested: "等待真实运行与终端连接", terminal_connected: "已连接本机可见终端", failed: "启动未完成",
};

export function SeatStartupProgress({ progress }: { progress?: Progress | null }) {
  if (!progress) return null;
  const complete = progress.steps.some(step => step.stage === "terminal_connected");
  return <section className="space-y-2 rounded-lg border border-border p-3 text-sm" aria-label="启动进度" role="status">
    <div className="flex flex-wrap items-center justify-between gap-2">
      <span className="font-medium">{labels[progress.stage] ?? "正在启动"}</span>
      <span className="font-mono text-xs text-muted-foreground">{complete ? "启动用时" : "已等待"} {Math.round(progress.elapsedSeconds)} 秒</span>
    </div>
    {!complete && progress.stage !== "failed" && <p className="text-xs text-muted-foreground">终端打开后还需完成 Claude 初始化；收到指令不代表模型已开始处理。</p>}
    <details className="space-y-2 text-xs text-muted-foreground">
      <summary className="cursor-pointer">查看各阶段耗时</summary>
      <ol className="space-y-1">
        {progress.steps.map(step => <li key={step.stage} className="flex flex-wrap justify-between gap-2">
          <span>{labels[step.stage] ?? step.stage}</span>
          <span className="font-mono" title={formatDateTime(step.at)}>+{step.elapsedSeconds.toFixed(1)} 秒</span>
        </li>)}
      </ol>
    </details>
  </section>;
}
