import { useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { DELIVERY_MAX_REPAIR_CYCLES, type DeliveryWorkflow } from "@paperclipai/shared";
import { deliveryWorkflowApi } from "@/api/delivery-workflows";
import { Button } from "./ui/button";
import { Input } from "./ui/input";

export function DeliveryRepairControls({ companyId, workflow, onChanged }: {
  companyId: string; workflow: DeliveryWorkflow; onChanged: () => void;
}) {
  const failed = workflow.stages.find(stage => stage.state !== "done");
  const [open, setOpen] = useState(false);
  const [receiptDigest, setReceiptDigest] = useState("");
  const [values, setValues] = useState({ defectKey: "", reviewKey: "", retestKey: "", developmentSeatId: "", reviewSeatId: "", qaSeatId: "" });
  const jiraKeys=[values.defectKey,values.reviewKey,values.retestKey].filter(key=>/^[A-Z][A-Z0-9_]*-\d+$/.test(key));
  const seats = useQuery({ queryKey: ["delivery-workflow-seats", companyId,workflow.snapshotId,jiraKeys.join(",")], queryFn: () => deliveryWorkflowApi.seats(companyId,workflow.snapshotId,jiraKeys), enabled: open&&jiraKeys.length>0 });
  const choices=(key:string,role:string)=>seats.data?.filter(seat=>seat.jiraKeys?.includes(key)&&seat.domains.some(domain=>domain.roles.includes(role)))??[];
  const pick=(key:string,role:string,selected:string)=>{const options=choices(key,role);return options.some(s=>s.id===selected)?selected:options.length===1?options[0].id:"";};
  const selected={...values,developmentSeatId:pick(values.defectKey,"bug-fix",values.developmentSeatId),reviewSeatId:pick(values.reviewKey,"code-review",values.reviewSeatId),qaSeatId:pick(values.retestKey,"functional-test",values.qaSeatId)};
  const repair = useMutation({
    mutationFn: () => deliveryWorkflowApi.repair(companyId, workflow.id, { ...selected, expectedReceiptDigest: receiptDigest }),
    onSuccess: () => { setOpen(false); onChanged(); },
  });
  if (workflow.state !== "blocked" || failed?.stage !== "functional-test" || !failed.receipt?.testResults?.failed) return null;
  const attempts = failed.repairHistory?.length ?? 0;
  const exhausted = attempts >= DELIVERY_MAX_REPAIR_CYCLES;
  return <div className="space-y-3 rounded-md border border-border p-3">
    <p className="text-sm">修复链 {attempts}/{DELIVERY_MAX_REPAIR_CYCLES} 轮：缺陷修复 → 独立代码评审 → 重测。使用已有真实工单，不自动创建缺陷；旧进程须先核验停止。按各工单 Jira 经办人匹配具备相应能力的席位。</p>
    {exhausted ? <p role="alert">已达到修复上限，请人工排查并重新规划。</p> : !open ? <Button variant="outline" onClick={() => { setReceiptDigest(failed.receiptDigest!); setOpen(true); }}>配置本轮修复链</Button> : <form className="space-y-3" onSubmit={event => { event.preventDefault(); repair.mutate(); }}>
      {([ ["defectKey", "已有缺陷工单"], ["reviewKey", "独立代码评审工单"], ["retestKey", "重测执行工单"] ] as const).map(([key, label]) => <label className="block space-y-1 text-sm" key={key}>{label}<Input required value={values[key]} onChange={event => setValues(old => ({ ...old, [key]: event.target.value.trim() }))} /></label>)}
      {([ ["developmentSeatId", "修复席位", "bug-fix"], ["reviewSeatId", "独立评审席位", "code-review"], ["qaSeatId", "QA 重测席位", "functional-test"] ] as const).map(([key, label, role]) => <label className="block space-y-1 text-sm" key={key}>{label}<select required className="w-full rounded-md border border-border bg-background p-2 text-sm" value={selected[key]} onChange={event => setValues(old => ({ ...old, [key]: event.target.value }))}><option value="">请选择席位</option>{choices(key==="developmentSeatId"?values.defectKey:key==="reviewSeatId"?values.reviewKey:values.retestKey,role).map(seat => <option key={seat.id} value={seat.id} disabled={key === "reviewSeatId" && seat.id === selected.developmentSeatId}>{seat.name}{seat.online ? "" : "（离线，等待上线后执行）"}</option>)}</select></label>)}
      {seats.isPending && <p role="status">正在读取登记席位…</p>}
      {seats.isError && <p role="alert">席位读取失败：{seats.error.message}</p>}
      {repair.isError && <p role="alert">修复链未启动：{repair.error.message}</p>}
      <div className="flex items-center justify-between"><Button type="button" variant="ghost" disabled={repair.isPending} onClick={() => setOpen(false)}>取消</Button><Button type="submit" disabled={repair.isPending || !selected.developmentSeatId || !selected.reviewSeatId || !selected.qaSeatId || selected.developmentSeatId === selected.reviewSeatId}>授权本轮修复链</Button></div>
    </form>}
  </div>;
}
