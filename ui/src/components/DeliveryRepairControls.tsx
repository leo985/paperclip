import { useMutation } from "@tanstack/react-query";
import { DELIVERY_MAX_REPAIR_CYCLES, type DeliveryStageRecord, type DeliveryWorkflow } from "@paperclipai/shared";
import { deliveryWorkflowApi } from "@/api/delivery-workflows";
import { Button } from "./ui/button";
export function DeliveryRepairControls({
  companyId,
  workflow,
  onChanged
}: {
  companyId: string;
  workflow: DeliveryWorkflow;
  onChanged: () => void;
}) {
  const stages = workflow.config.entryScope
    ? workflow.state === "active" ? workflow.stages.filter(stage => stage.branchBlocked) : []
    : workflow.state === "blocked" ? [workflow.stages.find(stage => stage.state !== "done")] : [];
  return stages.filter((stage): stage is DeliveryStageRecord => stage?.stage === "functional-test" && !!stage.receipt?.testResults?.failed)
    .map(failed => <FailedTestRepair key={failed.taskId} companyId={companyId} workflow={workflow} failed={failed} onChanged={onChanged} />);
}

function FailedTestRepair({ companyId, workflow, failed, onChanged }: {
  companyId: string;
  workflow: DeliveryWorkflow;
  failed: DeliveryStageRecord;
  onChanged: () => void;
}) {
  const policy = workflow.config.template?.definition.automaticRepair;
  const modules = new Set(failed?.receipt?.failureReport?.defects.map(d => d.module));
  const route = modules.size === 1 ? policy?.routes.find(r => modules.has(r.module)) : undefined;
  const work = workflow.stages.filter(s => s.stage === "coding" && !s.intent && !s.reviewWorkKeys && s.parentKey === failed?.parentKey && s.seatId === route?.developmentSeatId);
  const reviews = work.length === 1 ? workflow.stages.filter(s => s.intent === "code-review" && s.parentKey === failed?.parentKey && s.reviewWorkKeys?.includes(work[0].jiraKey ?? "")) : [];
  const reusable = !!route && work.length === 1 && reviews.length === 1 && !!work[0].jiraKey && !!reviews[0].jiraKey && !!failed?.jiraKey;
  const recheck = useMutation({
    mutationFn: () => deliveryWorkflowApi.retryAutomaticRepair(companyId, workflow.id, failed!.receiptDigest!),
    onSuccess: onChanged
  });
  const repair = useMutation({
    mutationFn: () => deliveryWorkflowApi.repair(companyId, workflow.id, {
      expectedReceiptDigest: failed!.receiptDigest!,
      defectKey: work[0].jiraKey!,
      reviewKey: reviews[0].jiraKey!,
      retestKey: failed!.jiraKey!,
      developmentSeatId: work[0].seatId,
      reviewSeatId: reviews[0].seatId,
      qaSeatId: failed!.seatId
    }),
    onSuccess: onChanged
  });
  const attempts = failed.repairHistory?.length ?? 0,
    limit = Math.min(policy?.maxCycles ?? DELIVERY_MAX_REPAIR_CYCLES, DELIVERY_MAX_REPAIR_CYCLES);
  return <div className="space-y-3 rounded-md border border-border p-3">
    <p className="text-sm">测试失败返工 {attempts}/{limit} 轮：原编码任务修改 → 原代码评审单复审 → 原功能测试单回归。保留原工单、任务与席位，每轮记录新运行和交付版本。</p>
    {reusable ? <p className="text-sm">原编码单：{work[0].jiraKey} · 原代码评审单：{reviews[0].jiraKey} · 原功能测试单：{failed.jiraKey}</p> : <p role="alert" className="text-sm">无法唯一定位模块对应的原编码和评审节点，请核对项目路由及条目已有工单。</p>}
    {failed.automaticRepair?.message && <p role="alert" className="text-sm">{failed.automaticRepair.message}</p>}
    {attempts >= limit ? <p role="alert">已达到返工上限，请人工核对。</p> : workflow.config.automaticRepairAuthorized ? <>
      <p className="text-sm">已授权自动复用原任务返工，等待旧运行停止核验及调度。</p>
      {failed.automaticRepair?.status === "blocked" && <Button type="button" variant="outline" disabled={recheck.isPending} onClick={() => recheck.mutate()}>处理阻碍后重新核对</Button>}
    </> : <Button type="button" variant="outline" disabled={!reusable || repair.isPending} onClick={() => repair.mutate()}>使用原任务发起本轮返工</Button>}
    {(repair.isError || recheck.isError) && <p role="alert" className="text-sm">返工未启动：{repair.error?.message ?? recheck.error?.message}</p>}
  </div>;
}
