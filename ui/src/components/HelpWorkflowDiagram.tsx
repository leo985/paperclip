import { useState } from "react";
import { Button } from "@/components/ui/button";
import { ExternalLink } from "lucide-react";

export function HelpWorkflowDiagram() {
  const [actualSize, setActualSize] = useState(false);
  return <figure className="space-y-3" aria-label="智研协同平台工作流程泳道图">
    <div className="flex flex-wrap items-center justify-between gap-2">
      <h3 className="text-base font-semibold">从 Jira 指派到交付验收</h3>
      <div className="flex flex-wrap items-center gap-3"><Button variant="outline" size="sm" aria-pressed={actualSize} onClick={() => setActualSize(!actualSize)}>{actualSize ? "适应宽度" : "放大阅读"}</Button><a href="/zhiyan-workflow.svg" target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-sm text-primary underline underline-offset-4"><ExternalLink className="size-4" />打开完整流程图</a></div>
    </div>
    <div tabIndex={0} role="region" aria-label="流程图，可横向滚动" className="overflow-x-auto rounded-xl border border-border bg-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
      <img src="/zhiyan-workflow.svg" width="1200" height="1180" className="help-workflow-image" data-size={actualSize ? "actual" : "fit"} alt="四条泳道：人员与 Jira 指派和决策；智研协同平台登记、调度和提醒；研发电脑运行 Claude 与 Harness；Harness Tracker 保留领域回执和效果数据。详细步骤见下方文字。" />
    </div>
    <figcaption className="text-xs text-muted-foreground">从上往下阅读；箭头表示流程与信息流。橙色分支表示需要人工决策，虚线表示无需决策时继续执行。默认适应页面宽度；点击“放大阅读”后可左右滚动，或打开完整流程图查看。</figcaption>
  </figure>;
}
