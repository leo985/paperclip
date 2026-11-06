import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { DELIVERY_STAGE_LABELS, DELIVERY_STAGES, type DeliveryEntryDetail, type DeliveryWorkflow } from "@paperclipai/shared";
import { analysisApi } from "@/api/analysis-executions";
import { Link } from "@/lib/router";
import { Button } from "./ui/button";

export function DeliveryMaterials({ companyId, detail, workflow, workflowState = "ready" }: { companyId: string; detail: DeliveryEntryDetail; workflow?: DeliveryWorkflow; workflowState?: "ready" | "loading" | "unavailable" }) {
  const { snapshot } = detail;
  return <section className="space-y-4" aria-label="条目交付证据索引">
    <div className="space-y-2"><h2 className="text-lg font-semibold">交付证据与待核验项</h2><p className="text-sm text-muted-foreground">当前来源版本：{new Date(snapshot.collectedAt).toLocaleString("zh-CN")}。材料、评审与验收分别列出，未登记不代表来源中不存在。</p></div>
    {workflowState !== "ready" && <p role="status" className="text-sm text-muted-foreground">{workflowState === "loading" ? "正在读取阶段核验与正式验收记录。" : "阶段核验与正式验收记录当前不可读取，以下索引不表示材料或验收记录不存在，请进入原流程核实。"}</p>}
    <p className="text-xs text-muted-foreground md:hidden">可横向滚动查看完整材料与核验入口。</p>
    <div className="overflow-x-auto" tabIndex={0} role="region" aria-label="阶段材料表，可横向滚动"><table className="w-full min-w-3xl text-left text-sm"><caption className="sr-only">各阶段交付材料、版本和核验入口</caption><thead><tr className="border-b border-border">{["交付阶段", "材料与版本", "核验情况与责任", "下一步"].map(label => <th scope="col" key={label} className="p-3">{label}</th>)}</tr></thead><tbody>{DELIVERY_STAGES.map(stage => {
      const record = workflow?.stages.find(s => s.stage === stage);
      const receipt = record?.receipt;
      const independentAnalysis = stage === "analysis";
      const current = !!receipt && receipt.inputDigest === record?.inputDigest && receipt.taskId === record?.taskId && receipt.stage === stage && receipt.runId === record?.runId && receipt.jiraKey === record?.jiraKey;
      const reviewed = !!record?.review && record.review.digest === record.receiptDigest && record.review.decision === "approve";
      const requiresReview = stage === "design" || stage === "test-cases";
      const sourcePath = record ? stage === "analysis" ? `/analysis-executions?projectId=${snapshot.projectId}&executionId=${record.taskId}` : `/issues/${record.taskId}` : "/delivery?" + new URLSearchParams({ projectId: snapshot.projectId, snapshotId: snapshot.id, tab: stage === "analysis" ? "analysis" : "work", stage });
      return <tr key={stage} className="border-b border-border align-top"><th scope="row" className="p-3 font-medium">{DELIVERY_STAGE_LABELS[stage]}</th><td className="space-y-2 p-3"><p>{independentAnalysis ? "分析材料按独立修订登记，见下方分析索引或分析详情。" : receipt ? `${receipt.artifacts.length} 个产物已登记` : workflowState !== "ready" ? "流程交付回执待核实" : "尚无流程交付回执"}</p>{receipt && <details className="text-xs text-muted-foreground"><summary className="cursor-pointer">产物清单与版本指纹</summary><p className="break-all font-mono">交付版本：{record?.receiptDigest ?? "未记录"}</p>{receipt.artifacts.map(a => <p key={a.path} className="break-all font-mono">{a.path} · {a.sha256}</p>)}</details>}{receipt && <a className="text-xs underline" href={receipt.jiraReference} target="_blank" rel="noreferrer">打开 Jira 正式材料</a>}</td><td className="space-y-2 p-3"><p>{independentAnalysis ? record?.state === "done" ? "已登记分析发布，版本依据请查看分析详情" : "分析发布待核验" : !receipt ? "待核验材料" : !current ? "材料版本待重新核对" : requiresReview && !reviewed ? "本版本待正式评审核验" : record?.state === "done" ? "本阶段已核验交付" : "已有材料，待阶段核验"}</p>{record?.review && <p className="text-xs text-muted-foreground">评审登记人：{record.review.by} · {new Date(record.review.at).toLocaleString("zh-CN")}{!reviewed ? " · 当前版本尚未通过" : ""}</p>}{record?.review && <a className="text-xs underline" href={record.review.reference} target="_blank" rel="noreferrer">查看评审依据</a>}{record && <Link className="block text-xs underline" to={`/seats?seat=${record.seatId}`}>查看执行席位与负责人</Link>}</td><td className="space-y-2 p-3"><p className="text-xs text-muted-foreground">{record?.message ?? (receipt ? "核对当前版本、正式材料与阶段结论。" : "到对应分析或工单查看、补齐材料。")}</p><Link className="underline" to={sourcePath}>{record ? "查看材料与核验流程" : "查找关联任务"}</Link></td></tr>;
    })}</tbody></table></div>
    {detail.analyses.length > 0 && <section className="space-y-3"><h3 className="font-medium">独立分析修订材料</h3>{detail.analyses.map(a => <AnalysisMaterial key={a.id} companyId={companyId} id={a.id} title={a.title} revision={a.revision} projectId={snapshot.projectId}/>)}</section>}
    <div className="space-y-2 rounded-lg bg-muted p-3 text-sm"><p>正式验收：{workflowState !== "ready" ? "正式验收记录待核实" : workflow?.state === "completed" && workflow.acceptance ? "已登记正式验收" : "尚未登记正式验收结论"}</p>{workflow?.acceptance && <><p>登记人：{workflow.acceptance.by} · {new Date(workflow.acceptance.at).toLocaleString("zh-CN")}</p><a className="underline" href={workflow.acceptance.reference} target="_blank" rel="noreferrer">查看验收结论</a></>}<p className="text-xs text-muted-foreground">运行结束、材料已登记、来源工单完成均不替代正式评审和验收。</p></div>
  </section>;
}

