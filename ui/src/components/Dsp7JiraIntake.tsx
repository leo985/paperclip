import { SeatStartupProgress } from "./SeatStartupProgress";
import { JiraIntakeSourceStatus } from "./JiraIntakeSourceStatus";
import { useManagementAccess } from "@/hooks/useManagementAccess";
import { useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { HARNESS_REPOSITORY_MANAGEMENT_CAPABILITY, type HarnessManagedJiraIntake, type Project } from "@paperclipai/shared";
import { dsp7SeatsApi } from "../api/dsp7-seats";
import { agentsApi } from "../api/agents";
import { issuesApi } from "../api/issues";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { Badge } from "./ui/badge";
import { executionMessage } from "../lib/dsp7-execution";
import { Link } from "../lib/router";

/** Uses authenticated task creation; no local paths or credentials are sent to a browser-side executor. */
export function Dsp7JiraIntake({ project, initialSeatId = "", initialJiraKey = "" }: { project: Project; initialSeatId?: string; initialJiraKey?: string }) {
  const { canOperate, loading: accessLoading } = useManagementAccess();
  const [open, setOpen] = useState(Boolean(initialSeatId || initialJiraKey));
  const [execution, setExecution] = useState<"dispatch"|"register">("dispatch");
  const [jira, setJira] = useState(initialJiraKey);
  const [seatId, setSeatId] = useState(initialSeatId);
  const storageKey = `dsp7-intake:${project.companyId}:${project.id}`;
  const [taskId, setTaskId] = useState<string | null>(() => { try { return localStorage.getItem(storageKey); } catch { return null; } });
  const agentQuery = useQuery({ queryKey: ["dsp7-intake-agents", project.companyId], queryFn: () => agentsApi.list(project.companyId) });
  const agents = agentQuery.data;
  const registry = useQuery({ queryKey: ["dsp7-registered-seats", project.companyId], queryFn: () => dsp7SeatsApi.list(project.companyId), retry: false });
  const selectedSeat = registry.data?.find(item => item.agentId === seatId);
  const seats = (agents ?? []).filter((agent) => registry.data?.some(seat => seat.agentId === agent.id) && agent.adapterConfig?.dsp7WebJiraIntake === true && agent.adapterConfig?.dsp7Seat && agent.status !== "terminated" && agent.status !== "paused");
  const checkKey = `${seatId}:${project.id}:${jira.trim().toUpperCase()}`;
  const preview = useMutation({
    mutationFn: async (key: string) => ({ key, result: await dsp7SeatsApi.previewIntake(project.companyId, seatId, { jiraKey: jira.trim().toUpperCase(), projectId: project.id }) }),
  });
  const currentPreview = preview.data?.key === checkKey ? preview.data.result : null;
  const seatRule = selectedSeat?.dispatch;
  const supportsSeatRule = selectedSeat?.presence?.capabilities?.includes(HARNESS_REPOSITORY_MANAGEMENT_CAPABILITY) === true;
  const seatName = (agent: NonNullable<typeof agents>[number]) => String((agent.adapterConfig?.dsp7Seat as { name?: string })?.name ?? agent.name);
  const { data: task, refetch } = useQuery({
    queryKey: ["dsp7-jira-intake", project.companyId, taskId],
    queryFn: () => issuesApi.get(taskId!), enabled: Boolean(taskId),
    refetchInterval: (query) => query.state.data?.description?.includes('"status": "ready"') || query.state.data?.status === "blocked" ? false : 3000,
  });
  let taskSeat = "";
  try { taskSeat = JSON.parse(task?.description?.match(/<!-- DSP7-JIRA-INTAKE (.*?) -->/)?.[1] ?? "{}").seat_id ?? ""; } catch { /* Invalid metadata does not authorize dispatch. */ }
  const dispatchState = useQuery({ queryKey: ["platform-dispatch", project.companyId, taskSeat, taskId], queryFn: () => dsp7SeatsApi.dispatchStatus(project.companyId, taskSeat, taskId!), enabled: Boolean(taskId && taskSeat), refetchInterval: 3000 });
  const phaseLabels: Record<string,string> = {command_pending:"等待本机领取",opening_terminal:"打开本机终端",starting:"正在启动",retry_pending:"准备自动重试（最多一次）",interrupted:"执行已中断",reconnecting:"等待终端重连",startup_failed:"启动未完成",waiting_online:"等待席位上线",queued:"排队中",preparing:"准备中",ready_to_start:"等待启动",running:"执行中",waiting_decision:"等待人工决策",blocked:"已阻塞",done:"已完成",cancelled:"已取消",dispatch_cancelled:"已取消自动执行",registered_only:"仅登记"};
  const dispatch = useMutation({ mutationFn: (action: "authorize"|"cancel"|"resume") => dsp7SeatsApi.platformDispatch(project.companyId, taskSeat, taskId!, action), onSuccess: () => { void dispatchState.refetch(); void refetch(); } });
  let result: { status: string; message: string; jira_key?: string; seat_name?: string } | null = null;
  try {
    const raw = task?.description?.match(/<!-- DSP7-INTAKE-RESULT (.*?) -->/)?.[1];
    if (raw) result = JSON.parse(raw);
  } catch { /* A missing receipt never means registration succeeded. */ }
  const submit = useMutation({
    mutationFn: async () => {
      const key = jira.trim().toUpperCase();
      if (task && task.description?.includes('"jira_key":"'+key+'"')) throw new Error("此工单已接入，请在下方原任务卡片查看进度或恢复执行，无需再次派单");
      if (!/^[A-Z][A-Z0-9_]*-\d+$/.test(key)) throw new Error("请输入有效的 Jira 子工单号");
      if (!seatId) throw new Error("请选择执行席位");
      if (!selectedSeat?.usable) throw new Error("所选席位需要在本机执行 harness seat register/check 刷新登记");
      await dsp7SeatsApi.verify(project.companyId, selectedSeat);
      // Reconcile a lost create response or a repeated click before creating another request.
      const prior = await issuesApi.list(project.companyId, { projectId: project.id, q: key });
      const existing = prior.find((item) => item.status !== "cancelled" && item.description?.includes('"jira_key":"'+key+'"') && item.description.includes("DSP7-JIRA-INTAKE"));
      const request: HarnessManagedJiraIntake = { version: 4, seat_id: seatId, jira_key: key, project_id: project.id, status_source: "seat_rule" };
      if (existing) {
        const previous = JSON.parse(existing.description?.match(/<!-- DSP7-JIRA-INTAKE (.*?) -->/)?.[1] ?? "{}");
        if (![2, 3, 4].includes(previous.version) || previous.seat_id !== seatId || previous.project_id !== project.id) throw new Error("该工单已有不同席位或配置的申请，请打开已有任务核对，不能重复分派");
      }
      if (execution === "dispatch" && !selectedSeat?.presence?.capabilities?.includes("platform-dispatch-v1")) throw new Error("请先更新所选席位客户端以支持平台派单执行");
      if (!existing && !supportsSeatRule) throw new Error("请先到席位详情 → 设备与诊断更新客户端，等待席位上报支持新版接入规则后再提交");
      if (!existing) await dsp7SeatsApi.previewIntake(project.companyId, seatId, { jiraKey: key, projectId: project.id });
      const issue = existing ?? await issuesApi.create(project.companyId, {
        title: "Jira 接入申请 "+key,
        projectId: project.id, projectWorkspaceId: null, assigneeAdapterOverrides: { useProjectWorkspace: false }, status: "backlog", priority: "medium",
        description: `申请接入 Jira 子工单 ${key}，复用所选席位接单规则中的项目、类型与允许状态；Jira 经办人仅作来源信息，不单独指定状态。本机核验 Jira 和执行授权后从 Harness 根目录启动；实际仓库、本机目录和工作树由 Harness 套件管理。\n\n<!-- DSP7-JIRA-INTAKE ${JSON.stringify(request)} -->`,
      });
      const serialized = issue.description?.match(/<!-- DSP7-JIRA-INTAKE (.*?) -->/)?.[1];
      if (!serialized) throw new Error("接入申请内容缺失，请查看任务");
      const authorization = `<!-- DSP7-JIRA-INTAKE-AUTH ${serialized} -->`;
      const comments = await issuesApi.listComments(issue.id);
      if (!comments.some((comment) => !comment.authorAgentId && comment.body.includes(authorization))) {
        await issuesApi.addComment(issue.id, `请按本申请接入 Jira 工单；执行仓库和工作树由本机 Harness 管理。\n\n${authorization}`, false, false, undefined, crypto.randomUUID());
      }
      setTaskId(issue.id);
      if (execution === "dispatch") await dsp7SeatsApi.platformDispatch(project.companyId, seatId, issue.id);
      return issue;
    },
    onSuccess: (issue) => { setTaskId(issue.id); void dispatchState.refetch(); try { localStorage.setItem(storageKey, issue.id); } catch { /* Task remains on the server. */ } },
  });
  const retry = useMutation({
    mutationFn: () => issuesApi.update(taskId!, { status: "backlog", unblockDescriptor: null }),
    onSuccess: () => void refetch(),
  });
  if (accessLoading) return <p className="text-sm text-muted-foreground">正在加载操作权限…</p>;
  if (!canOperate) return <p className="text-sm text-muted-foreground">当前身份仅可查看。接入 Jira 工单需研发成员身份及对应席位授权。</p>;
  if (initialSeatId && (registry.isPending || agentQuery.isPending)) return <p className="text-sm text-muted-foreground">正在核对指定席位…</p>;
  if (initialSeatId && (registry.isError || agentQuery.isError)) return <p role="alert" className="text-sm text-destructive">席位信息加载失败，请刷新重试。</p>;
  if (initialSeatId && !seats.some(agent => agent.id === initialSeatId)) return <p role="alert" className="text-sm text-destructive">指定席位不存在、无访问权限、已暂停或未启用 Jira 接入。请到席位管理核对，不会自动改派其他电脑。</p>;
  if (!agents?.some((agent) => agent.adapterConfig?.dsp7WebJiraIntake === true)) return null;
  const currentTaskLabel = task?.identifier ?? "当前任务";
  const taskMessage = executionMessage(dispatchState.data?.message);
  const currentSeat = registry.data?.find(item => item.agentId === taskSeat);
  return (
    <section className="rounded-lg border border-border p-4 space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div><h3 className="font-medium">Jira 工单执行</h3><p className="text-sm text-muted-foreground">查看已接入任务的进度，或接入其他 Jira 工单。</p></div>
        <Button variant="outline" aria-expanded={open} onClick={() => setOpen(!open)}>{open ? "收起接入表单" : taskId ? "接入其他工单" : "接入 Jira 工单"}</Button>
      </div>
      {open && <form className="space-y-3 border-t border-border pt-4" onSubmit={(event) => { event.preventDefault(); submit.mutate(); }}>
        <h4 className="font-medium">{taskId ? "接入其他 Jira 工单" : "接入 Jira 工单"}</h4>
        {taskId && <p className="text-sm text-muted-foreground">此表单用于接入其他工单；当前任务请在下方卡片查看或恢复。</p>}
        <label className="block text-sm space-y-1"><span>Jira 子工单号</span><Input value={jira} onChange={(event) => setJira(event.target.value)} placeholder="ATSES-XXXXX" required /></label>
        <label className="block text-sm space-y-1"><span>执行席位</span><select className="w-full rounded-md border border-input bg-background p-2" value={seatId} onChange={(event) => setSeatId(event.target.value)} required><option value="">请选择执行电脑／研发席位</option>{seats.map((agent) => <option key={agent.id} value={agent.id}>{seatName(agent)}</option>)}</select></label>
        {selectedSeat && <p className="text-xs text-muted-foreground">{selectedSeat.environmentName} · {selectedSeat.runtime?.claudeVersion ?? "未登记 Claude"} · {selectedSeat.message}</p>}
        {registry.error && <p role="alert" className="text-sm text-destructive">{registry.error.message}</p>}
        {seatId && <div className="space-y-2 rounded-md bg-muted p-3 text-sm">
          <p className="font-medium">复用席位接单规则，无需重复选择状态</p>
          {!supportsSeatRule && <p role="alert" className="text-destructive">请先在席位详情 → 设备与诊断更新客户端。新版客户端上报后可提交新申请，旧申请仍可查看。</p>}
          {seatRule?.readyStatuses?.length ? <>
            <p>Jira 项目：{seatRule.jiraProjectKey} · 经办人：{seatRule.jiraAssignee}</p>
            <p>允许开工状态：{seatRule.readyStatuses.join("、")}</p>
            <p>工单类型：{seatRule.issueTypes.join("、")}</p>
            {(seatRule.projectId !== project.id) && <p role="alert" className="text-destructive">所选项目与席位规则不一致，请调整席位接单设置。</p>}
          </> : <p role="alert" className="text-destructive">该席位尚未配置接单规则，请先配置 Jira 连接、接单范围与允许开工状态。</p>}
          <Link className="underline" to="/seats">前往席位接单设置</Link>
          <p className="text-xs text-muted-foreground">派单代表授权席位自动执行；系统检查独占锁和其他执行者，无需逐单输入命令。提交及启动前会重新校验。</p>
          <Button type="button" variant="outline" disabled={preview.isPending || !/^[A-Z][A-Z0-9_]*-\d+$/.test(jira.trim().toUpperCase())} onClick={() => preview.mutate(checkKey)}>{preview.isPending ? "正在核验…" : "核验工单与席位规则"}</Button>
          {currentPreview && <p role="status">核验通过：{currentPreview.jiraKey} · {currentPreview.status} · {currentPreview.issueType} · {currentPreview.summary}</p>}
          {preview.error && preview.variables === checkKey && <p role="alert" className="text-destructive">{preview.error.message}</p>}
        </div>}
        {seats.length === 0 && <p className="text-sm text-destructive">没有已登记的执行席位，请管理员为研发电脑配置独立 Agent。</p>}
        <p className="text-sm text-muted-foreground">仓库选择、本机目录和 Git 工作树由 Harness 套件管理，可按工单处理多个仓库。</p>
        <p className="text-sm text-muted-foreground">只接入符合规则的未完成子工单。离线时等待上线，忙碌时排队；本机打开可见终端执行，遇到决策再通知负责人。</p>
        <details className="space-y-2 text-sm"><summary className="cursor-pointer">执行方式（默认派单并执行）</summary><label className="flex gap-2"><input type="radio" name="execution" checked={execution==="dispatch"} onChange={()=>setExecution("dispatch")}/>派单并执行：自动准备、排队并启动</label><label className="flex gap-2"><input type="radio" name="execution" checked={execution==="register"} onChange={()=>setExecution("register")}/>仅登记：准备后由我在本机启动</label></details>
        {(submit.error || retry.error) && <p role="alert" className="text-sm text-destructive">{(submit.error || retry.error)?.message}</p>}
        <div className="flex items-center justify-between gap-3">
          <Button type="button" variant="ghost" onClick={() => setOpen(false)}>关闭</Button>
          <Button type="submit" disabled={submit.isPending || seats.length === 0 || !selectedSeat?.usable}>{submit.isPending ? "正在提交…" : execution === "dispatch" ? "派单并执行" : "仅登记"}</Button>
        </div>
      </form>}
      {taskId && <article className="space-y-3 rounded-lg bg-muted p-4 text-sm" aria-label="当前接入任务">
        {taskSeat && <JiraIntakeSourceStatus companyId={project.companyId} seatId={taskSeat} taskId={taskId} />}
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h4 className="font-medium">{currentTaskLabel}{task?.title ? ` · ${task.title}` : " · 正在加载任务…"}</h4>
          {dispatchState.data && <Badge variant="outline">{phaseLabels[dispatchState.data.phase] ?? dispatchState.data.phase}</Badge>}
        </div>
        {currentSeat && <p className="text-muted-foreground">执行席位：{currentSeat.name}</p>}
        <div role="status" className="space-y-2">
          {taskMessage.text && <p>{taskMessage.text}</p>}
          <SeatStartupProgress progress={dispatchState.data?.startup} />
          {dispatchState.data?.phase === "interrupted" && !dispatchState.data.canResume && dispatchState.data.resumeBlockedReason && <p className="text-muted-foreground">{dispatchState.data.resumeBlockedReason}</p>}
          {dispatchState.data?.phase === "interrupted" && <p className="text-muted-foreground">恢复将继续原任务和 Harness 进度，并打开新的 Claude 会话。</p>}
          {!dispatchState.data?.authorized && <p>{task?.status === "backlog" && result?.status === "blocked" ? "已重新提交，等待本机核验。" : result?.message ?? "申请已保存，等待本机接入桥处理。"}</p>}
        </div>
        {(dispatchState.error || dispatch.error) && <p role="alert" className="text-destructive">{(dispatchState.error || dispatch.error)?.message}</p>}
        <div className="flex flex-wrap items-center justify-between gap-3">
          <Link className="text-primary underline underline-offset-4" to={`/issues/${task?.identifier ?? taskId}`}>查看任务详情</Link>
          <div className="flex flex-wrap items-center gap-2">
            {taskSeat && task && ["backlog","todo"].includes(task.status) && !dispatchState.data?.authorized && <Button type="button" disabled={dispatch.isPending} onClick={()=>dispatch.mutate("authorize")}>执行 {currentTaskLabel}</Button>}
            {dispatchState.data?.authorized && ["waiting_online","queued","preparing","ready_to_start","retry_pending","startup_failed","command_pending","opening_terminal"].includes(dispatchState.data.phase) && <Button type="button" variant="outline" disabled={dispatch.isPending} onClick={()=>dispatch.mutate("cancel")}>取消自动执行</Button>}
            {dispatchState.data?.phase === "interrupted" && <Button type="button" disabled={dispatch.isPending || !dispatchState.data?.canResume} onClick={()=>dispatch.mutate("resume")}>{dispatch.isPending ? "正在恢复…" : `恢复 ${currentTaskLabel}`}</Button>}
            {task?.status === "blocked" && dispatchState.data?.phase !== "interrupted" && <Button type="button" variant="outline" disabled={retry.isPending} onClick={() => retry.mutate()}>修复后重试接入</Button>}
          </div>
        </div>
        {(taskMessage.runId || (result?.status === "ready" && !dispatchState.data?.authorized && task?.status !== "done" && task?.status !== "cancelled")) && <details className="space-y-2 text-xs text-muted-foreground"><summary className="cursor-pointer">技术详情</summary>
          {taskMessage.runId && <p className="break-all">运行编号：<code className="font-mono">{taskMessage.runId}</code></p>}
          {result?.status === "ready" && !dispatchState.data?.authorized && task?.status !== "done" && task?.status !== "cancelled" && <p>本机手动启动：<code className="break-all font-mono">harness start {result?.jira_key ?? jira.trim().toUpperCase()} --confirm-no-other-executor</code></p>}
        </details>}
      </article>}
    </section>
  );
}
