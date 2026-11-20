import { useQuery } from "@tanstack/react-query";
import { deliveryWorkflowApi } from "@/api/delivery-workflows";
import { Link } from "@/lib/router";
import { deliveryRecordLabel } from "@paperclipai/shared";

export function DeliveryWorkflowTaskLink({ companyId, taskId }: {companyId:string;taskId:string}) {
  const query=useQuery({queryKey:["delivery-workflow-task",companyId,taskId],queryFn:()=>deliveryWorkflowApi.forTask(companyId,taskId),refetchInterval:5000,retry:false});
  if(query.isPending)return <p role="status">正在核对交付链节点…</p>;
  if(query.isError)return <p role="alert">交付链关联读取失败：{query.error.message}</p>;
  const context=query.data;if(!context)return null;
  return <section className="space-y-2 rounded-md border border-border p-3" aria-label="所属交付链节点">
    <p>{context.demandNo} · {deliveryRecordLabel(context.stage)}</p>
    <p className="text-xs text-muted-foreground">实例 {context.workflowId} · {context.stage.state === "pending" ? "等待前置条件或节点启动" : context.stage.executionMode === "human" && context.stage.state === "review" ? context.stage.reviewWorkKeys ? "待人工评审" : "待人工办理" : context.stage.message ?? context.stage.state}</p>
    <p className="text-xs text-muted-foreground">节点状态与执行人由交付链统一管理；请在实例中办理交付、评审、确认或恢复。</p>
    <Link className="underline" to={context.href}>{context.actions[0]?.actionLabel??"查看交付链节点与前置"}</Link>
  </section>;
}
