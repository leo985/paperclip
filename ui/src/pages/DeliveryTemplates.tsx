import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  DELIVERY_STAGE_LABELS,
  DELIVERY_STAGES,
  DELIVERY_ENTRY_CHECKS,
  type DeliveryEntryCheck,
  deliverySequenceLabel,
  deliveryReviewExecution,
  DELIVERY_REVIEW_LABELS,
  type DeliveryReviewStage,
  type DeliveryTemplateDefinition,
} from "@paperclipai/shared";
import { useCompany } from "@/context/CompanyContext";
import { useManagementAccess } from "@/hooks/useManagementAccess";
import { deliveryTemplatesApi } from "@/api/delivery-templates";
import { deliveryWorkflowApi } from "@/api/delivery-workflows";
import { projectsApi } from "@/api/projects";
import { accessApi } from "@/api/access";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
const field = "rounded-md border border-border bg-background p-2 text-sm";
const order = DELIVERY_STAGES;
export function DeliveryTemplates() {
  const { selectedCompanyId: c } = useCompany();
  const { canManage } = useManagementAccess();
  const qc = useQueryClient();
  const [projectId, setProject] = useState("");
  const [draft, setDraft] = useState<DeliveryTemplateDefinition | null>(null);
  const settings = useQuery({
    queryKey: ["delivery-template", c, projectId],
    queryFn: () => deliveryTemplatesApi.get(c!, projectId || undefined),
    enabled: !!c,
  });
  const projects = useQuery({
    queryKey: ["delivery-template-projects", c],
    queryFn: () => projectsApi.list(c!),
    enabled: !!c,
  });
  const seats = useQuery({
    queryKey: ["delivery-workflow-seats", c],
    queryFn: () => deliveryWorkflowApi.seats(c!),
    enabled: !!c && canManage,
  });
  const people = useQuery({
    queryKey: ["delivery-template-people", c],
    queryFn: () => accessApi.listUserDirectory(c!),
    enabled: !!c && canManage,
  });
  const publish = useMutation({
    mutationFn: () =>
      deliveryTemplatesApi.publish(
        c!,
        { ...draft!, inheritOrganization: draft?.inheritOrganization ?? false },
        settings.data?.own?.revision ?? 0,
        projectId || undefined,
      ),
    onSuccess: () => {
      setDraft(null);
      void qc.invalidateQueries({queryKey:["delivery-template",c]});
      void qc.invalidateQueries({queryKey:["delivery-entry",c]});
      void qc.invalidateQueries({queryKey:["delivery-monthly",c]});
    },
  });
  const value = draft ?? settings.data?.effective.definition;
  const entryStage = value ? order.find(stage => value.stages[stage].enabled) : undefined;
  function stageChange(
    key: (typeof order)[number],
    patch: Partial<DeliveryTemplateDefinition["stages"]["design"]>,
  ) {
    if (value)
      setDraft({
        ...value,
        inheritOrganization: false,
        stages: { ...value.stages, [key]: { ...value.stages[key], ...patch } },
      });
  }
  function entryCheckChange(key:DeliveryEntryCheck, checked:boolean) {
    if (!value || !entryStage) return;
    const selected = value.stages[entryStage].entryChecks ?? [];
    const next = checked ? [...selected,key] : selected.filter(item=>item!==key);
    stageChange(entryStage,{entryChecks:next.length?next:undefined});
  }
  if (!c) return <p>请先选择组织。</p>;
  return (
    <div className="mx-auto max-w-4xl space-y-5 p-6">
      <h1 className="text-xl font-semibold">AI交付链</h1>
      <p className="text-sm text-muted-foreground">
        组织默认流程自动用于新建交付。项目可覆盖；已启动流程固定使用原模板版本。所有流程最后都需要人工验收。
      </p>
      <label className="flex items-center gap-3">
        配置范围
        <select
          className={field}
          value={projectId}
          onChange={(e) => {
            setProject(e.target.value);
            setDraft(null);
            publish.reset();
          }}
        >
          <option value="">组织默认</option>
          {projects.data?.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
      </label>
      {settings.isError && <p role="alert">{settings.error.message}</p>}
      {projects.isError && (
        <p role="alert">项目读取失败：{projects.error.message}</p>
      )}
      {seats.isError && <p role="alert">席位读取失败：{seats.error.message}</p>}
      {people.isError && (
        <p role="alert">审核人员读取失败：{people.error.message}</p>
      )}
      {settings.isPending && <p>正在读取…</p>}
      {value && (
        <form
          className="space-y-4"
          onSubmit={(e) => {
            e.preventDefault();
            publish.mutate();
          }}
        >
          <p className="text-sm">
            当前使用：
            {settings.data?.effective.scope === "builtin"
              ? "内置模板"
              : settings.data?.effective.scope === "organization"
                ? "组织模板"
                : "项目模板"}{" "}
            · v{settings.data?.effective.revision}
            {projectId &&
            (!settings.data?.own ||
              settings.data.own.definition.inheritOrganization)
              ? "（继承组织配置）"
              : ""}
          </p>
          {projectId && canManage && (
            <Button
              type="button"
              variant="outline"
              onClick={() => setDraft({ ...value, inheritOrganization: true })}
            >
              恢复继承组织配置（发布后生效）
            </Button>
          )}
          {draft?.inheritOrganization && (
            <p role="status">
              发布后恢复继承组织配置，后续组织模板更新也会自动用于本项目新建流程。
            </p>
          )}
          <label className="block space-y-2">
            模板名称
            <Input
              required
              disabled={!canManage}
              value={value.name}
              onChange={(e) =>
                setDraft({
                  ...value,
                  inheritOrganization: false,
                  name: e.target.value,
                })
              }
            />
          </label>
          <fieldset disabled={!canManage} className="space-y-3 rounded-lg border border-border p-4">
            <legend className="px-2">测试失败自动修复</legend>
            <label className="flex items-center gap-2"><input type="checkbox" aria-label="启用测试失败自动修复" checked={!!value.automaticRepair} onChange={e=>setDraft({...value,inheritOrganization:false,automaticRepair:e.target.checked?{mode:"reuse_existing",maxCycles:3,buildObservationUrl:"",routes:[]}:undefined})}/>按模块路由复用原编码、代码评审和功能测试任务返工</label>
            {value.automaticRepair && <>
              <p className="text-sm text-muted-foreground">实例启动时一次授权。正常产品缺陷自动闭环；达到轮数或预算上限、跨模块归属不明确、环境／用例问题时转人工处理。最终验收仍由人工完成。</p>
              <p className="text-sm text-muted-foreground">使用条目拆分时已有的工单和节点，不创建缺陷单、修复单、重测单或额外代码评审单。模块路由必须对应原执行席位；无法唯一定位时转人工核对。</p>
              <label className="block space-y-2 text-sm">测试环境构建回读地址<Input required type="url" aria-label="测试环境构建回读地址" value={value.automaticRepair.buildObservationUrl} onChange={e=>setDraft({...value,inheritOrganization:false,automaticRepair:{...value.automaticRepair!,buildObservationUrl:e.target.value}})}/></label>
              <p className="text-sm text-muted-foreground">该接口返回当前部署的 version 和 environmentReference；不携带 Jira 凭据。修复席位按已有部署流程交付新构建，回读一致后才允许重测。</p>
              <label className="block space-y-2 text-sm">最多自动修复轮数<Input required type="number" min={1} max={3} aria-label="最多自动修复轮数" value={value.automaticRepair.maxCycles} onChange={e=>setDraft({...value,inheritOrganization:false,automaticRepair:{...value.automaticRepair!,maxCycles:Number(e.target.value)}})}/></label>
              {value.automaticRepair.routes.map((route,index)=><div key={index} className="space-y-2 rounded-md border border-border p-3">
                <label className="block space-y-2 text-sm">模块标识<Input required aria-label={`自动修复模块 ${index+1}`} value={route.module} onChange={e=>setDraft({...value,inheritOrganization:false,automaticRepair:{...value.automaticRepair!,routes:value.automaticRepair!.routes.map((r,i)=>i===index?{...r,module:e.target.value}:r)}})}/></label>
                {([ ["developmentSeatId","原编码席位","coding"], ["reviewSeatId","原代码评审席位","code-review"], ["qaSeatId","原功能测试席位","functional-test"] ] as const).map(([key,label,role])=><label key={key} className="block space-y-2 text-sm">{label}<select required aria-label={`自动${label} ${index+1}`} className={field+" w-full"} value={route[key]} onChange={e=>setDraft({...value,inheritOrganization:false,automaticRepair:{...value.automaticRepair!,routes:value.automaticRepair!.routes.map((r,i)=>i===index?{...r,[key]:e.target.value}:r)}})}><option value="">选择该模块经办人的席位</option>{seats.data?.filter(s=>s.domains.some(d=>d.roles.includes(role))).map(s=><option key={s.id} value={s.id} disabled={key==="reviewSeatId"&&s.id===route.developmentSeatId}>{s.name}</option>)}</select></label>)}
                <Button type="button" variant="ghost" onClick={()=>setDraft({...value,inheritOrganization:false,automaticRepair:{...value.automaticRepair!,routes:value.automaticRepair!.routes.filter((_,i)=>i!==index)}})}>移除模块路由</Button>
              </div>)}
              <Button type="button" variant="outline" onClick={()=>setDraft({...value,inheritOrganization:false,automaticRepair:{...value.automaticRepair!,routes:[...value.automaticRepair!.routes,{module:"",developmentSeatId:"",reviewSeatId:"",qaSeatId:""}]}})}>添加自动修复模块路由</Button>
              {!value.automaticRepair.routes.length&&<p role="status" className="text-sm">至少配置一个模块路由；模块标识须与结构化测试缺陷一致。</p>}
            </>}
          </fieldset>
          {entryStage && <fieldset disabled={!canManage} className="space-y-3 rounded-lg border border-border p-4">
            <legend className="px-2">交付链准入 · 开始节点：{DELIVERY_STAGE_LABELS[entryStage]}</legend>
            <p className="text-sm text-muted-foreground">选择进入本交付链前必须满足的明确条件，所选条件全部满足才能启动。仅使用开始节点的配置；后续阶段继续执行各自门禁。</p>
            {(Object.entries(DELIVERY_ENTRY_CHECKS) as [DeliveryEntryCheck,string][]).map(([key,label])=><label key={key} className="flex items-center gap-2"><input type="checkbox" checked={value.stages[entryStage].entryChecks?.includes(key)??false} onChange={e=>entryCheckChange(key,e.target.checked)}/>{label}</label>)}
            {!value.stages[entryStage].entryChecks?.length&&<p role="status" className="text-sm">尚未配置准入检查项，请至少选择一项并发布。已有交付流程沿用启动时的模板。</p>}
            <p className="text-xs text-muted-foreground">材料内容是否充分仍需人工判断。勾选配置只声明检查规则，不代表该条目已满足条件或正式审批通过。</p>
          </fieldset>}
          {order.map((key) => {
            const stage = value.stages[key];
            const kind =
              key === "analysis"
                ? "analysis"
                : ["design", "coding"].includes(key)
                  ? "development"
                  : "qa";
            return (
              <fieldset
                key={key}
                disabled={!canManage}
                className="space-y-3 rounded-lg border border-border p-4"
              >
                <legend className="px-2">{DELIVERY_STAGE_LABELS[key]}</legend>
                <label className="flex items-center gap-2">
                  <input
                    type="checkbox"
                    checked={stage.enabled}
                    onChange={(e) =>
                      stageChange(key, { enabled: e.target.checked })
                    }
                  />
                  启用此阶段
                </label>
                {stage.enabled && (
                  <div className="grid gap-3 md:grid-cols-2">
                    <label className="flex flex-col gap-2">
                      启动方式
                      <select
                        className={field}
                        value={stage.start}
                        onChange={(e) =>
                          stageChange(key, {
                            start: e.target.value as typeof stage.start,
                          })
                        }
                      >
                        <option value="automatic">前置完成后自动启动</option>
                        <option value="confirmation">负责人确认后启动</option>
                      </select>
                    </label>
                    {key !== "analysis" && <>
                      <label className="flex flex-col gap-2">工作单执行方式
                        <select aria-label={`${DELIVERY_STAGE_LABELS[key]}执行方式`} className={field} value={stage.workExecution ?? "agent"} onChange={e=>stageChange(key,{workExecution:e.target.value as "human"|"agent"})}>
                          <option value="agent">Agent 执行</option><option value="human">人工执行</option>
                        </select>
                      </label>
                      {stage.workExecution === "human" && <label className="flex flex-col gap-2">工作单人工负责人
                        <select aria-label={`${DELIVERY_STAGE_LABELS[key]}人工负责人`} className={field} value={stage.workExecutorUserId ?? ""} onChange={e=>stageChange(key,{workExecutorUserId:e.target.value||undefined})}>
                          <option value="">使用所选默认席位负责人</option>{people.data?.users.map(p=><option key={p.principalId} value={p.principalId}>{p.user?.name??p.principalId}</option>)}
                        </select>
                      </label>}
                    </>}
                    <label className="flex flex-col gap-2">
                      默认席位
                      <select
                        className={field}
                        value={stage.seatId ?? ""}
                        onChange={(e) =>
                          stageChange(key, {
                            seatId: e.target.value || undefined,
                          })
                        }
                      >
                        <option value="">创建交付时选择</option>
                        {seats.data
                          ?.filter((s) =>
                            s.domains.some((d) => d.kind === kind),
                          )
                          .map((s) => (
                            <option key={s.id} value={s.id}>
                              {s.name}
                            </option>
                          ))}
                      </select>
                    </label>
                    {key !== "analysis" && key !== "functional-test" && <>
                      <label className="flex flex-col gap-2">阶段内工单顺序
                        <select aria-label={`${DELIVERY_STAGE_LABELS[key]}工单顺序`} className={field} value={stage.taskSequence??"work_only"} onChange={e=>stageChange(key,{taskSequence:e.target.value as "work_only"|"work_then_review",...(e.target.value==="work_then_review"&&key!=="coding"&&stage.review==="none"?{review:"seat_owner" as const}:{})})}>
                          <option value="work_only">仅工作单（不调度独立评审单）</option>
                          <option value="work_then_review">工作单 → {DELIVERY_REVIEW_LABELS[key as DeliveryReviewStage]}</option>
                        </select>
                      </label>
                      {stage.taskSequence === "work_then_review" && <>
                        <label className="flex flex-col gap-2">{DELIVERY_REVIEW_LABELS[key as DeliveryReviewStage]}执行方式
                          <select aria-label={`${DELIVERY_REVIEW_LABELS[key as DeliveryReviewStage]}执行方式`} className={field} value={deliveryReviewExecution(key,stage)} onChange={e=>stageChange(key,{reviewExecution:e.target.value as "human"|"agent",review:e.target.value==="agent"?"none":stage.review})}>
                            <option value="human">人工执行</option><option value="agent">Agent 执行</option>
                          </select>
                        </label>
                        {deliveryReviewExecution(key,stage)==="human" ? <label className="flex flex-col gap-2">评审单人工负责人
                          <select aria-label={`${DELIVERY_REVIEW_LABELS[key as DeliveryReviewStage]}人工负责人`} className={field} value={stage.reviewExecutorUserId??""} onChange={e=>stageChange(key,{reviewExecutorUserId:e.target.value||undefined})}>
                            <option value="">使用原审核人配置或席位负责人</option>{people.data?.users.map(p=><option key={p.principalId} value={p.principalId}>{p.user?.name??p.principalId}</option>)}
                          </select>
                        </label> : <label className="flex flex-col gap-2">{DELIVERY_REVIEW_LABELS[key as DeliveryReviewStage]}默认席位
                          <select aria-label={`${DELIVERY_REVIEW_LABELS[key as DeliveryReviewStage]}默认席位`} className={field} value={stage.reviewSeatId??""} onChange={e=>stageChange(key,{reviewSeatId:e.target.value||undefined})}>
                            <option value="">创建交付时选择独立席位</option>{seats.data?.filter(s=>s.domains.some(d=>d.kind===kind&&d.roles.includes(key==="coding"?"code-review":key==="design"?"design-review":"test-case-review"))).map(s=><option key={s.id} value={s.id}>{s.name}</option>)}
                          </select>
                        </label>}
                        {deliveryReviewExecution(key,stage)==="agent"&&<p className="text-sm text-muted-foreground md:col-span-2">Agent 评审需要独立席位登记对应原生评审能力；缺少能力时不会自动执行或改派人工。设计／用例评审需 Harness 支持对应评审协议。</p>}
                      </>}
                      <p className="text-sm text-muted-foreground md:col-span-2">阶段内顺序：{deliverySequenceLabel(key,stage)}。{stage.taskSequence==="work_then_review"?deliveryReviewExecution(key,stage)==="agent"?"前置交付后自动启动所绑定的独立 Agent 评审；全部必要评审通过后进入下一阶段。":"工作单交付后自动转交评审负责人，负责人完成真实评审单并登记正式结论后进入下一阶段。":"可按下方配置核验工作单交付，但不会启动独立评审子单。"}</p>
                    </>}
                    {key !== "analysis" && (stage.taskSequence === "work_then_review" || stage.review !== "none" || stage.workExecution === "human") && <>
                      <label className="flex flex-col gap-2">评审退回后
                        <select aria-label={`${DELIVERY_STAGE_LABELS[key]}退回处理方式`} className={field} value={stage.rejectionHandling ?? "pause"} onChange={e=>stageChange(key,{rejectionHandling:e.target.value as "automatic_rework"|"pause"})}>
                          <option value="automatic_rework">自动交回原执行人修改，完成后重新送审</option>
                          <option value="pause">暂停，手动确认后返工</option>
                        </select>
                      </label>
                      <p className="text-sm text-muted-foreground md:col-span-2">退回时必填问题和修改要求。原执行人为 Agent 时自动调度修改；人工执行时交回原负责人。每轮保留版本及评审记录，当前版本通过后才继续后续流程。</p>
                    </>}
                    {key !== "analysis" && (stage.taskSequence === "work_then_review" ? deliveryReviewExecution(key,stage)==="agent" || !stage.reviewExecutorUserId : stage.workExecution!=="human") && (
                      <label className="flex flex-col gap-2">
                        {stage.taskSequence==="work_then_review"&&deliveryReviewExecution(key,stage)==="human"?"人工负责人缺省规则":"Agent 交付后人工核验"}
                        <select
                          className={field}
                          value={stage.review}
                          onChange={(e) =>
                            stageChange(key, {
                              review: e.target.value as typeof stage.review,
                              reviewerUserId: undefined,
                            })
                          }
                        >
                          <option value="none">不额外审核</option>
                          <option value="seat_owner">
                            该阶段席位负责人审核
                          </option>
                          <option value="specified_user">
                            指定组织成员审核
                          </option>
                        </select>
                      </label>
                    )}
                    {stage.review === "specified_user" && (
                      <label className="flex flex-col gap-2">
                        审核人
                        <select
                          required
                          className={field}
                          value={stage.reviewerUserId ?? ""}
                          onChange={(e) =>
                            stageChange(key, { reviewerUserId: e.target.value })
                          }
                        >
                          <option value="">请选择</option>
                          {people.data?.users.map((p) => (
                            <option key={p.principalId} value={p.principalId}>
                              {p.user?.name ?? p.principalId}
                            </option>
                          ))}
                        </select>
                      </label>
                    )}
                  </div>
                )}
              </fieldset>
            );
          })}
          <label className="flex items-center gap-3">
            多个编码单
            <select
              disabled={!canManage}
              className={field}
              value={value.codingExecution}
              onChange={(e) =>
                setDraft({
                  ...value,
                  inheritOrganization: false,
                  codingExecution: e.target.value as "parallel" | "serial",
                })
              }
            >
              <option value="parallel">并行执行，全部完成后进入下一阶段</option>
              <option value="serial">依次执行</option>
            </select>
          </label>
          <label className="flex items-center gap-2">
            <input
              disabled={!canManage}
              type="checkbox"
              checked={value.waitingNotifications}
              onChange={(e) =>
                setDraft({
                  ...value,
                  inheritOrganization: false,
                  waitingNotifications: e.target.checked,
                })
              }
            />
            等待人工处理时按席位通知策略提醒
          </label>
          <p className="text-sm" aria-label="交付链预览">
            流程预览：
            {order
              .filter((k) => value.stages[k].enabled)
              .map(
                (k) =>
                  deliverySequenceLabel(k,value.stages[k]) +
                  (value.stages[k].rejectionHandling === "automatic_rework" ? "（退回自动返工并重审）" : "") +
                  (value.stages[k].review !== "none" && (value.stages[k].taskSequence !== "work_then_review" || k === "coding") ? " → 人工核验" : "") +
                  (k === "coding"
                    ? `（${value.codingExecution === "parallel" ? "并行汇合" : "依次执行"}）`
                    : ""),
              )
              .join(" → ")}{" "}
            → 人工验收
          </p>
          {publish.isError && (
            <p role="alert">发布失败：{publish.error.message}</p>
          )}
          {publish.isSuccess && (
            <p role="status">模板已发布，新建交付将自动接入。</p>
          )}
          {canManage && (
            <div className="flex items-center justify-between gap-3">
              <Button
                type="button"
                variant="ghost"
                onClick={() => setDraft(null)}
              >
                取消修改
              </Button>
              <Button type="submit" disabled={!draft || publish.isPending}>
                {publish.isPending ? "发布中…" : "发布新版本"}
              </Button>
            </div>
          )}
        </form>
      )}
    </div>
  );
}
