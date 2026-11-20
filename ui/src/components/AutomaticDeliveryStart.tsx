import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  DELIVERY_STAGE_LABELS,
  type DeliveryAutomaticPlan,
  type DeliveryAutomaticPlanInput,
  type DeliverySnapshot,
  type DeliveryWorkflow,
} from "@paperclipai/shared";
import { deliveryPlanPreviewQuery, deliveryWorkflowApi } from "@/api/delivery-workflows";
import { DeliveryPlanDependencyChart, type PlanExecutionStages } from "./DeliveryPlanDependencyChart";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
const field =
  "w-full rounded-md border border-border bg-background p-2 text-sm";
function newPlanRequestId() {
  if (typeof crypto.randomUUID === "function") return crypto.randomUUID();
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, byte => byte.toString(16).padStart(2, "0")).join("");
  return [hex.slice(0, 8), hex.slice(8, 12), hex.slice(12, 16), hex.slice(16, 20), hex.slice(20)].join("-");
}

function draftForSnapshot(input: DeliveryAutomaticPlanInput, snapshot: DeliverySnapshot): DeliveryAutomaticPlanInput {
  if (input.snapshotId === snapshot.id) return input;
  const parents = new Set(snapshot.plan.mains.map(main => main.key));
  const children = new Set(snapshot.plan.items.filter(item => item.parentKey).map(item => item.key));
  return {
    ...input, snapshotId: snapshot.id,
    parentKey: input.parentKey && parents.has(input.parentKey) ? input.parentKey : undefined,
    selectedParentKeys: input.selectedParentKeys?.filter(key => parents.has(key)),
    ignoredParentKeys: input.ignoredParentKeys?.filter(key => parents.has(key)),
    skipTestCasesParentKeys: input.skipTestCasesParentKeys?.filter(key => parents.has(key)),
    branchDependencies: input.branchDependencies?.filter(binding => parents.has(binding.parentKey) && parents.has(binding.afterParentKey)),
    workSeats: input.workSeats?.filter(binding => children.has(binding.jiraKey)),
    reviewTasks: input.reviewTasks?.filter(binding => children.has(binding.jiraKey) && binding.workKeys.every(key => children.has(key))),
    passedTests: input.passedTests?.filter(binding => children.has(binding.jiraKey)),
  };
}

