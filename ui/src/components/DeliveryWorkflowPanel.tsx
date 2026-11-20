import { AutomaticDeliveryStart } from "./AutomaticDeliveryStart";
import { deliveryReviewEntryStage } from "@/lib/delivery-review-entry";
import { deliveryTemplatesApi } from "@/api/delivery-templates";
import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@/lib/router";
import {
  DELIVERY_STAGE_LABELS,
  DELIVERY_REVIEW_LABELS,
  deliverySequenceLabel,
  deliveryRecordLabel,
  deliveryReviewDigest,
  DELIVERY_STAGE_MAX_RESUMES,
  type DeliverySnapshot,
  type DeliveryStageRecord,
} from "@paperclipai/shared";
import { deliveryPlanPreviewQuery, deliveryWorkflowApi } from "@/api/delivery-workflows";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { DeliveryRepairControls } from "./DeliveryRepairControls";
const field =
  "w-full rounded-md border border-border bg-background p-2 text-sm";
const states: Record<string, string> = {
  pending: "等待前置交付",
  queued: "等待席位领取",
  running: "执行中",
  waiting: "等待人工决定",
  review: "交付待核验",
  done: "已核验交付",
  interrupted: "中断待处理",
  active: "自动交付中",
  blocked: "流程已阻塞",
  acceptance: "待正式验收",
  completed: "已登记正式验收",
  cancelled: "已取消",
};
export function DeliveryWorkflowPanel({
  companyId,
  snapshot,
  canManage,
  startRequested = false,
  initialReviewKey = "",
  viewPlanRequest,
}: {
  companyId: string;
  snapshot: DeliverySnapshot;
  canManage: boolean;
  startRequested?: boolean;
  initialReviewKey?: string;
  viewPlanRequest?: string;
}) {
  const [expanded, setExpanded] = useState(false);
  useEffect(() => {
    if ((startRequested || initialReviewKey) && canManage) setExpanded(true);
  }, [startRequested, initialReviewKey, canManage]);
  const workflows = useQuery({
    queryKey: ["delivery-workflows", companyId, snapshot.id],
    queryFn: () => deliveryWorkflowApi.list(companyId, snapshot.id),
    refetchInterval: 5000,
  });
  const template = useQuery({
    queryKey: ["delivery-template", companyId, snapshot.projectId],
    queryFn: () => deliveryTemplatesApi.get(companyId, snapshot.projectId),
  });
  const definition = template.data?.effective.definition;
  const requestedReview = snapshot.plan.items.find(item => item.key === initialReviewKey && item.parentKey);
  const requestedReviewStage = requestedReview && deliveryReviewEntryStage(requestedReview);
  const flow = workflows.data?.[0];
  const displayDefinition = flow?.config.template?.definition ?? definition;
  const canOpenPlan = canManage && (!flow || (flow.config.entryScope
    ? ["active", "acceptance"].includes(flow.state)
    : (snapshot.plan.mains?.length ?? 0) > 1 && (["active", "acceptance", "completed"].includes(flow.state) ||
      (flow.state === "blocked" && flow.message?.startsWith("来源输入已变化")))));
  const savedPlan = useQuery({
    ...deliveryPlanPreviewQuery(companyId, snapshot.id),
    enabled: canOpenPlan && workflows.isSuccess && !flow,
  });
  const canShowPlan = (canOpenPlan && workflows.isSuccess) || !!flow?.stages.length;
  const canViewWithoutGenerating = canShowPlan && (!!savedPlan.data || !canOpenPlan);
  useEffect(() => {
    if (viewPlanRequest !== undefined && canViewWithoutGenerating) setExpanded(true);
  }, [viewPlanRequest, canViewWithoutGenerating]);
  const checkingPlan = !flow && (savedPlan.isPending || (savedPlan.isFetching && !savedPlan.data));
  const planLookupFailed = !flow && savedPlan.isError && !savedPlan.data;
  const planLabel = flow || savedPlan.data ? "查看计划"
    : checkingPlan ? "正在读取交付计划…"
      : planLookupFailed ? "重试读取交付计划" : "生成交付计划";
  const sharedAnalysisDone = !flow?.stages.some(stage => stage.stage === "analysis" && stage.state !== "done");
  const inScopeMains = (snapshot.plan.mains ?? []).filter(main => !flow?.config.entryScope?.ignoredParentKeys?.includes(main.key));
  const verifiedMains = sharedAnalysisDone ? inScopeMains.filter(main =>
    flow?.config.entryScope?.branches[main.key] &&
    !flow.stages.some(stage => stage.parentKey === main.key && stage.state !== "done"),
  ).length : 0;
  return (
    <section
      className="space-y-4 rounded-lg border border-border p-4"
      aria-label="条目自动交付"
    >
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="font-semibold">{requestedReviewStage ? `${DELIVERY_REVIEW_LABELS[requestedReviewStage]}交付计划` : "交付计划"}</h2>
          <details className="text-sm text-muted-foreground"><summary className="cursor-pointer">查看交付流程</summary><p>
            {displayDefinition
              ? Object.entries(displayDefinition.stages)
                  .filter(([, v]) => v.enabled)
                  .map(
                    ([k, v]) =>
                      deliverySequenceLabel(k as DeliveryStageRecord["stage"],v) +
                      (v.review !== "none" && (v.taskSequence !== "work_then_review" || k === "coding") ? " → 人工核验" : ""),
                  )
                  .join(" → ") + " → 正式验收"
              : "正在读取交付模板…"}
          </p></details>
        </div>
        {canShowPlan && (
          <Button
            variant="outline"
            disabled={!expanded && checkingPlan}
            onClick={() => {
              if (!expanded && planLookupFailed) void savedPlan.refetch();
              else setExpanded(!expanded);
            }}
          >
            {expanded ? "收起计划" : planLabel}
          </Button>
        )}
      </div>
      {flow && <p className="text-xs text-muted-foreground">实例：{flow.id} · 节点按前置条件激活，未到达节点不生成可处理待办。</p>}
      {!!flow?.config.entryScope?.ignoredParentKeys?.length && (
        <p className="text-sm text-muted-foreground">已排除出交付和验收范围 · {flow.config.entryScope.ignoredParentKeys.join("、")}</p>
      )}
      <p className="text-sm">
        <Link className="underline" to="/delivery-chain">
          交付链设置
        </Link>{" "}
        · {flow?.config.template?.definition.name ?? definition?.name} · v
        {flow?.config.template?.revision ?? template.data?.effective.revision}
      </p>
      {initialReviewKey && <div className="space-y-2 rounded-md border border-border p-3 text-sm" aria-label="所选评审执行配置">
        {!requestedReviewStage ? <p role="alert">该工单不是当前条目中的设计、代码或用例评审子单，请重新选择。</p> : <>
          <p className="font-medium">当前评审：{initialReviewKey}{requestedReview?.assignee ? ` · ${requestedReview.assignee}` : ""}</p>
          {flow ? flow.stages.some(stage => stage.jiraKey === initialReviewKey) ? <>{flow.stages.filter(stage => stage.jiraKey === initialReviewKey).map(stage => <Link key={stage.taskId} className="underline" to={`/issues/${stage.taskId}`}>查看已有评审任务与处理记录</Link>)}<p>已有评审沿用当前流程，不重复创建或派发。</p></> : <p role="alert">当前交付实例未绑定该评审单。请同步最新来源，并在主工单计划中核对是否可以纳入。</p> : !definition ? <p role="status">正在核对项目评审配置…</p> : !definition.stages[requestedReviewStage].enabled || definition.stages[requestedReviewStage].taskSequence !== "work_then_review" ? <p role="alert">项目模板尚未启用该阶段的独立评审工单。请在交付链设置中核对项目固有流程，再启动新实例；本次不会自动修改模板。</p> : <p>按 Jira 类型自动识别评审单，等待同一主工单下对应阶段的全部工作子单完成。已完成工单自动核验并复用成果。</p>}
        </>}
      </div>}
      {template.isError && (
        <p role="alert">模板读取失败：{template.error.message}</p>
      )}
      {workflows.isPending ? (
        <p role="status">正在读取交付流程…</p>
      ) : workflows.isError ? (
        <p role="alert">
          读取失败：{workflows.error.message}
          <Button variant="ghost" onClick={() => void workflows.refetch()}>
            重试
          </Button>
        </p>
      ) : flow ? (
        <>
          <p className="font-medium">
            {flow.state === "active" && verifiedMains ? "部分交付" : states[flow.state] ?? flow.state}
            {flow.config.entryScope && " · " + verifiedMains + " / " + inScopeMains.length + " 个主工单完成核验"}
          </p>
          {canManage && !["completed", "cancelled"].includes(flow.state) && (
            <Cancel
              companyId={companyId}
              flowId={flow.id}
              refresh={() => void workflows.refetch()}
            />
          )}
          {flow.message && (
            <p role="status" className="text-sm">
              {flow.message}
            </p>
          )}
          {canManage && (
            <DeliveryRepairControls
              companyId={companyId}
              workflow={flow}
              onChanged={() => void workflows.refetch()}
            />
          )}
          <ol className="space-y-3">
            {flow.stages.map((s) => (
              <li
                key={s.taskId}
                id={`delivery-node-${s.taskId}`}
                className="space-y-2 rounded-md border border-border p-3"
              >
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <p className="font-medium">
                    {s.parentKey && flow.config.entryScope && s.parentKey + " · "}{deliveryRecordLabel(s)}{" "}
                    · {s.historicalVerification && s.state === "review" ? "历史交付待核验" : s.executionMode === "human" && s.state === "review" ? s.reviewWorkKeys ? "待人工评审" : "待人工办理" : states[s.state]}
                  </p>
                  <Link
                    className="text-sm underline"
                    to={
                      s.stage === "analysis" && !s.priorCompletion
                        ? `/analysis-executions?executionId=${s.taskId}&projectId=${flow.projectId}`
                        : `/issues/${s.taskId}`
                    }
                  >
                    {s.stage === "analysis" && !s.priorCompletion
                      ? "分析、决定与正式发布"
                      : "执行记录与完整对话"}
                  </Link>
                </div>
                <p className="text-xs text-muted-foreground">工单：{s.jiraKey??"条目级分析"} · 前置：{s.dependsOn?.length?s.dependsOn.map(id=>flow.stages.find(p=>p.taskId===id)?.jiraKey??"需求分析").join("、"):"流程起点"}{s.executionMode==="human"&&!s.historicalVerification?s.reviewWorkKeys?" · 由负责人完成正式评审并登记结论":" · 由负责人完成人工工作单并登记交付":""}</p>
                {!s.branchBlocked && s.startMode === "confirmation" &&
                  !s.startApprovedBy &&
                  !s.runId &&
                  (s.dependsOn ?? []).every((id) =>
                    flow.stages.some(
                      (up) => up.taskId === id && up.state === "done",
                    ),
                  ) && (
                    <ConfirmStart
                      companyId={companyId}
                      flowId={flow.id}
                      stage={s}
                      refresh={() => void workflows.refetch()}
                    />
                  )}
                {!s.priorCompletion && !s.deferredPriorCompletion && <p className="text-sm">{s.historicalVerification ? "人工核验历史交付" : s.executionMode === "human" ? "执行方式：人工" : "执行方式：Agent"}{s.executionMode==="human"?` · 负责人 ${s.reviewerUserId}`:""}</p>}
                {s.priorCompletion && <div className="space-y-2 text-sm"><p>启动前已完成 · 版本 {s.priorCompletion.version} · 确认人 {s.priorCompletion.by}</p>{s.priorCompletion.jiraEvidence?.reviewResult && <p>Jira 结果描述：{s.priorCompletion.jiraEvidence.reviewResult}</p>}{s.priorCompletion.jiraEvidence?.testResult && <p>Jira 结果描述：{s.priorCompletion.jiraEvidence.testResult}</p>}{s.priorCompletion.passedTests !== undefined && <p>功能测试全部通过：{s.priorCompletion.passedTests} 项</p>}{s.priorCompletion.artifactReferences.map(url=><p key={url}><a className="underline" href={url} target="_blank" rel="noreferrer">已有成果</a></p>)}<a className="underline" href={s.priorCompletion.reviewReference} target="_blank" rel="noreferrer">正式评审／完成依据</a></div>}
                {s.manualDelivery && <div className="space-y-2 text-sm"><p>人工交付版本：{s.manualDelivery.version}</p>{s.manualDelivery.artifactReferences.map(url=><p key={url}><a className="underline" href={url} target="_blank" rel="noreferrer">正式交付材料</a></p>)}</div>}
                {s.jiraKey && <p className="text-sm">{s.jiraKey}</p>}
                {s.message && <p className="text-sm">{s.message}</p>}
                {!!s.repairHistory?.length && (
                  <details className="text-sm">
                    <summary>
                      修复历史与原失败证据（{s.repairHistory.length} 轮）
                    </summary>
                    {s.repairHistory.map((cycle) => (
                      <p key={cycle.attempt} className="break-all">
                        第 {cycle.attempt} 轮 ·{" "}
                        <Link
                          className="underline"
                          to={`/issues/${cycle.taskId}`}
                        >
                          原失败测试与记录
                        </Link>{" "}
                        · {cycle.receiptDigest} · 修复 {cycle.defectKey} / 评审{" "}
                        {cycle.reviewKey} / 重测 {cycle.retestKey}
                      </p>
                    ))}
                  </details>
                )}
                {s.receipt && (
                  <div className="text-sm">
                    <a
                      className="underline"
                      href={s.receipt.jiraReference}
                      target="_blank"
                      rel="noreferrer"
                    >
                      查看 Jira 正式交付物
                    </a>
                    <p>
                      产物 {s.receipt.artifacts.length} 个 · Tracker 回执{" "}
                      {s.receipt.trackerReceiptId}
                    </p>
                    {s.stage === "functional-test" &&
                      (s.receipt.testResults ? (
                        <p>
                          被测版本 {s.receipt.testResults.testedVersion} · 用例{" "}
                          {s.receipt.testResults.total}：通过{" "}
                          {s.receipt.testResults.passed} / 失败{" "}
                          {s.receipt.testResults.failed} / 阻塞{" "}
                          {s.receipt.testResults.blocked} / 跳过{" "}
                          {s.receipt.testResults.skipped}
                          。结果来自原生逐条记录，正式验收仍需单独核验。
                        </p>
                      ) : (
                        <p>
                          缺少可对账的测试结果，不能从报告交付推定测试通过。
                        </p>
                      ))}
                    <details>
                      <summary>当前交付指纹与产物</summary>
                      <p className="break-all font-mono text-xs">
                        {s.receiptDigest}
                      </p>
                      {s.receipt.artifacts.map((a) => (
                        <p key={a.path} className="break-all text-xs">
                          {a.downloadUrl ? (
                            <a
                              className="underline"
                              href={a.downloadUrl}
                              target="_blank"
                              rel="noreferrer"
                            >
                              下载 {a.path}
                            </a>
                          ) : (
                            <span>
                              {a.path}（仅有指纹索引，暂无已核验下载链接）
                            </span>
                          )}{" "}
                          · {a.sha256}
                        </p>
                      ))}
                    </details>
                  </div>
                )}
                {s.question && !s.question.answer && s.state === "waiting" && (
                  <WorkflowAction
                    companyId={companyId}
                    flowId={flow.id}
                    stage={s}
                    action="answer"
                    refresh={() => void workflows.refetch()}
                  />
                )}
                {!s.branchBlocked && s.state === "review" &&
                  (s.requiresReview ??
                    ["design", "test-cases"].includes(s.stage)) &&
                  deliveryReviewDigest(s) &&
                  !s.review && (
                    <WorkflowAction
                      companyId={companyId}
                      flowId={flow.id}
                      stage={s}
                      action="review"
                      automaticRework={flow.config.template?.definition.stages[s.stage].rejectionHandling === "automatic_rework"}
                      refresh={() => void workflows.refetch()}
                    />
                  )}
                {!!s.reworkHistory?.length && <details className="text-sm">
                  <summary>返工与评审记录（{s.reworkHistory.length} 轮）</summary>
                  {s.reworkHistory.map(r=><div key={r.round} className="space-y-2 border-t border-border py-2">
                    <p>第 {r.round} 轮 · {r.rejection.at} · {r.rejection.by}</p>
                    <p>{r.kind === "scope_change" ? "范围变更" : "修改要求"}：{r.rejection.note}</p>
                    <a className="underline" href={r.rejection.reference} target="_blank" rel="noreferrer">{r.kind === "scope_change" ? "查看来源主工单" : "查看退回结论"}</a>
                    {r.previous.manualDelivery && <><p>退回版本：{r.previous.manualDelivery.version}</p>{r.previous.manualDelivery.artifactReferences.map(url=><p key={url}><a className="underline" href={url} target="_blank" rel="noreferrer">原交付材料</a></p>)}</>}
                    {r.previous.receipt?.artifacts.map(a=><p key={a.path}>{a.downloadUrl ? <a className="underline" href={a.downloadUrl} target="_blank" rel="noreferrer">{a.path}</a>:a.path} · {a.sha256}</p>)}
                    {r.previous.review && <p>原评审结论：{r.previous.review.decision === "approve" ? "通过（已失效）" : "退回"} · {r.previous.review.note}</p>}
                  </div>)}
                </details>}
                {(flow.state === "blocked" || s.branchBlocked) && s.review?.decision === "reject" && <Rework companyId={companyId} flowId={flow.id} stage={s} refresh={()=>void workflows.refetch()} />}
                {s.review && (
                  <p className="text-sm">
                    {s.review.decision === "approve"
                      ? "本版本正式评审结论已核验"
                      : "本版本评审退回"}{" "}
                    ·{" "}
                    <a
                      className="underline"
                      href={s.review.reference}
                      target="_blank"
                      rel="noreferrer"
                    >
                      查看结论
                    </a>
                  </p>
                )}
                {s.state === "interrupted" &&
                  s.stage !== "analysis" &&
                  canManage && (
                    <Retry
                      companyId={companyId}
                      flowId={flow.id}
                      taskId={s.taskId}
                      resumeCount={s.resumeCount ?? 0}
                      refresh={() => void workflows.refetch()}
                    />
                  )}
              </li>
            ))}
          </ol>
          {flow.state === "acceptance" && canManage && (flow.config.entryScope || (snapshot.plan.mains?.length ?? 0) < 2) && (
            <WorkflowAction
              companyId={companyId}
              flowId={flow.id}
              fingerprint={flow.config.entryScope?.acceptanceDigest ?? flow.fingerprint}
              action="accept"
              refresh={() => void workflows.refetch()}
            />
          )}
          {flow.acceptance && (
            <a
              className="underline"
              href={flow.acceptance.reference}
              target="_blank"
              rel="noreferrer"
            >
              查看正式验收结论
            </a>
          )}
        </>
      ) : !expanded ? (
        <p className="text-sm text-muted-foreground">
          尚未启动。{savedPlan.data && "查看交付计划后，授权启动。"}
        </p>
      ) : null}
      {expanded && canShowPlan && (
        <AutomaticDeliveryStart key={`${companyId}:${snapshot.id}`} companyId={companyId} snapshot={snapshot} environmentReference={flow?.config.environmentReference} workflow={flow} readOnly={!canOpenPlan} />
      )}

    </section>
  );
}
function Retry({
  companyId,
  flowId,
  resumeCount,
  taskId,
  refresh,
}: {
  companyId: string;
  flowId: string;
  resumeCount: number;
  taskId: string;
  refresh: () => void;
}) {
  const m = useMutation({
    mutationFn: () => deliveryWorkflowApi.retry(companyId, flowId, taskId),
    onSuccess: refresh,
  });
  return (
    <div>
      <Button
        variant="outline"
        onClick={() => m.mutate()}
        disabled={m.isPending || resumeCount >= DELIVERY_STAGE_MAX_RESUMES}
      >
        核验旧进程后恢复本阶段
      </Button>
      <p className="text-xs text-muted-foreground">
        已恢复 {resumeCount}/{DELIVERY_STAGE_MAX_RESUMES}{" "}
        次；达到上限后需人工排查并重新规划。
      </p>
      {m.isError && <p role="alert">{m.error.message}</p>}
    </div>
  );
}
function WorkflowAction({
  companyId,
  flowId,
  stage,
  fingerprint,
  action,
  automaticRework = false,
  refresh,
}: {
  companyId: string;
  flowId: string;
  stage?: DeliveryStageRecord;
  fingerprint?: string;
  action: "review" | "accept" | "answer";
  automaticRework?: boolean;
  refresh: () => void;
}) {
  const [reference, setReference] = useState(""),
    [note, setNote] = useState(""),
    [decision, setDecision] = useState("approve");
  const manualWork=action==="review"&&stage?.executionMode==="human"&&!stage.reviewWorkKeys;
  const historical = action === "review" && stage?.historicalVerification;
  const [version,setVersion]=useState(""),[materials,setMaterials]=useState(""),[passed,setPassed]=useState("");
  const m = useMutation({
    mutationFn: () =>
      action === "answer"
        ? deliveryWorkflowApi.answer(companyId, flowId, {
            taskId: stage!.taskId,
            digest: stage!.question!.digest,
            answer: note,
          })
        : action === "review"
          ? deliveryWorkflowApi.review(companyId, flowId, {
              taskId: stage!.taskId,
              digest: deliveryReviewDigest(stage!),
              ...(manualWork&&decision==="approve"?{manualDelivery:{version,artifactReferences:materials.split(/\n/).map(x=>x.trim()).filter(Boolean),...(stage?.stage==="functional-test"?{testResults:{total:Number(passed),passed:Number(passed),failed:0,blocked:0,skipped:0}}:{})}}:{}),
              decision,
              reference,
              note,
            })
          : deliveryWorkflowApi.accept(companyId, flowId, {
              fingerprint,
              reference,
              note,
            }),
    onSuccess: () => {
      setNote("");
      setReference("");
      refresh();
    },
  });
  return (
    <form
      className="space-y-3 rounded-md border border-border p-3"
      onSubmit={(e) => {
        e.preventDefault();
        m.mutate();
      }}
    >
      <p className="font-medium">
        {action === "answer"
          ? stage?.question?.text
          : action === "review"
            ? historical ? "核验历史交付" : manualWork ? "登记人工工作单交付" : "核验本版本正式评审结论"
            : "登记正式验收结论"}
      </p>
      {action !== "answer" && (
        <>
          <p className="text-sm text-muted-foreground">
            {historical
              ? "核对 Jira 工单的正式结论后，登记该工单链接和核验说明。"
              : "请先在正式流程完成评审／验收，再登记结论链接。此处为人工核验记录，不自动替代源系统审签。"}
          </p>
          <Input
            type="url"
            aria-label="正式结论链接"
            required
            value={reference}
            onChange={(e) => setReference(e.target.value)}
            placeholder="Jira／轻舟正式结论链接"
          />
        </>
      )}
      {manualWork&&decision==="approve"&&<div className="space-y-2">
        <Input required aria-label="人工交付版本" placeholder="交付版本／提交号／被测构建" value={version} onChange={e=>setVersion(e.target.value)} />
        <textarea required aria-label="人工交付材料" className={field} placeholder="正式交付材料链接，每行一条；请包含交付产物和相关版本说明" value={materials} onChange={e=>setMaterials(e.target.value)} />
        {stage?.stage==="functional-test"&&<><p className="text-sm">{historical ? "测试执行报告须包含逐条记录。全部用例通过后登记被测版本、报告链接和通过数量。" : "仅全部用例通过时登记完成；失败、阻塞或跳过请退回，测试执行报告须包含逐条记录。"}</p><Input required type="number" min="1" max="1000000" aria-label="人工测试通过用例数" value={passed} onChange={e=>setPassed(e.target.value)} placeholder="全部通过用例数" /></>}
      </div>}
      {action === "review" && !historical && (
        <select
          aria-label={manualWork ? "人工办理结果" : "评审结论"}
          className={field}
          value={decision}
          onChange={(e) => setDecision(e.target.value)}
        >
          <option value="approve">{manualWork ? "提交本次交付" : "当前版本通过"}</option>
          <option value="reject">{manualWork ? "交付需修改，登记返工要求" : automaticRework ? "退回原执行人修改并重新送审" : "退回并暂停，手动确认后返工"}</option>
        </select>
      )}
      <textarea
        className={field}
        aria-label={action === "answer" ? "人工答复" : "核验说明"}
        required
        maxLength={action === "answer" ? 4000 : 2000}
        value={note}
        onChange={(e) => setNote(e.target.value)}
        placeholder={
          action === "answer"
            ? "仅回答当前问题，不填写密钥"
            : decision === "reject" ? "填写具体问题、修改要求和重新验收标准" : "说明正式结论、评审版本与核验情况"
        }
      />
      {m.isError && <p role="alert">{m.error.message}</p>}
      <Button type="submit" disabled={m.isPending}>
        {m.isPending
          ? "提交中…"
          : action === "answer"
            ? "答复并续传本机会话"
            : action === "review"
              ? historical ? "登记核验结果" : manualWork ? "登记人工交付完成" : "登记评审结论"
              : "登记验收完成"}
      </Button>
    </form>
  );
}

