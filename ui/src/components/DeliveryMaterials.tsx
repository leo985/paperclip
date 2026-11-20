import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { deliveryRecordLabel, type DeliveryEntryDetail, type DeliveryStageRecord, type DeliveryWorkflow } from "@paperclipai/shared";
import { analysisApi } from "@/api/analysis-executions";
import { Link } from "@/lib/router";
import { DELIVERY_ANALYSIS_SECTION_ID } from "@/lib/delivery-entry-stages";
import { Button } from "./ui/button";

export type DeliveryEvidenceState = "ready" | "loading" | "unavailable";

export function deliveryEvidenceRecords(workflows: DeliveryWorkflow[]) {
  const recordsByTask = new Map<string, DeliveryStageRecord>();
  for (const workflow of [...workflows].sort((a, b) => (a.updatedAt ?? "").localeCompare(b.updatedAt ?? ""))) {
    for (const record of workflow.stages) recordsByTask.set(record.taskId, record);
  }
  return [...recordsByTask.values()];
}

export function DeliveryEvidence({ record, showTask = false }: { record: DeliveryStageRecord; showTask?: boolean }) {
  return <div className="space-y-2">
    <p className="font-medium">{deliveryVerification(record)}</p>
    {record.message && record.state !== "done" && <p className="text-xs text-muted-foreground">{record.message}</p>}
    <MaterialEvidence record={record} />
    {showTask && <Link className="underline" to={`/issues/${record.taskId}`}>查看任务 · {deliveryRecordLabel(record)}</Link>}
  </div>;
}

function deliveryVerification(record: DeliveryStageRecord) {
  if (record.priorCompletion) return "已复用历史交付";
  if (record.manualDelivery && record.state === "done") return "已登记人工交付";
  const { receipt, review } = record;
  if (!receipt) {
    if (review?.decision === "reject") return "评审退回";
    if (review?.decision === "approve" && record.state === "done") return "正式评审已通过";
    return record.state === "review" ? "待核验材料" : "尚未登记交付证据";
  }
  const current = receipt.inputDigest === record.inputDigest && receipt.taskId === record.taskId &&
    receipt.stage === record.stage && receipt.runId === record.runId && receipt.jiraKey === record.jiraKey;
  if (!current) return "材料版本待重新核对";
  if (review?.decision === "reject" && review.digest === record.receiptDigest) return "评审退回";
  const needsReview = record.requiresReview ?? (record.stage === "design" || record.stage === "test-cases");
  if (needsReview && (review?.decision !== "approve" || review.digest !== record.receiptDigest)) return "本版本待正式评审核验";
  return record.state === "done" ? "本阶段已核验交付" : "已有材料，待阶段核验";
}

function MaterialEvidence({ record }: { record: DeliveryStageRecord }) {
  const { receipt, manualDelivery, priorCompletion, review } = record;
  const jira = priorCompletion?.jiraEvidence;
  const artifacts = receipt?.artifacts ?? jira?.artifacts ?? [];
  const downloads = new Set(artifacts.map(artifact => artifact.downloadUrl));
  const references = [...new Set([...(priorCompletion?.artifactReferences ?? []), ...(manualDelivery?.artifactReferences ?? [])])]
    .filter(url => url && !downloads.has(url));
  const conclusion = jira?.reviewResult ?? jira?.testResult;
  const tests = receipt?.testResults ?? manualDelivery?.testResults;
  const officialReference = priorCompletion?.reviewReference || review?.reference || receipt?.jiraReference;
  const version = manualDelivery?.version ?? priorCompletion?.version ?? record.receiptDigest;
  return <div className="space-y-2">
    {conclusion && <p className="whitespace-pre-wrap">Jira 结果描述：{conclusion}</p>}
    {receipt?.codeReview && <p>代码评审：{receipt.codeReview.decision === "passed" ? "通过" : "退回"}</p>}
    {receipt?.domainReview && <p>评审报告结论：通过</p>}
    {tests && <p>用例 {tests.total} 项 · 通过 {tests.passed} · 失败 {tests.failed} · 阻塞 {tests.blocked} · 跳过 {tests.skipped}{receipt?.testResults && <> · 被测版本 {receipt.testResults.testedVersion}</>}</p>}
    {!tests && priorCompletion?.passedTests !== undefined && <p>功能测试通过 {priorCompletion.passedTests} 项</p>}
    {version && <details className="text-xs text-muted-foreground"><summary className="cursor-pointer">交付版本</summary><p className="break-all font-mono">{version}</p></details>}
    {artifacts.length > 0 && <ul className="space-y-1">{artifacts.map(artifact => <li key={`${artifact.path}:${artifact.sha256}`}>
      {artifact.downloadUrl
        ? <a className="break-all underline" href={artifact.downloadUrl} target="_blank" rel="noreferrer">{artifact.path}</a>
        : <span className="break-all">{artifact.path}</span>}
      <details className="text-xs text-muted-foreground"><summary className="cursor-pointer">SHA-256</summary><p className="break-all font-mono">{artifact.sha256}</p></details>
    </li>)}</ul>}
    {references.map((url, index) => <p key={url}><a className="underline" href={url} target="_blank" rel="noreferrer">交付材料链接{references.length > 1 ? ` ${index + 1}` : ""}</a></p>)}
    {officialReference && <a className="underline" href={officialReference} target="_blank" rel="noreferrer">{priorCompletion || review ? "查看正式评审或完成依据" : "打开 Jira 正式材料"}</a>}
    {review && <p className="text-xs text-muted-foreground">评审登记人：{review.by} · {new Date(review.at).toLocaleString("zh-CN")}{review.decision === "reject" ? " · 退回" : " · 通过"}</p>}
    {review?.note && <p className="whitespace-pre-wrap">评审说明：{review.note}</p>}
    {jira && !conclusion && jira.comments.length > 0 && <p className="text-xs text-muted-foreground">已归档 {jira.comments.length} 条 Jira 评论</p>}
    {!receipt && !priorCompletion && !manualDelivery && !review && <p className="text-muted-foreground">尚无流程交付回执</p>}
  </div>;
}