export function AutomaticDeliveryStart({
  companyId,
  snapshot,
  environmentReference = "",
  workflow,
  readOnly = false,
}: {
  companyId: string;
  snapshot: DeliverySnapshot;
  environmentReference?: string;
  workflow?: DeliveryWorkflow;
  readOnly?: boolean;
}) {
  const qc = useQueryClient();
  const [selectedParentKeys, setSelectedParentKeys] = useState<string[] | null>(null);
  const [draft, setDraft] = useState<DeliveryAutomaticPlanInput>({
    snapshotId: snapshot.id,
    entryScope: true,
    environmentReference,
  });
  const [result, setResult] = useState<{
    plan: DeliveryAutomaticPlan;
    input: DeliveryAutomaticPlanInput;
  } | null>(null);
  const [authorized, setAuthorized] = useState(false);
  const [requestId, setRequestId] = useState(newPlanRequestId);
  const loaded = useRef(false);
  const [startedDigest, setStartedDigest] = useState<string | null>(null);
  const savedQuery = deliveryPlanPreviewQuery(companyId, snapshot.id);
  const saved = useQuery({
    ...savedQuery,
    enabled: !readOnly,
    refetchOnMount: "always",
    refetchOnWindowFocus: false,
  });
  const preview = useMutation({
    mutationFn: async ({ input, initial }: { input: DeliveryAutomaticPlanInput; initial?: true }) =>
      initial ? deliveryWorkflowApi.initialPlan(companyId, input) : { input, plan: await deliveryWorkflowApi.plan(companyId, input) },
    onMutate: () => {
      loaded.current = true;
      setAuthorized(false);
    },
    onSuccess: next => {
      qc.setQueryData(savedQuery.queryKey, next);
      setResult(next);
      const nextDraft = draftForSnapshot(next.input, snapshot);
      setDraft(nextDraft);
      setSelectedParentKeys(nextDraft.selectedParentKeys ?? null);
      setAuthorized(false);
      setRequestId(newPlanRequestId());
      setStartedDigest(null);
    },
  });
  useEffect(() => {
    if (readOnly || loaded.current || !saved.isSuccess || !saved.isFetchedAfterMount) return;
    loaded.current = true;
    if (saved.data) {
      setResult(saved.data);
      const nextDraft = draftForSnapshot(saved.data.input, snapshot);
      setDraft(nextDraft);
      setSelectedParentKeys(nextDraft.selectedParentKeys ?? null);
    } else {
      preview.mutate({ input: draft, initial: true });
    }
  }, [readOnly, saved.isSuccess, saved.isFetchedAfterMount, saved.data]);
  const plan = result?.plan;
  const ignoredParents = draft.ignoredParentKeys ?? [];
  const testCasesSkipped = draft.skipTestCasesParentKeys ?? [];
  const readyParents = plan?.branches?.filter(branch => branch.state === "ready" && !ignoredParents.includes(branch.parentKey))
    .map(branch => branch.parentKey) ?? [];
  const selectedParents = readyParents.filter(key => selectedParentKeys === null || selectedParentKeys.includes(key));
  const savingOnlyIgnored = !!plan?.canSaveIgnored && selectedParents.length === 0;
  const canStart = savingOnlyIgnored || (!!plan?.ready && (!plan.branches || selectedParents.length > 0));
  const includedBranches = plan?.branches?.filter(branch => !ignoredParents.includes(branch.parentKey) && branch.state !== "ignored");
  const relevantNodes = includedBranches?.flatMap(branch => branch.nodes) ?? plan?.nodes ?? [];
  const environmentBlockers = includedBranches?.flatMap(branch => branch.blockers) ?? plan?.blockers ?? [];
  const newTestKeys = relevantNodes.flatMap(node =>
    node.stage === "functional-test" && node.mode !== "reuse" && node.jiraKey ? [node.jiraKey] : []);
  const needsEnvironment = newTestKeys.length > 0 || environmentBlockers.some(blocker => blocker.code === "environment");
  const allBlockers = [...new Map((plan?.branches?.flatMap(branch => branch.blockers) ?? plan?.blockers ?? [])
    .map(blocker => [JSON.stringify(blocker), blocker])).values()];
  const sourceUpdated = !!result && result.input.snapshotId !== snapshot.id;
  const workflowScopeChanged = !!plan && (startedDigest === plan.digest || (
    plan.workflowScope !== undefined &&
    ((plan.workflowScope?.id ?? null) !== (workflow?.id ?? null) ||
      (plan.workflowScope?.requestCount ?? 0) !== Object.keys(workflow?.config.entryScope?.requests ?? {}).length)
  ));
  const current = !!result && !sourceUpdated && !workflowScopeChanged &&
    JSON.stringify(result.input) === JSON.stringify(draft);
  const update = (patch: Partial<DeliveryAutomaticPlanInput>) => {
    setDraft((d) => ({ ...d, ...patch }));
    setAuthorized(false);
  };
  const start = useMutation({
    mutationFn: () => {
      if (!result || !current || !canStart || !authorized)
        throw new Error("请重新生成计划并确认授权");
      return deliveryWorkflowApi.automaticStart(companyId, {
        requestId,
        plan: result.input,
        expectedDigest: result.plan.digest,
        authorized: true,
        ...(result.plan.branches ? { parentKeys: selectedParents } : {}),
        automaticRepairAuthorized:
          !!result.plan.template.definition.automaticRepair,
      });
    },
    onSuccess: () => {
      setAuthorized(false);
      setStartedDigest(plan?.digest ?? null);
      void qc.invalidateQueries({
        queryKey: ["delivery-workflows", companyId, snapshot.id],
      });
    },
  });
  const execution = workflow && workflowPlanExecution(workflow, snapshot.plan);
  const chartStatus = { execution: execution?.stages, workflowState: workflow?.state };
  const savedCharts = execution && [...execution.branches];
  if (readOnly) return (
    <div className="space-y-4" aria-label="交付执行计划">
      {savedCharts?.map(([parentKey, nodes]) => (
        <section key={parentKey} aria-label={parentKey}>
          <p className="font-medium">{parentKey}</p>
          <BranchPlanNodes nodes={nodes} source={snapshot.plan} {...chartStatus} />
        </section>
      ))}
    </div>
  );
  return (
    <div className="space-y-4" aria-label="自动交付计划">
      <p className="text-sm text-muted-foreground">
        勾选本次启动的主工单。暂不启动的主工单可稍后追加。明确忽略的主工单不进入本次交付和验收范围。
      </p>
      {saved.isPending && !result && <p role="status">正在读取已保存的计划…</p>}
      {saved.isError && !result && (
        <p role="alert">读取已保存的计划失败：{saved.error.message} <Button type="button" variant="ghost" onClick={() => void saved.refetch()}>重试读取</Button></p>
      )}
      {preview.isPending && (
        <p role="status">正在读取来源、核验成果并生成计划…</p>
      )}
      {preview.isError && (
        <p role="alert">计划生成失败：{preview.error.message}</p>
      )}
      {!plan && savedCharts?.map(([parentKey, nodes]) => (
        <section key={parentKey} aria-label={parentKey}>
          <p className="font-medium">{parentKey}</p>
          <BranchPlanNodes nodes={nodes} source={snapshot.plan} {...chartStatus} />
        </section>
      ))}
      {plan && (
        <>
          <p className="text-sm">模板 {plan.template.definition.name} · 版本 {plan.template.revision}</p>
          {plan.generatedAt && (
            <p className="text-sm text-muted-foreground">
              计划已保存 · 生成于 <time dateTime={plan.generatedAt}>{new Date(plan.generatedAt).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai", hour12: false })}</time>
            </p>
          )}
          {plan.branches ? (
            <>
              {plan.nodes.filter(node => node.stage === "analysis").length > 0 && (
                <PlanNodes nodes={plan.nodes.filter(node => node.stage === "analysis")} />
              )}
              {plan.branches.map(branch => (
                <section key={branch.parentKey} className="space-y-2 border-t border-border pt-2" aria-label={branch.parentKey}>
                  <p className="font-medium">{branch.parentKey} · {branch.state === "ignored" && branch.canIgnore ? "拟忽略" : branchLabels[branch.state]}</p>
                  {branch.state === "ready" && !ignoredParents.includes(branch.parentKey) && (
                    <label className="flex items-center gap-2 text-sm">
                      <input type="checkbox" checked={selectedParents.includes(branch.parentKey)}
                        onChange={event => {
                          setSelectedParentKeys(event.target.checked
                            ? [...selectedParents, branch.parentKey]
                            : selectedParents.filter(key => key !== branch.parentKey));
                          setAuthorized(false);
                          setRequestId(newPlanRequestId());
                        }}
                      />
                      本次启动 {branch.parentKey}
                    </label>
                  )}
                  {branch.canIgnore && (
                    <label className="flex items-center gap-2 text-sm">
                      <input type="checkbox" checked={ignoredParents.includes(branch.parentKey)}
                        onChange={event => update({
                          ignoredParentKeys: event.target.checked
                            ? [...ignoredParents, branch.parentKey]
                            : ignoredParents.filter(key => key !== branch.parentKey),
                          ...(event.target.checked && draft.branchDependencies ? {
                            branchDependencies: draft.branchDependencies.filter(dependency => dependency.parentKey !== branch.parentKey),
                          } : {}),
                          ...(event.target.checked && testCasesSkipped.includes(branch.parentKey) ? {
                            skipTestCasesParentKeys: testCasesSkipped.filter(key => key !== branch.parentKey),
                          } : {}),
                        })}
                      />
                      忽略 {branch.parentKey}
                    </label>
                  )}
                  {branch.canSkipTestCases && !ignoredParents.includes(branch.parentKey) && (
                    <label className="flex items-center gap-2 text-sm">
                      <input type="checkbox" checked={testCasesSkipped.includes(branch.parentKey)}
                        aria-label={`忽略 ${branch.parentKey} 测试用例编写及评审`}
                        onChange={event => update({
                          skipTestCasesParentKeys: event.target.checked
                            ? [...testCasesSkipped, branch.parentKey]
                            : testCasesSkipped.filter(key => key !== branch.parentKey),
                        })}
                      />
                      本次忽略测试用例编写及评审
                    </label>
                  )}
                  {branch.skipTestCases && !branch.canSkipTestCases && (
                    <p className="text-sm text-muted-foreground">本次交付已忽略测试用例编写及评审。</p>
                  )}
                  {branch.scopeChanged && <p className="text-sm">
                    来源新增工单。确认后，受影响的交付和评审将重新核验。
                    {!!branch.impactedParents?.length && "受影响的后续主单：" + branch.impactedParents.join("、")}
                  </p>}
                  {plan.parents.length > 1 && branch.nodes.length > 0 && !branch.scopeChanged ? (
                    <label className="block space-y-2 text-sm">
                      {branch.parentKey} 的前置主工单
                      <select className={field} value={draft.branchDependencies?.find(dependency => dependency.parentKey === branch.parentKey)?.afterParentKey ?? ""}
                        onChange={event => update({ branchDependencies: [
                          ...(draft.branchDependencies ?? []).filter(dependency => dependency.parentKey !== branch.parentKey),
                          ...(event.target.value ? [{ parentKey: branch.parentKey, afterParentKey: event.target.value }] : []),
                        ] })}>
                        <option value="">无</option>
                        {plan.branches?.filter(candidate => candidate.parentKey !== branch.parentKey && (
                          candidate.state !== "ignored" || draft.branchDependencies?.some(dependency =>
                            dependency.parentKey === branch.parentKey && dependency.afterParentKey === candidate.parentKey)
                        )).map(candidate => <option key={candidate.parentKey}>{candidate.parentKey}</option>)}
                      </select>
                    </label>
                  ) : branch.afterParentKey && <p className="text-sm">前置主工单 {branch.afterParentKey}</p>}
                  <BranchPlanNodes nodes={branch.nodes.length
                    ? branch.nodes.filter(node => node.stage !== "analysis")
                    : execution?.branches.get(branch.parentKey) ?? []}
                    source={snapshot.plan} afterParentKey={branch.afterParentKey} {...chartStatus} />
                  <PlanFindings blockers={branch.blockers.filter(blocker => !plan.blockers.some(global => global.code === blocker.code && global.message === blocker.message))} excluded={branch.excluded} />
                </section>
              ))}
              <PlanFindings blockers={plan.blockers} excluded={[]} />
            </>
          ) : (
            <>
              <BranchPlanNodes nodes={plan.nodes.length ? plan.nodes : savedCharts?.flatMap(([, nodes]) => nodes) ?? []} source={snapshot.plan} {...chartStatus} />
              <PlanFindings blockers={plan.blockers} excluded={plan.excluded} />
            </>
          )}
          {needsEnvironment && (
            <label className="block space-y-2 text-sm">
              测试环境发布记录链接
              <p className="text-muted-foreground">
                {newTestKeys.length > 0 && `${newTestKeys.join("、")} 需要执行功能测试。`}
                填写能查到测试环境和已部署构建版本的链接，例如测试环境部署记录或对应的 CI 发布记录。
              </p>
              <Input
                type="url"
                aria-label="测试环境发布记录链接"
                placeholder="https://ci.example.com/deployments/123"
                value={draft.environmentReference}
                onChange={(e) =>
                  update({ environmentReference: e.target.value })
                }
              />
            </label>
          )}
          {allBlockers
            .filter((b) => b.code === "test_count")
            .map((b) => (
              <label key={b.jiraKey} className="block space-y-2 text-sm">
                {b.jiraKey}{" "}
                已全部通过的测试总数（请核对正式执行记录，无失败、阻塞或跳过）
                <Input
                  type="number"
                  min={1}
                  max={1000000}
                  value={
                    draft.passedTests?.find((t) => t.jiraKey === b.jiraKey)
                      ?.total ?? ""
                  }
                  onChange={(e) =>
                    update({
                      passedTests: [
                        ...(draft.passedTests ?? []).filter(
                          (t) => t.jiraKey !== b.jiraKey,
                        ),
                        ...(e.target.value
                          ? [
                              {
                                jiraKey: b.jiraKey!,
                                total: Number(e.target.value),
                              },
                            ]
                          : []),
                      ],
                    })
                  }
                />
              </label>
            ))}
          {plan.nodes
            .filter(
              (n) =>
                n.mode !== "reuse" &&
                n.seatChoices.length > 0 &&
                allBlockers.some(
                  (b) =>
                    b.code === "seat_choice" &&
                    (b.jiraKey ?? null) === n.jiraKey,
                ),
            )
            .map((n) => (
              <label
                key={n.jiraKey ?? "analysis"}
                className="block space-y-2 text-sm"
              >
                {n.jiraKey ?? "需求分析"} 执行席位
                <select
                  className={field}
                  value={
                    n.jiraKey
                      ? (draft.workSeats?.find((s) => s.jiraKey === n.jiraKey)
                          ?.seatId ?? n.seatId)
                      : (draft.analysisSeatId ?? n.seatId)
                  }
                  onChange={(e) =>
                    update(
                      n.jiraKey
                        ? {
                            workSeats: [
                              ...(draft.workSeats ?? []).filter(
                                (s) => s.jiraKey !== n.jiraKey,
                              ),
                              { jiraKey: n.jiraKey, seatId: e.target.value },
                            ],
                          }
                        : { analysisSeatId: e.target.value || undefined },
                    )
                  }
                >
                  <option value="">请选择匹配席位</option>
                  {n.seatChoices.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.name}
                    </option>
                  ))}
                </select>
              </label>
            ))}
          {!current && (
            <p className="text-sm text-muted-foreground">
              {sourceUpdated ? "条目来源已更新，请重新生成计划后授权。"
                : workflowScopeChanged ? "已授权的交付范围已变化，请重新生成计划后继续。"
                : "补充内容已变化，请重新生成计划后授权。"}
            </p>
          )}
          {current && canStart && (
            <label className="flex items-start gap-2 text-sm">
              <input
                type="checkbox"
                checked={authorized}
                onChange={(e) => setAuthorized(e.target.checked)}
              />
              {savingOnlyIgnored ? "我已核对范围，确认忽略 " + ignoredParents.join("、") : "我已核对工单范围及排除项，授权启动" + (selectedParents.length ? " " + selectedParents.join("、") : "本次交付链")}
              {!savingOnlyIgnored && ignoredParents.length > 0 && "，并忽略 " + ignoredParents.join("、")}
              {selectedParents.some(key => testCasesSkipped.includes(key)) &&
                "，其中 " + selectedParents.filter(key => testCasesSkipped.includes(key)).join("、") + " 忽略测试用例编写及评审"}
              {!savingOnlyIgnored && plan.template.definition.automaticRepair
                ? "，包括复用原编码、代码评审和功能测试任务返工"
                : ""}
              。已有交付复用，最终验收由人工确认。
            </label>
          )}
        </>
      )}
      {start.isError && (
        <p role="alert">
          启动失败：{start.error.message}。请重新生成计划核对最新状态。
        </p>
      )}
      <div className="flex items-center justify-between gap-2">
        <Button
          variant="outline"
          disabled={saved.isPending || preview.isPending || start.isPending}
          onClick={() => preview.mutate({
            input: { ...draft, ...(selectedParentKeys === null ? {} : { selectedParentKeys }) },
          })}
        >
          重新生成计划
        </Button>
        <Button
          disabled={
            !current ||
            !canStart ||
            !authorized ||
            preview.isPending ||
            start.isPending
          }
          onClick={() => start.mutate()}
        >
          {start.isPending ? "提交中…" : savingOnlyIgnored ? "确认忽略主工单" : selectedParents.length > 1 ? "启动所选主工单" : "授权并启动交付链"}
        </Button>
      </div>
    </div>
  );
}