function Cancel({
  companyId,
  flowId,
  refresh,
}: {
  companyId: string;
  flowId: string;
  refresh: () => void;
}) {
  const m = useMutation({
    mutationFn: () => deliveryWorkflowApi.cancel(companyId, flowId),
    onSuccess: refresh,
  });
  return (
    <div>
      <Button
        variant="outline"
        disabled={m.isPending}
        onClick={() => m.mutate()}
      >
        停止本条目后续派发与当前执行
      </Button>
      {m.isError && <p role="alert">{m.error.message}</p>}
    </div>
  );
}

function ConfirmStart({
  companyId,
  flowId,
  stage,
  refresh,
}: {
  companyId: string;
  flowId: string;
  stage: DeliveryStageRecord;
  refresh: () => void;
}) {
  const m = useMutation({
    mutationFn: () =>
      deliveryWorkflowApi.confirmStart(companyId, flowId, {
        taskId: stage.taskId,
        inputDigest: stage.inputDigest,
      }),
    onSuccess: refresh,
  });
  return (
    <div>
      <Button
        variant="outline"
        disabled={m.isPending}
        onClick={() => m.mutate()}
      >
        确认启动本阶段
      </Button>
      {m.isError && <p role="alert">{m.error.message}</p>}
    </div>
  );
}

function Rework({companyId,flowId,stage,refresh}:{companyId:string;flowId:string;stage:DeliveryStageRecord;refresh:()=>void}) {
  const mutation=useMutation({mutationFn:()=>deliveryWorkflowApi.rework(companyId,flowId,{taskId:stage.taskId,digest:deliveryReviewDigest(stage)}),onSuccess:refresh});
  return <div className="space-y-2"><Button type="button" disabled={mutation.isPending} onClick={()=>mutation.mutate()}>{mutation.isPending?"提交中…":"按退回意见发起返工"}</Button>{mutation.isError&&<p role="alert">{mutation.error.message}</p>}</div>;
}
