import { deliveryTemplatesApi } from "@/api/delivery-templates";
import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@/lib/router";
import {
  DELIVERY_STAGE_LABELS,
  DELIVERY_REVIEW_LABELS,
  deliverySequenceLabel,
  deliveryReviewExecution,
  deliveryRecordLabel,
  deliveryReviewDigest,
  matchesDeliveryWorkType,
  type DeliveryWorkflowConfig,
  DELIVERY_STAGE_MAX_RESUMES,
  type DeliverySnapshot,
  type DeliveryStageRecord,
} from "@paperclipai/shared";
import { deliveryWorkflowApi } from "@/api/delivery-workflows";
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
}: {
  companyId: string;
  snapshot: DeliverySnapshot;
  canManage: boolean;
  startRequested?: boolean;
}) {
  const qc = useQueryClient();
  const [expanded, setExpanded] = useState(false),
    [analysisSeatId, setAnalysisSeat] = useState(""),
    [developmentSeatId, setDevSeat] = useState(""),
    [qaSeatId, setQaSeat] = useState(""),
    [environmentReference, setEnvironment] = useState("");
  useEffect(() => {
    if (startRequested && canManage) setExpanded(true);
  }, [startRequested, canManage]);
  const [keys, setKeys] = useState<Record<string, string>>({}),
    [requestId, setRequestId] = useState(() => crypto.randomUUID());
  const workflows = useQuery({
    queryKey: ["delivery-workflows", companyId, snapshot.id],
    queryFn: () => deliveryWorkflowApi.list(companyId, snapshot.id),
    refetchInterval: 5000,
  });
  const seats = useQuery({
    queryKey: ["delivery-workflow-seats", companyId, snapshot.id],
    queryFn: () => deliveryWorkflowApi.seats(companyId, snapshot.id),
    enabled: expanded && canManage,
  });
  const template = useQuery({
    queryKey: ["delivery-template", companyId, snapshot.projectId],
    queryFn: () => deliveryTemplatesApi.get(companyId, snapshot.projectId),
  });
  const definition = template.data?.effective.definition;
  const [codingTasks, setCodingTasks] = useState<
    Array<{ jiraKey: string; seatId: string }>
  >([]);
  const [reviewTasks,setReviewTasks]=useState<NonNullable<DeliveryWorkflowConfig["reviewTasks"]>>([]);
  const [workSeats,setWorkSeats]=useState<Record<string,string>>({});
  const candidates=(key:string,kind:string,role?:string)=>seats.data?.filter(s=>s.jiraKeys?.includes(key)&&s.domains.some(d=>d.kind===kind&&(!role||d.roles.includes(role))))??[];
  const picked=(key:string,kind:string,selected:string,role?:string)=>{const choices=candidates(key,kind,role);return choices.some(s=>s.id===selected)?selected:choices.length===1?choices[0].id:"";};
  const start = useMutation({
    mutationFn: () =>
      deliveryWorkflowApi.start(companyId, {
        requestId,
        snapshotId: snapshot.id,
        analysisSeatId,
        developmentSeatId,
        qaSeatId,
        designKey: keys.design ?? "",
        codingKey: keys.coding ?? "",
        testCasesKey: keys["test-cases"] ?? "",
        testExecutionKey: keys["functional-test"] ?? "",
        environmentReference,
        workSeats:Object.entries(workSeats).map(([jiraKey,seatId])=>({jiraKey,seatId})),
        codingTasks: codingTasks.length ? codingTasks.map(t=>({...t,seatId:picked(t.jiraKey,"development",t.seatId,"coding")})) : undefined,
        reviewTasks: reviewTasks.filter(r=>definition?.stages[r.stage].enabled&&definition.stages[r.stage].taskSequence==="work_then_review").map(r=>({...r,seatId:picked(r.jiraKey,r.stage==="test-cases"?"qa":"development",r.seatId??"",r.stage==="coding"?"code-review":r.stage==="design"?"design-review":"test-case-review")||undefined})),
        expectedTemplate: template.data
          ? {
              id: template.data.effective.id,
              revision: template.data.effective.revision,
            }
          : undefined,
      }),
    onSuccess: () => {
      setExpanded(false);
      setRequestId(crypto.randomUUID());
      void workflows.refetch();
      void qc.invalidateQueries({queryKey:["delivery-entry",companyId,snapshot.id]});
      void qc.invalidateQueries({queryKey:["delivery-monthly",companyId,snapshot.projectId]});
    },
  });
  const flow = workflows.data?.[0];
  const displayDefinition=flow?.config.template?.definition??definition;
  const configRows = [
    ["analysis", "需求分析席位", analysisSeatId, setAnalysisSeat],
    [
      "development",
      "设计默认席位（编码单分别绑定席位）",
      developmentSeatId,
      setDevSeat,
    ],
    ["qa", "测试席位（用例、执行共用）", qaSeatId, setQaSeat],
  ] as const;
  const childRows = [
    ["design", "设计子工单", /设计/],
    ["coding", "编码子工单", /编码|开发/],
    ["test-cases", "用例编写子工单", /用例.*编写|用例.*设计|测试用例/],
    ["functional-test", "功能测试子工单", /功能测试|测试执行/],
  ] as const;
  return (
    <section
      className="space-y-4 rounded-lg border border-border p-4"
      aria-label="条目自动交付"
    >
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="font-semibold">一键交付条目</h2>
          <p className="text-sm text-muted-foreground">
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
          </p>
        </div>
        {!flow && canManage && (
          <Button onClick={() => setExpanded(!expanded)} variant="outline">
            {expanded ? "收起配置" : "配置并启动"}
          </Button>
        )}
      </div>
      <p className="text-sm">
        <Link className="underline" to="/delivery-chain">
          交付链设置
        </Link>{" "}
        · {flow?.config.template?.definition.name ?? definition?.name} · v
        {flow?.config.template?.revision ?? template.data?.effective.revision}
      </p>
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
          <p className="font-medium">{states[flow.state] ?? flow.state}</p>
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
                className="space-y-2 rounded-md border border-border p-3"
              >
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <p className="font-medium">
                    {deliveryRecordLabel(s)}{" "}
                    · {states[s.state]}
                  </p>
                  <Link
                    className="text-sm underline"
                    to={
                      s.stage === "analysis"
                        ? `/analysis-executions?executionId=${s.taskId}&projectId=${flow.projectId}`
                        : `/issues/${s.taskId}`
                    }
                  >
                    {s.stage === "analysis"
                      ? "分析、决定与正式发布"
                      : "执行记录与完整对话"}
                  </Link>
                </div>
                <p className="text-xs text-muted-foreground">工单：{s.jiraKey??"条目级分析"} · 前置：{s.dependsOn?.length?s.dependsOn.map(id=>flow.stages.find(p=>p.taskId===id)?.jiraKey??"需求分析").join("、"):"流程起点"}{s.executionMode==="human"?s.reviewWorkKeys?" · 由负责人完成正式评审并登记结论":" · 由负责人完成人工工作单并登记交付":""}</p>
                {s.startMode === "confirmation" &&
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
                <p className="text-sm">执行方式：{s.executionMode==="human"?"人工":"Agent"}{s.executionMode==="human"?` · 负责人 ${s.reviewerUserId}`:""}</p>
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
                {s.state === "review" &&
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
                    <p>修改要求：{r.rejection.note}</p>
                    <a className="underline" href={r.rejection.reference} target="_blank" rel="noreferrer">查看退回结论</a>
                    {r.previous.manualDelivery && <><p>退回版本：{r.previous.manualDelivery.version}</p>{r.previous.manualDelivery.artifactReferences.map(url=><p key={url}><a className="underline" href={url} target="_blank" rel="noreferrer">原交付材料</a></p>)}</>}
                    {r.previous.receipt?.artifacts.map(a=><p key={a.path}>{a.downloadUrl ? <a className="underline" href={a.downloadUrl} target="_blank" rel="noreferrer">{a.path}</a>:a.path} · {a.sha256}</p>)}
                    {r.previous.review && <p>原评审结论：{r.previous.review.decision === "approve" ? "通过（已失效）" : "退回"} · {r.previous.review.note}</p>}
                  </div>)}
                </details>}
                {flow.state === "blocked" && s.review?.decision === "reject" && <Rework companyId={companyId} flowId={flow.id} stage={s} refresh={()=>void workflows.refetch()} />}
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
          {flow.state === "acceptance" && canManage && (
            <WorkflowAction
              companyId={companyId}
              flowId={flow.id}
              fingerprint={flow.fingerprint}
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
      ) : (
        <p className="text-sm text-muted-foreground">
          尚未启动。当前模板已自动接入，选定席位与真实子工单后启动，平台按模板衔接执行与审核。
        </p>
      )}
      {!flow && expanded && canManage && (
        <form
          className="space-y-4"
          onSubmit={(e) => {
            e.preventDefault();
            start.mutate();
          }}
        >
          <p className="text-sm">
            工单按 Jira 经办人账号匹配其席位：唯一匹配自动绑定，多个匹配请选择，无匹配请配置负责人席位。离线或忙碌等待原席位，不自动换人。不同席位按模板并行，同一席位排队。启动即授权模板中的自动执行。
          </p>
          {seats.isError && (
            <p role="alert">席位读取失败：{seats.error.message}</p>
          )}
          {Object.values(definition?.stages??{}).some(s=>s.enabled&&s.taskSequence==="work_then_review")&&seats.data?.some(s=>!s.orderedReviewReady)&&<p className="text-sm text-muted-foreground">此流程需要支持独立评审顺序调度的席位客户端。旧客户端仍可查看和配置，启动执行前须在席位电脑更新客户端并刷新登记。</p>}
          <div className="grid gap-3 md:grid-cols-3">
            {configRows
              .filter(([kind]) => kind === "analysis" &&
                Object.entries(definition?.stages ?? {}).some(
                  ([k, v]) =>
                    v.enabled &&
                    (kind === "analysis"
                      ? k === "analysis"
                      : kind === "development"
                        ? ["design", "coding"].includes(k)
                        : ["test-cases", "functional-test"].includes(k)),
                ),
              )
              .map(([kind, label, value, setter]) => (
                <label key={kind} className="space-y-2 text-sm">
                  <span>{label}</span>
                  <select
                    required={Object.entries(definition?.stages ?? {}).some(
                      ([k, v]) =>
                        v.enabled &&
                        !v.seatId &&
                        !(v.workExecution === "human" && v.workExecutorUserId) &&
                        k !== "coding" &&
                        (kind === "analysis"
                          ? k === "analysis"
                          : kind === "development"
                            ? ["design", "coding"].includes(k)
                            : ["test-cases", "functional-test"].includes(k)),
                    )}
                    aria-label={label}
                    className={field}
                    value={value}
                    onChange={(e) => setter(e.target.value)}
                  >
                    <option value="">请选择已登记能力的席位</option>
                    {seats.data
                      ?.filter((s) => s.domains.some((d) => d.kind === kind))
                      .map((s) => (
                        <option key={s.id} value={s.id}>
                          {s.name}
                          {!s.online ? "（离线，等待上线）" : ""}
                          {!s.clientReady ? "（需更新客户端）" : ""}
                        </option>
                      ))}
                  </select>
                </label>
              ))}
          </div>
          <div className="grid gap-3 md:grid-cols-2">
            {childRows
              .filter(
                ([stage]) =>
                  definition?.stages[stage].enabled && stage !== "coding",
              )
              .map(([stage, label, type]) => (
                <div key={stage} className="space-y-2"><label className="space-y-2 text-sm">
                  <span>{label}</span>
                  <select
                    required
                    aria-label={label}
                    className={field}
                    value={keys[stage] ?? ""}
                    onChange={(e) =>
                      setKeys((v) => ({ ...v, [stage]: e.target.value }))
                    }
                  >
                    <option value="">选择真实 Jira 子工单</option>
                    {snapshot.plan.items
                      .filter(
                        (i) =>
                          i.parentKey &&
                          type.test(i.type) &&
                          !/评审|审查/.test(i.type),
                      )
                      .map((i) => (
                        <option key={i.key} value={i.key}>
                          {i.key} · {i.title} · {i.status}
                        </option>
                      ))}
                  </select>
                </label>
                {definition?.stages[stage].workExecution!=="human"&&<label className="block space-y-2 text-sm"><span>按工单经办人匹配席位</span><select required aria-label={`${label}执行席位`} className={field} value={picked(keys[stage]??"",stage==="design"?"development":"qa",workSeats[keys[stage]??""]??"",stage==="design"?"system-design":stage==="test-cases"?"test-cases":"functional-test")} onChange={e=>setWorkSeats(v=>({...v,[keys[stage]]:e.target.value}))}><option value="">{!keys[stage]?"请先选择工单":candidates(keys[stage],stage==="design"?"development":"qa").length?"请选择该经办人的席位":"无匹配席位，请配置经办人账号与能力"}</option>{candidates(keys[stage]??"",stage==="design"?"development":"qa",stage==="design"?"system-design":stage==="test-cases"?"test-cases":"functional-test").map(s=><option key={s.id} value={s.id}>{s.name}{!s.online?"（离线，等待上线）":""}</option>)}</select></label>}
                </div>
              ))}
          </div>
          {definition?.stages.coding.enabled && (
            <fieldset className="space-y-3 rounded-md border border-border p-3">
              <legend>
                编码单（
                {definition.codingExecution === "parallel"
                  ? "并行汇合"
                  : "依次执行"}
                ）
              </legend>
              {codingTasks.map((task, index) => (
                <div className="flex flex-wrap gap-2" key={index}>
                  <select
                    required
                    aria-label={`编码单 ${index + 1}`}
                    className={field}
                    value={task.jiraKey}
                    onChange={(e) =>
                      setCodingTasks((v) =>
                        v.map((t, i) =>
                          i === index ? { ...t, jiraKey: e.target.value } : t,
                        ),
                      )
                    }
                  >
                    <option value="">选择编码子工单</option>
                    {snapshot.plan.items
                      .filter(
                        (i) =>
                          i.parentKey &&
                          /编码|开发/.test(i.type) &&
                          !/评审|审查/.test(i.type),
                      )
                      .map((i) => (
                        <option key={i.key} value={i.key}>
                          {i.key} · {i.title}
                        </option>
                      ))}
                  </select>
                  <select
                    required={definition.stages.coding.workExecution!=="human" || !definition.stages.coding.workExecutorUserId}
                    aria-label={`编码席位 ${index + 1}`}
                    className={field}
                    value={picked(task.jiraKey,"development",task.seatId,"coding")}
                    onChange={(e) =>
                      setCodingTasks((v) =>
                        v.map((t, i) =>
                          i === index ? { ...t, seatId: e.target.value } : t,
                        ),
                      )
                    }
                  >
                    <option value="">{!task.jiraKey?"请先选择工单":candidates(task.jiraKey,"development","coding").length?"请选择该经办人的席位":"无匹配席位，请配置经办人账号与能力"}</option>
                    {seats.data
                      ?.filter((s) => s.jiraKeys?.includes(task.jiraKey)&&s.domains.some((d) => d.kind === "development"&&d.roles.includes("coding")))
                      .map((s) => (
                        <option key={s.id} value={s.id}>
                          {s.name}
                        </option>
                      ))}
                  </select>
                  <Button
                    type="button"
                    variant="ghost"
                    onClick={() =>
                      setCodingTasks((v) => v.filter((_, i) => i !== index))
                    }
                  >
                    移除
                  </Button>
                </div>
              ))}
              <Button
                type="button"
                variant="outline"
                onClick={() =>
                  setCodingTasks((v) => [
                    ...v,
                    {
                      jiraKey: "",
                      seatId:
                        definition.stages.coding.seatId ?? developmentSeatId,
                    },
                  ])
                }
              >
                添加编码单
              </Button>
            </fieldset>
          )}
          {(["design","coding","test-cases"] as const).filter(stage=>definition?.stages[stage].enabled&&definition.stages[stage].taskSequence==="work_then_review").map(stage=>{
            const work=stage==="coding"?codingTasks:[{jiraKey:keys[stage]??"",seatId:(definition?.stages[stage].seatId||(stage==="design"?developmentSeatId:qaSeatId))}];
            return <fieldset key={stage} className="space-y-3 rounded-md border border-border p-3"><legend>{DELIVERY_REVIEW_LABELS[stage]}与前置工作单绑定</legend>
              <p className="text-sm text-muted-foreground">{deliveryReviewExecution(stage,definition!.stages[stage])==="agent"?"工作单交付后启动独立 Agent 评审；共享评审等待全部所选工作单完成，评审席位须独立于工作席位。":"工作单完成后转交配置的人工负责人，完成正式评审后登记结论。"}</p>
              {reviewTasks.map((review,index)=>review.stage!==stage?null:<div key={index} className="space-y-2 rounded-md border border-border p-3">
                <label className="block space-y-2 text-sm">真实{DELIVERY_REVIEW_LABELS[stage]}<select required aria-label={`${DELIVERY_REVIEW_LABELS[stage]} ${index+1}`} className={field} value={review.jiraKey} onChange={e=>setReviewTasks(v=>v.map((r,i)=>i===index?{...r,jiraKey:e.target.value}:r))}>
                  <option value="">选择本条目真实评审子单</option>{snapshot.plan.items.filter(i=>i.parentKey&&matchesDeliveryWorkType(stage,true,i.type)).map(i=><option key={i.key} value={i.key}>{i.key} · {i.title} · {i.status}</option>)}
                </select></label>
                <div className="space-y-2 text-sm" role="group" aria-label={`${DELIVERY_REVIEW_LABELS[stage]}前置工单 ${index+1}`}><p>该评审等待以下工作单完成：</p>{work.filter(w=>w.jiraKey).map(w=><label key={w.jiraKey} className="flex items-center gap-2"><input type="checkbox" checked={review.workKeys.includes(w.jiraKey)} onChange={e=>setReviewTasks(v=>v.map((r,i)=>i===index?{...r,workKeys:e.target.checked?[...r.workKeys,w.jiraKey]:r.workKeys.filter(k=>k!==w.jiraKey)}:r))}/>{w.jiraKey}</label>)}</div>
                {deliveryReviewExecution(stage,definition!.stages[stage])==="agent"&&<label className="block space-y-2 text-sm">独立 Agent 评审席位<select required aria-label={`${stage==="coding"?"代码评审":DELIVERY_REVIEW_LABELS[stage]}席位 ${index+1}`} className={field} value={picked(review.jiraKey,stage==="test-cases"?"qa":"development",review.seatId??"",stage==="coding"?"code-review":stage==="design"?"design-review":"test-case-review")} onChange={e=>setReviewTasks(v=>v.map((r,i)=>i===index?{...r,seatId:e.target.value||undefined}:r))}><option value="">选择独立席位</option>{seats.data?.filter(s=>s.jiraKeys?.includes(review.jiraKey)&&s.domains.some(d=>d.kind===(stage==="test-cases"?"qa":"development")&&d.roles.includes(stage==="coding"?"code-review":stage==="design"?"design-review":"test-case-review"))&&(definition?.stages[stage].workExecution==="human"||!work.some(w=>review.workKeys.includes(w.jiraKey)&&w.seatId===s.id))).map(s=><option key={s.id} value={s.id}>{s.name}</option>)}</select></label>}
                <Button type="button" variant="ghost" onClick={()=>setReviewTasks(v=>v.filter((_,i)=>i!==index))}>移除此评审绑定</Button>
              </div>)}
              <Button type="button" variant="outline" onClick={()=>setReviewTasks(v=>[...v,{stage,jiraKey:"",workKeys:work.filter(w=>w.jiraKey&&!v.some(r=>r.stage===stage&&r.workKeys.includes(w.jiraKey))).map(w=>w.jiraKey),...(definition?.stages[stage].reviewSeatId?{seatId:definition.stages[stage].reviewSeatId}:{})}])}>添加{DELIVERY_REVIEW_LABELS[stage]}绑定</Button>
            </fieldset>;
          })}
          {definition?.stages["functional-test"].enabled && (
            <label className="block space-y-2 text-sm">
              测试环境与待测构建的准入说明链接
              <Input
                required
                type="url"
                aria-label="测试环境准入引用"
                value={environmentReference}
                onChange={(e) => setEnvironment(e.target.value)}
                placeholder="正式环境或发布说明 URL"
              />
            </label>
          )}
          {start.isError && <p role="alert">启动失败：{start.error.message}</p>}
          <div className="flex items-center justify-between gap-3">
            <Button
              type="button"
              variant="ghost"
              onClick={() => setExpanded(false)}
            >
              取消
            </Button>
            <Button
              disabled={
                start.isPending ||
                seats.isPending ||
                !template.data ||
                !!(definition?.stages.coding.enabled && !codingTasks.length)
              }
              type="submit"
            >
              {start.isPending ? "正在建立流程…" : "启动条目自动交付"}
            </Button>
          </div>
        </form>
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
            ? manualWork ? "登记人工工作单交付" : "核验本版本正式评审结论"
            : "登记正式验收结论"}
      </p>
      {action !== "answer" && (
        <>
          <p className="text-sm text-muted-foreground">
            请先在正式流程完成评审／验收，再登记结论链接。此处为人工核验记录，不自动替代源系统审签。
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
        {stage?.stage==="functional-test"&&<><p className="text-sm">仅全部用例通过时登记完成；失败、阻塞或跳过请退回，测试执行报告须包含逐条记录。</p><Input required type="number" min="1" max="1000000" aria-label="人工测试通过用例数" value={passed} onChange={e=>setPassed(e.target.value)} placeholder="全部通过用例数" /></>}
      </div>}
      {action === "review" && (
        <select
          aria-label="评审结论"
          className={field}
          value={decision}
          onChange={(e) => setDecision(e.target.value)}
        >
          <option value="approve">当前版本通过</option>
          <option value="reject">{automaticRework ? "退回原执行人修改并重新送审" : "退回并暂停，手动确认后返工"}</option>
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
              ? manualWork ? "登记人工交付完成" : "登记评审结论"
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
