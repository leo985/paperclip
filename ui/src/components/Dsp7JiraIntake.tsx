import { useManagementAccess } from "@/hooks/useManagementAccess";
import { useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import type { Project } from "@paperclipai/shared";
import { dsp7SeatsApi } from "../api/dsp7-seats";
import { agentsApi } from "../api/agents";
import { issuesApi } from "../api/issues";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { Link } from "../lib/router";

/** Uses authenticated task creation; no local paths or credentials are sent to a browser-side executor. */
export function Dsp7JiraIntake({ project }: { project: Project }) {
  const { canOperate, loading: accessLoading } = useManagementAccess();
  const [open, setOpen] = useState(false);
  const [jira, setJira] = useState("");
  const [readyStatus, setReadyStatus] = useState("");
  const [seatId, setSeatId] = useState("");
  const [workspaceId, setWorkspaceId] = useState(project.primaryWorkspace?.id ?? "");
  const storageKey = `dsp7-intake:${project.companyId}:${project.id}`;
  const [taskId, setTaskId] = useState<string | null>(() => { try { return localStorage.getItem(storageKey); } catch { return null; } });
  const { data: agents } = useQuery({ queryKey: ["dsp7-intake-agents", project.companyId], queryFn: () => agentsApi.list(project.companyId) });
  const registry = useQuery({ queryKey: ["dsp7-registered-seats", project.companyId], queryFn: () => dsp7SeatsApi.list(project.companyId), retry: false });
  const selectedSeat = registry.data?.find(item => item.agentId === seatId);
  const workspaces = project.workspaces.filter((w) => Boolean(w.repoUrl) && Boolean(w.repoRef || w.defaultRef));
  const seats = (agents ?? []).filter((agent) => registry.data?.some(seat => seat.agentId === agent.id) && agent.adapterConfig?.dsp7WebJiraIntake === true && agent.adapterConfig?.dsp7Seat && agent.status !== "terminated" && agent.status !== "paused");
  const seatName = (agent: NonNullable<typeof agents>[number]) => String((agent.adapterConfig?.dsp7Seat as { name?: string })?.name ?? agent.name);
  const { data: task, refetch } = useQuery({
    queryKey: ["dsp7-jira-intake", project.companyId, taskId],
    queryFn: () => issuesApi.get(taskId!), enabled: Boolean(taskId),
    refetchInterval: (query) => query.state.data?.description?.includes('"status": "ready"') || query.state.data?.status === "blocked" ? false : 3000,
  });
  let result: { status: string; message: string; jira_key?: string; seat_name?: string } | null = null;
  try {
    const raw = task?.description?.match(/<!-- DSP7-INTAKE-RESULT (.*?) -->/)?.[1];
    if (raw) result = JSON.parse(raw);
  } catch { /* A missing receipt never means registration succeeded. */ }
  const submit = useMutation({
    mutationFn: async () => {
      const key = jira.trim().toUpperCase();
      if (!/^[A-Z][A-Z0-9_]*-\d+$/.test(key)) throw new Error("请输入有效的 Jira 子工单号");
      if (!workspaceId || !seatId || !readyStatus.trim()) throw new Error("请选择仓库工作区、执行席位，并填写允许执行的 Jira 状态");
      if (!selectedSeat?.usable) throw new Error("所选席位需要在本机执行 harness seat register/check 刷新登记");
      await dsp7SeatsApi.verify(project.companyId, selectedSeat);
      // Reconcile a lost create response or a repeated click before creating another request.
      const prior = await issuesApi.list(project.companyId, { projectId: project.id, q: key });
      const existing = prior.find((item) => item.status !== "cancelled" && item.description?.includes('"jira_key":"'+key+'"') && item.description.includes("DSP7-JIRA-INTAKE"));
      const request = { version: 2, seat_id: seatId, jira_key: key, project_id: project.id, workspace_id: workspaceId, ready_status: readyStatus.trim() };
      if (existing) {
        const previous = JSON.parse(existing.description?.match(/<!-- DSP7-JIRA-INTAKE (.*?) -->/)?.[1] ?? "{}");
        if (previous.version !== 2 || previous.seat_id !== seatId || previous.workspace_id !== workspaceId || previous.ready_status !== readyStatus.trim()) throw new Error("该工单已有不同席位或配置的申请，请打开已有任务核对，不能重复分派");
      }
      const issue = existing ?? await issuesApi.create(project.companyId, {
        title: "Jira 接入申请 "+key,
        projectId: project.id, projectWorkspaceId: workspaceId, assigneeAdapterOverrides: { useProjectWorkspace: false }, status: "backlog", priority: "medium",
        description: `申请接入 Jira 子工单 ${key}。所选席位的本地接入桥核验共享仓库、本机映射和 Jira 状态后准备独立工作树，登记完成后由研发人员打开本地终端。\n\n<!-- DSP7-JIRA-INTAKE ${JSON.stringify(request)} -->`,
      });
      const serialized = issue.description?.match(/<!-- DSP7-JIRA-INTAKE (.*?) -->/)?.[1];
      if (!serialized) throw new Error("接入申请内容缺失，请查看任务");
      const authorization = `<!-- DSP7-JIRA-INTAKE-AUTH ${serialized} -->`;
      const comments = await issuesApi.listComments(issue.id);
      if (!comments.some((comment) => !comment.authorAgentId && comment.body.includes(authorization))) {
        await issuesApi.addComment(issue.id, `请按本申请接入 Jira 工单并准备工作树；登记完成后由我在本机启动。\n\n${authorization}`, false, false, undefined, crypto.randomUUID());
      }
      return issue;
    },
    onSuccess: (issue) => { setTaskId(issue.id); try { localStorage.setItem(storageKey, issue.id); } catch { /* Task remains on the server. */ } },
  });
  const retry = useMutation({
    mutationFn: () => issuesApi.update(taskId!, { status: "backlog" }),
    onSuccess: () => void refetch(),
  });
  if (accessLoading) return <p className="text-sm text-muted-foreground">正在加载操作权限…</p>;
  if (!canOperate) return <p className="text-sm text-muted-foreground">当前身份仅可查看。接入 Jira 工单需研发成员身份及对应席位授权。</p>;
  if (!agents?.some((agent) => agent.adapterConfig?.dsp7WebJiraIntake === true)) return null;
  return (
    <section className="rounded-lg border border-border p-4 space-y-3">
      <div className="flex items-center justify-between gap-3">
        <div><h3 className="font-medium">接入 Jira 工单</h3><p className="text-sm text-muted-foreground">选择共享仓库和执行席位；每台电脑使用自己登记的本地路径。</p></div>
        <Button variant="outline" onClick={() => setOpen(!open)}>{open ? "收起" : "接入工单"}</Button>
      </div>
      {open && <form className="space-y-3" onSubmit={(event) => { event.preventDefault(); submit.mutate(); }}>
        <label className="block text-sm space-y-1"><span>Jira 子工单号</span><Input value={jira} onChange={(event) => { setJira(event.target.value); setTaskId(null); }} placeholder="ATSES-XXXXX" required /></label>
        <label className="block text-sm space-y-1"><span>Project 工作区</span>
          <select className="w-full rounded-md border border-input bg-background p-2" value={workspaceId} onChange={(event) => setWorkspaceId(event.target.value)} required>
            <option value="">请选择共享仓库工作区</option>{workspaces.map((w) => <option key={w.id} value={w.id}>{w.name} — {w.repoUrl} ({w.repoRef || w.defaultRef})</option>)}
          </select>
        </label>
        <label className="block text-sm space-y-1"><span>执行席位</span><select className="w-full rounded-md border border-input bg-background p-2" value={seatId} onChange={(event) => setSeatId(event.target.value)} required><option value="">请选择执行电脑／研发席位</option>{seats.map((agent) => <option key={agent.id} value={agent.id}>{seatName(agent)}</option>)}</select></label>
        {selectedSeat && <p className="text-xs text-muted-foreground">{selectedSeat.environmentName} · {selectedSeat.runtime?.claudeVersion ?? "未登记 Claude"} · {selectedSeat.message}</p>}
        {registry.error && <p role="alert" className="text-sm text-destructive">{registry.error.message}</p>}
        <label className="block text-sm space-y-1"><span>允许执行的 Jira 状态</span><Input value={readyStatus} onChange={(event) => setReadyStatus(event.target.value)} placeholder="填写工单当前允许开工的状态" required /></label>
        {seats.length === 0 && <p className="text-sm text-destructive">没有已登记的执行席位，请管理员为研发电脑配置独立 Agent。</p>}
        {workspaces.length === 0 && <p className="text-sm text-destructive">请先在共享工作区配置仓库 URL 和基线分支；本地路径由各席位通过 harness repo bind 登记。</p>}
        <p className="text-sm text-muted-foreground">只接入未完成的编码、Bug 或设计子工单。所选席位离线时申请保留，在线后处理；其他席位不会领取。登记不会自动开工。</p>
        {(submit.error || retry.error) && <p role="alert" className="text-sm text-destructive">{(submit.error || retry.error)?.message}</p>}
        <div className="flex items-center justify-between gap-3">
          <Button type="button" variant="ghost" onClick={() => setOpen(false)}>关闭</Button>
          <Button type="submit" disabled={submit.isPending || workspaces.length === 0 || seats.length === 0 || !selectedSeat?.usable}>{submit.isPending ? "正在提交…" : "提交接入申请"}</Button>
        </div>
      </form>}
      {taskId && <div className="space-y-2 text-sm" role="status">
        <p>{task?.status === "backlog" && result?.status === "blocked" ? "已重新提交，等待本机核验。" : result?.message ?? "申请已保存，等待本机接入桥处理。"}</p>
        <Link className="underline" to={`/issues/${task?.identifier ?? taskId}`}>打开 {task?.identifier ?? "接入任务"}</Link>
        {result?.status === "ready" && task?.status !== "done" && task?.status !== "cancelled" && <p>在 {result?.seat_name ?? "所选席位"} 的终端执行：<code>harness start {result?.jira_key ?? jira.trim().toUpperCase()} --confirm-no-other-executor</code></p>}
        {task?.status === "blocked" && <Button type="button" variant="outline" disabled={retry.isPending} onClick={() => retry.mutate()}>修复共享配置或所选席位映射后重试接入</Button>}
      </div>}
    </section>
  );
}
