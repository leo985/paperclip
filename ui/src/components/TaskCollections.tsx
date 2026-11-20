import { createIssueDetailLocationState } from "@/lib/issueDetailBreadcrumb";
import { lazy, Suspense, type ReactNode } from "react";
import { DELIVERY_STAGES, DELIVERY_STAGE_LABELS } from "@paperclipai/shared";
import { Link, Navigate, useSearchParams } from "@/lib/router";
import { taskStageFilter, type TaskStageFilter } from "@/lib/task-delivery-stage";
import { Button } from "./ui/button";

const AnalysisExecutions = lazy(() => import("@/pages/AnalysisExecutions").then(module => ({ default: module.AnalysisExecutions })));

export function TaskCollections({ children }: { children: ReactNode }) {
  const [params] = useSearchParams();
  const selected = taskStageFilter(params.get("taskType"));
  const creating = selected === "analysis" && (params.get("createAnalysis") === "1" || !!params.get("supersedesId"));
  function href(stage: TaskStageFilter) {
    const next = new URLSearchParams(params);
    ["taskType", "page", "executionId", "supersedesId", "createAnalysis"].forEach(key => next.delete(key));
    if (stage !== "all") next.set("taskType", stage);
    return "/issues" + (next.size ? "?" + next : "");
  }
  const executionId = selected === "analysis" ? params.get("executionId") : null;
  if (executionId) {
    const list = new URLSearchParams(params);
    ["executionId", "supersedesId", "createAnalysis"].forEach(key => list.delete(key));
    return <Navigate replace to={`/issues/${executionId}`} state={createIssueDetailLocationState("需求分析", "/issues?" + list, "analysis")} />;
  }
  const filters = [["all", "全部任务"], ...DELIVERY_STAGES.map(stage => [stage, DELIVERY_STAGE_LABELS[stage]]), ["other", "其他任务"]] as Array<[TaskStageFilter, string]>;
  return <div className="space-y-4">
    <nav className="flex flex-wrap gap-2" aria-label="交付环节筛选">
      {filters.map(([stage, label]) => <Button key={stage} variant={selected === stage ? "secondary" : "outline"} asChild><Link to={href(stage)} aria-current={selected === stage ? "page" : undefined}>{label}</Link></Button>)}
    </nav>
    {creating ? <><Link className="text-sm underline" to={href("analysis")}>返回需求分析任务</Link><Suspense fallback={<p role="status" className="text-sm text-muted-foreground">正在读取分析创建表单…</p>}><AnalysisExecutions createOnly /></Suspense></> : children}
  </div>;
}
