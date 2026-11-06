import { DELIVERY_CHAIN_ADMISSION_LABELS, DELIVERY_STAGE_LABELS, type DeliveryChainAdmission } from "@paperclipai/shared";
import { Link } from "@/lib/router";

export function DeliveryChainAdmissionPanel({admission}:{admission?:DeliveryChainAdmission}) {
  return <section aria-label="交付链准入" className="space-y-3 rounded-lg border border-border p-4">
    <h2 className="font-semibold">交付链准入 · {admission ? DELIVERY_CHAIN_ADMISSION_LABELS[admission.state] : "待核验"}</h2>
    {admission?.template&&<p className="text-sm">{admission.template.definition.name} · v{admission.template.revision}{admission.startStage ? ` · 开始节点：${DELIVERY_STAGE_LABELS[admission.startStage]}` : ""}</p>}
    <p className="text-sm text-muted-foreground">只核验进入交付链的开始节点条件；后续编码、评审与测试条件在对应阶段核验。</p>
    {admission?.checks.map(check=><p key={check.key} className="text-sm">{check.passed?"已满足":"未满足"} · {check.label}</p>)}
    {admission?.reasons.map(reason=><p key={reason} className="text-sm">{reason}</p>)}
    {!admission&&<p className="text-sm">交付链准入数据尚未就绪，请刷新后重试。</p>}
    <Link className="text-sm underline" to="/delivery-chain">查看或配置交付链准入规则</Link>
  </section>;
}