function AnalysisMaterial({ companyId, id, title, revision, projectId }: { companyId: string; id: string; title: string; revision: number; projectId: string }) {
  const [open, setOpen] = useState(false);
  const data = useQuery({ queryKey: ["management-analysis-material", companyId, id], queryFn: () => analysisApi.detail(companyId, id), enabled: open, retry: false });
  const execution = data.data?.execution;
  return <details className="space-y-2 rounded-lg border border-border p-3" onToggle={e => setOpen(e.currentTarget.open)}><summary className="cursor-pointer text-sm font-medium">{title} · 修订 {revision}</summary>{open && <div className="space-y-2 pt-2 text-sm">{data.isPending && <p>正在读取材料索引…</p>}{data.isError && <p role="alert">材料索引读取失败或无访问权限。<Button size="sm" variant="outline" onClick={() => void data.refetch()}>重试</Button></p>}{execution && <><p>{execution.delivery ? `${execution.delivery.artifacts.length} 个分析产物已登记` : "尚未登记分析交付材料"} · {execution.publication ? "已登记正式发布" : "正式发布待核验"}</p>{execution.delivery?.artifacts.map(a => <p className="break-all font-mono text-xs text-muted-foreground" key={a.path}>{a.path} · {a.sha256}</p>)}{execution.publication && <><a className="underline" href={execution.publication.url} target="_blank" rel="noreferrer">打开正式发布材料</a><p className="text-xs text-muted-foreground">登记核验人：{execution.publication.verifiedBy} · {new Date(execution.publication.verifiedAt).toLocaleString("zh-CN")}</p></>}</>}<Link className="block underline" to={`/analysis-executions?projectId=${projectId}&executionId=${id}`}>查看分析、决定与发布核验</Link></div>}</details>;
}
