import { deliveryWorkflowApi } from "@/api/delivery-workflows";
import { DeliveryWorkflowTaskLink } from "./DeliveryWorkflowTaskLink";
import { useQuery } from "@tanstack/react-query";
import type { Issue } from "@paperclipai/shared";
import { analysisApi } from "@/api/analysis-executions";
import { Link, useLocation } from "@/lib/router";
import { readIssueDetailBreadcrumb } from "@/lib/issueDetailBreadcrumb";
import { Dsp7ExecutionStatus } from "@/components/Dsp7ExecutionStatus";
import { JiraRequirementPanel } from "@/components/JiraRequirementPanel";
import { ManagedSessionPanel } from "@/components/ManagedSessionPanel";
import { IssuePropertiesArtifactsTab } from "@/components/issue-properties/IssuePropertiesArtifactsTab";
import { Button } from "@/components/ui/button";
import { TaskIdentitySummary } from "./TaskIdentitySummary";
import { TaskDetailLayout } from "./TaskDetailLayout";
import { AnalysisTaskDetail } from "./AnalysisTaskDetail";

const statuses: Record<string, string> = {
  backlog: "待排期",
  todo: "待处理",
  in_progress: "处理中",
  in_review: "待评审",
  blocked: "阻塞",
  done: "已完成",
  cancelled: "已取消",
};

export function TaskExecutionDetail({ issue }: { issue: Issue }) {
  const location = useLocation();
  const delivery = useQuery({queryKey:["delivery-workflow-task",issue.companyId,issue.id],queryFn:()=>deliveryWorkflowApi.forTask(issue.companyId,issue.id),refetchInterval:5000,retry:false});
  const analysis = useQuery({
    queryKey: ["task-analysis", issue.companyId, issue.id],
    queryFn: () => analysisApi.forTask(issue.companyId, issue.id),
    retry: false,
    refetchInterval: 5000,
  });
  if (analysis.isPending)
    return (
      <p role="status" className="text-sm">
        正在读取任务详情…
      </p>
    );
  if (analysis.isError)
    return (
      <div role="alert" className="space-y-2 text-sm text-destructive">
        <p>
          任务专属详情读取失败：{analysis.error.message}
          。请重新检查；可切换到“对话、文件与高级操作”查看原有记录。
        </p>
        <Button
          variant="outline"
          disabled={analysis.isFetching}
          onClick={() => void analysis.refetch()}
        >
          重新读取任务详情
        </Button>
      </div>
    );
  if (analysis.data.analysis) {
    const source = readIssueDetailBreadcrumb(
      issue.identifier ?? issue.id,
      location.state,
      location.search,
    );
    const listHref = source?.href && (source.href.includes("analysis-executions") || source.href.includes("taskType=analysis"))
      ? source.href
      : "/issues?taskType=analysis&" +
        new URLSearchParams({
          projectId: analysis.data.analysis.execution.projectId,
        });
    return (
      <AnalysisTaskDetail
        key={issue.companyId + issue.id}
        detail={analysis.data.analysis}
        listHref={listHref}
        platformDeliverables={<IssuePropertiesArtifactsTab issue={issue} />}
      />
    );
  }
  const collaborationHref = `/issues/${issue.identifier ?? issue.id}?detailView=collaboration`;
  return (
    <TaskDetailLayout
      overview={
        <div className="space-y-2 text-sm">
          <p className="text-xs text-muted-foreground">
            {issue.identifier ?? issue.id}
          </p>
          <h3 className="font-semibold">{issue.title}</h3>
          <TaskIdentitySummary
            companyId={issue.companyId}
            seatId={issue.assigneeAgentId}
            ownerUserId={issue.assigneeUserId}
            projectName={issue.project?.name}
          />
          <DeliveryWorkflowTaskLink companyId={issue.companyId} taskId={issue.id}/>
          <p>任务状态：{statuses[issue.status] ?? issue.status}</p>
          <p className="text-xs text-muted-foreground">
            任务状态、实际执行与正式交付分别核对。
          </p>
          <details>
            <summary className="cursor-pointer">任务说明</summary>
            <p className="mt-3 whitespace-pre-wrap break-words">
              {issue.description?.replace(
                /<!-- (?:DSP7-JIRA-INTAKE|DELIVERY-WORKFLOW) .*? -->/gs,
                "",
              ) || "暂无说明"}
            </p>
          </details>
        </div>
      }
      actions={
        <div className="space-y-3">
          {delivery.isSuccess && !delivery.data && <Dsp7ExecutionStatus key={issue.id} issue={issue} />}
          <p className="text-sm text-muted-foreground">
            业务提问、审批与协作答复在任务对话中处理；本机 Claude
            权限确认仍需在终端处理。
          </p>
          {
            <Link
              state={location.state}
              className="text-sm underline"
              to={collaborationHref}
            >
              查看任务对话与决策
            </Link>
          }
        </div>
      }
      progress={
        <div className="space-y-3">
          <JiraRequirementPanel issue={issue} />
          <p className="text-sm text-muted-foreground">
            原生阶段、门禁证据与阶段耗时按所选执行会话展示；未上报不代表通过，运行结束不代表验收完成。
          </p>
          <ManagedSessionPanel
            companyId={issue.companyId}
            taskId={issue.id}
            view="progress"
          />
        </div>
      }
      deliverables={
        <div className="space-y-2 text-sm">
          <p className="text-muted-foreground">
            原有附件、工作成果和交付记录继续保留；正式验收以对应需求条目的交付流程为准。
          </p>
          <IssuePropertiesArtifactsTab issue={issue} />
          {
            <Link
              state={location.state}
              className="underline"
              to={collaborationHref}
            >
              查看完整成果、附件与活动记录
            </Link>
          }
        </div>
      }
      records={
        <ManagedSessionPanel
          key={issue.id}
          companyId={issue.companyId}
          taskId={issue.id}
          view="records"
        />
      }
    />
  );
}