const branchLabels: Record<NonNullable<DeliveryAutomaticPlan["branches"]>[number]["state"], string> = {
  ready: "待启动",
  blocked: "待处理",
  started: "已启动",
  verified: "交付已核验",
  ignored: "已排除出交付范围",
};

function workflowPlanExecution(workflow: DeliveryWorkflow, source: DeliverySnapshot["plan"]) {
  const byTask = new Map(workflow.stages.map(stage => [stage.taskId, stage]));
  const issues = new Map(source.items.map(item => [item.key, item]));
  const branches = new Map<string, DeliveryAutomaticPlan["nodes"]>();
  const stages = new Map(workflow.stages.map(stage => [stage.jiraKey ?? "analysis", stage]));
  const parentOf = (stage: DeliveryWorkflow["stages"][number]) => stage.parentKey ?? issues.get(stage.jiraKey ?? "")?.parentKey;
  for (const [index, stage] of workflow.stages.entries()) {
    if (!stage.jiraKey) continue;
    const parentKey = parentOf(stage) ?? "交付节点";
    const rows = branches.get(parentKey) ?? [];
    const ancestors = stage.dependsOn ?? workflow.stages.slice(0, index).map(previous => previous.taskId);
    const dependsOn = [...new Set(ancestors.flatMap(taskId => {
      const previous = byTask.get(taskId);
      if (!previous) return [];
      const parent = parentOf(previous);
      return [parent && parent !== parentKey ? parent : previous.jiraKey ?? "analysis"];
    }))];
    rows.push({
      stage: stage.stage, jiraKey: stage.jiraKey, title: issues.get(stage.jiraKey)?.title || stage.jiraKey,
      dependsOn, mode: stage.priorCompletion ? "reuse" : stage.executionMode === "human" ? "human" : "seat",
      seatId: stage.seatId, executor: issues.get(stage.jiraKey)?.assignee || (stage.executionMode === "human" ? "人工办理" : "已分派"),
      startMode: stage.startMode ?? "automatic", completionReview: !!stage.requiresReview, seatChoices: [],
    });
    branches.set(parentKey, rows);
  }
  return { stages, branches };
}