export function DeliveryEntryEvidence({ companyId, detail, records, workflows, workflowState }: {
  companyId: string;
  detail: DeliveryEntryDetail;
  records: DeliveryStageRecord[];
  workflows: DeliveryWorkflow[];
  workflowState: DeliveryEvidenceState;
}) {
  const { snapshot } = detail;
  const analysisRecords = records.filter(record => record.stage === "analysis");
  const acceptances = workflows.filter(workflow => workflow.state === "completed" && workflow.acceptance);
  const analysisParams = new URLSearchParams({ projectId: snapshot.projectId, snapshotId: snapshot.id, stage: "analysis", tab: "work" });
  return <div className="space-y-4">
    <section className="space-y-3 rounded-lg border border-border p-4" aria-label="条目级需求分析材料">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="font-semibold">条目级需求分析材料</h3>
        <Link className="text-sm underline" to={`/delivery?${analysisParams}#${DELIVERY_ANALYSIS_SECTION_ID}`}>查看需求分析</Link>
      </div>
      {analysisRecords.map(record => <div key={record.taskId} className="text-sm"><DeliveryEvidence record={record} showTask /></div>)}
      {detail.analyses.map(a => <AnalysisMaterial key={a.id} companyId={companyId} id={a.id} title={a.title} revision={a.revision} projectId={snapshot.projectId}/>)}
      {analysisRecords.length === 0 && detail.analyses.length === 0 && <p className="text-sm text-muted-foreground">无需求分析任务</p>}
    </section>
    <section className="space-y-2 rounded-lg bg-muted p-3 text-sm" aria-label="正式验收">
      <h3 className="font-medium">正式验收</h3>
      {workflowState !== "ready" && <p>正式验收记录待核实</p>}
      {workflowState === "ready" && acceptances.length === 0 && <p>尚未登记正式验收结论</p>}
      {acceptances.map(workflow => {
        const acceptance = workflow.acceptance!;
        const parents = [...new Set(workflow.stages.flatMap(record => record.parentKey ? [record.parentKey] : []))];
        const scope = workflow.config?.entryScope ? "条目验收" : parents.length ? parents.join("、") : "交付链验收";
        return <div key={workflow.id} className="space-y-1">
          <a className="underline" href={acceptance.reference} target="_blank" rel="noreferrer">查看正式验收结论 · {scope}</a>
          <p className="text-muted-foreground">登记人：{acceptance.by} · {new Date(acceptance.at).toLocaleString("zh-CN")}</p>
        </div>;
      })}
    </section>
  </div>;
}

function AnalysisMaterial({ companyId, id, title, revision, projectId }: { companyId: string; id: string; title: string; revision: number; projectId: string }) {
  const [open, setOpen] = useState(false);
  const data = useQuery({ queryKey: ["management-analysis-material", companyId, id], queryFn: () => analysisApi.detail(companyId, id), enabled: open, retry: false });
  const execution = data.data?.execution;
  return <details className="space-y-2 rounded-lg border border-border p-3" onToggle={e => setOpen(e.currentTarget.open)}><summary className="cursor-pointer text-sm font-medium">{title} · 修订 {revision}</summary>{open && <div className="space-y-2 pt-2 text-sm">{data.isPending && <p>正在读取材料索引…</p>}{data.isError && <p role="alert">材料索引读取失败或无访问权限。<Button size="sm" variant="outline" onClick={() => void data.refetch()}>重试</Button></p>}{execution && <><p>{execution.delivery ? `${execution.delivery.artifacts.length} 个分析产物已登记` : "尚未登记分析交付材料"} · {execution.publication ? "已登记正式发布" : "正式发布待核验"}</p>{execution.delivery?.artifacts.map(a => <p className="break-all font-mono text-xs text-muted-foreground" key={a.path}>{a.path} · {a.sha256}</p>)}{execution.publication && <><a className="underline" href={execution.publication.url} target="_blank" rel="noreferrer">打开正式发布材料</a><p className="text-xs text-muted-foreground">登记核验人：{execution.publication.verifiedBy} · {new Date(execution.publication.verifiedAt).toLocaleString("zh-CN")}</p></>}</>}<Link className="block underline" to={`/analysis-executions?projectId=${projectId}&executionId=${id}`}>查看分析、决定与发布核验</Link></div>}</details>;
}