function BranchPlanNodes({ nodes, source, afterParentKey, execution, workflowState }: {
  nodes: DeliveryAutomaticPlan["nodes"];
  source: DeliverySnapshot["plan"];
  afterParentKey?: string;
  execution?: PlanExecutionStages;
  workflowState?: DeliveryWorkflow["state"];
}) {
  if (!nodes.some(node => node.jiraKey)) return <PlanNodes nodes={nodes} />;
  return (
    <>
      <DeliveryPlanDependencyChart nodes={nodes} source={source} afterParentKey={afterParentKey} execution={execution} workflowState={workflowState} />
      <details className="text-sm">
        <summary className="cursor-pointer">查看节点明细</summary>
        <PlanNodes nodes={nodes} />
      </details>
    </>
  );
}

function PlanNodes({ nodes }: { nodes: DeliveryAutomaticPlan["nodes"] }) {
  if (!nodes.length) return null;
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead><tr>
          <th className="p-2 text-left">节点</th>
          <th className="p-2 text-left">处理方式 / 执行人</th>
          <th className="p-2 text-left">前置节点</th>
        </tr></thead>
        <tbody>{nodes.map(node => (
          <tr key={`${node.stage}:${node.jiraKey}`} className="border-t border-border">
            <td className="p-2">{node.jiraKey ?? DELIVERY_STAGE_LABELS[node.stage]} · {node.title}</td>
            <td className="p-2">
              {node.revalidate ? "重新核验" : node.verificationNote ? "历史交付待核验" : node.mode === "reuse" ? "复用已有交付" : node.mode === "human" ? "人工执行" : "席位执行"} · {node.executor}
              {node.mode === "seat" && !node.seatId && node.jiraAssignee !== undefined && (
                <p className="text-muted-foreground">Jira 经办人 · {node.jiraAssignee || "未分配"}</p>
              )}
              {node.verificationNote && <p className="text-muted-foreground">{node.verificationNote}</p>}
              {node.mode !== "reuse" && <p className="text-muted-foreground">
                {node.startMode === "confirmation" ? "需人工确认启动" : "条件满足后自动启动"}
                {node.completionReview ? " · 完成后需人工核验" : ""}
              </p>}
              {node.testResult && <p>Jira 结果描述：{node.testResult}</p>}
              {node.passedTests !== undefined && <p>已全部通过 {node.passedTests} 项测试</p>}
            </td>
            <td className="p-2">{node.dependsOn.join("、") || "无"}</td>
          </tr>
        ))}</tbody>
      </table>
    </div>
  );
}

function PlanFindings({ blockers, excluded }: Pick<DeliveryAutomaticPlan, "blockers" | "excluded">) {
  return <>
    {!!excluded.length && <details className="text-sm text-muted-foreground">
      <summary className="cursor-pointer">查看未纳入的 {excluded.length} 张工单</summary>
      {excluded.map(item => <p key={item.jiraKey}>{item.jiraKey} · {item.reason}</p>)}
    </details>}
    {!!blockers.length && <div className="space-y-2 text-sm" role="alert">
      {blockers.map((blocker, index) => <p key={index}>{blocker.message}</p>)}
    </div>}
  </>;
}
