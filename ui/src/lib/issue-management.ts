import type { CompactIssue } from "@paperclipai/shared";
import type { RegisteredSeat } from "@/api/dsp7-seats";

export type Execution = { kind: "error" | "ended" | "unknown" | "offline" | "waiting" | "running" | "local" | "queued" | "registered"; label: string; reason: string };
type WorkIdentity = Pick<CompactIssue, "id"> & { status: string };

/** Heartbeat evidence describes execution; task status alone never proves a process is running. */
export function managementExecution(issue: WorkIdentity, seat: RegisteredSeat | undefined, live: boolean, unavailable: boolean | "loading" = false): Execution {
  const task = seat?.presence?.tasks.find(t => t.taskId === issue.id);
  const activeRun = seat?.presence?.activeRuns?.find(run => run.taskId === issue.id);
  if (["done", "cancelled"].includes(issue.status) && !unavailable && (live || (seat?.online && (activeRun || (seat.presence?.activeTaskId === issue.id && ["busy", "waiting_decision"].includes(seat.presence.state)))))) return { kind: "error", label: "结束状态待核对", reason: "工单已结束，但仍有活动运行或席位上报；请查看执行记录核对，不自动停止或恢复。" };
  if (["done", "cancelled"].includes(issue.status)) return { kind: "ended", label: "工单已结束", reason: "任务生命周期已结束，正式交付请核对证据。" };
  if (unavailable === "loading") return { kind: "unknown", label: "执行证据读取中", reason: "正在核对席位和活动运行，暂不推断执行状态。" };
  if (unavailable) return { kind: "unknown", label: "状态读取失败", reason: "执行数据读取失败，不据此推断运行或等待。" };
  if (seat && !seat.online) return { kind: "offline", label: "席位离线", reason: "不能确认本机进程是否仍在运行，请核对设备。" };
  if (activeRun) return activeRun.state === "waiting_decision"
    ? { kind: "waiting", label: "等待人工", reason: seat?.presence?.alerts.find(alert => alert.taskId === issue.id)?.message ?? "本机上报此任务正在等待人工决策。" }
    : { kind: "running", label: "运行中", reason: "在线席位最近心跳确认此任务正在执行。" };
  if (seat?.presence?.activeTaskId === issue.id) {
    if (seat.presence.state === "waiting_decision") return { kind: "waiting", label: "等待人工", reason: seat.presence.alerts.find(a => a.taskId === issue.id)?.message ?? "本机上报正在等待人工决策。" };
    if (["error", "config_error"].includes(seat.presence.state)) return { kind: "error", label: "执行异常", reason: seat.message || "席位上报执行或配置异常。" };
    if (seat.presence.state === "busy") return { kind: "running", label: "运行中", reason: "在线席位最近心跳确认此任务正在执行。" };
    if (seat.presence.state === "awaiting_local") return { kind: "local", label: "等待本机连接", reason: "本机尚未完成会话连接。" };
  }
  if (task && (["failed", "error", "interrupted"].includes(task.status) || task.stoppedRunId)) return { kind: "error", label: "执行已中断", reason: "已有停止记录，需到详情核对恢复条件。" };
  if (live) return { kind: "running", label: "有活动运行", reason: "服务端存在活动运行；本机实时状态仍以席位证据为准。" };
  if (task?.automatic && task.ready) return { kind: "queued", label: "等待调度", reason: "席位已登记自动任务且通过本机准备检查，是否获准执行请查看派单详情。" };
  if (task) return { kind: "registered", label: "已登记待核验", reason: "已登记不代表已授权或已启动，请查看派单与门禁状态。" };
  return { kind: "unknown", label: "状态待核验", reason: "暂无当前执行证据，不将工单的“处理中”直接当作进程运行。" };
}

export function managementSeat(issue: Pick<CompactIssue, "id" | "assigneeAgentId">, seats: RegisteredSeat[]) {
  return seats.find(s => s.online && (s.presence?.activeTaskId === issue.id || s.presence?.activeRuns?.some(run => run.taskId === issue.id)))
    ?? seats.find(s => s.agentId === issue.assigneeAgentId && s.presence?.tasks.some(t => t.taskId === issue.id))
    ?? seats.find(s => s.presence?.tasks.some(t => t.taskId === issue.id))
    ?? seats.find(s => s.agentId === issue.assigneeAgentId);
}

export type ManagementConclusion = {
  group: "attention" | "running" | "queued" | "settled" | "unknown";
  label: string;
  nextAction: string;
  actionLabel: string;
  rank: number;
};

/** A management conclusion never changes the business state or authorizes execution. */
export function managementConclusion(issue: WorkIdentity, execution: Execution, hasAlert = false): ManagementConclusion {
  if (execution.kind === "error") return { group: "attention", label: execution.label, nextAction: "核对本次运行与停止证据，在工单中决定是否恢复。", actionLabel: "查看原因与恢复条件", rank: 0 };
  if (execution.kind === "ended") return { group: "settled", label: "工单已结束，交付另行核验", nextAction: "查看交付材料和正式核验结论。", actionLabel: "查看交付证据", rank: 8 };
  if (execution.kind === "waiting" || execution.kind === "local") return { group: "attention", label: execution.label, nextAction: execution.kind === "local" ? "由席位负责人在本机确认终端连接。" : "打开统一任务详情查看问题与评审材料，按页面提供的方式答复；本机工具权限仍在本机确认。", actionLabel: "查看问题与处理方式", rank: 1 };
  if (issue.status === "blocked" || hasAlert) return { group: "attention", label: issue.status === "blocked" ? "工单阻塞，待处理" : "执行有提醒，待核对", nextAction: "核对阻塞原因与执行证据，由负责人处理后确认结果。", actionLabel: "查看阻塞与下一步", rank: 2 };
  if (execution.kind === "offline") return { group: "attention", label: "席位离线，执行待核实", nextAction: "联系席位负责人检查电脑与连接；离线不证明进程已停止。", actionLabel: "查看工单与设备", rank: 3 };
  if (execution.kind === "running") return { group: "running", label: execution.label, nextAction: "查看执行过程与最新交付材料。", actionLabel: "查看执行", rank: 6 };
  if (execution.kind === "unknown" && !["backlog", "todo"].includes(issue.status)) return { group: "unknown", label: execution.label, nextAction: "核对当前席位和执行证据，不能按业务状态认定正在运行。", actionLabel: "核对执行状态", rank: 4 };
  return { group: "queued", label: execution.label, nextAction: "核对准入、席位和派单授权；已登记不等于可以执行。", actionLabel: "查看安排与准入", rank: 7 };
}

export function managementViewMatches(view: string, issue: WorkIdentity, execution: Execution, hasAlert = false) {
  const conclusion = managementConclusion(issue, execution, hasAlert);
  return view === "all"
    || view === "attention" && ["attention", "unknown"].includes(conclusion.group)
    || view === "pending" && conclusion.group === "queued"
    || view === "running" && conclusion.group === "running"
    || view === "waiting" && ["waiting", "local"].includes(execution.kind)
    || view === "blocked" && issue.status === "blocked"
    || view === "error" && execution.kind === "error"
    || view === "done" && issue.status === "done";
}

/** Configuration readiness is distinct from per-task execution admission. */
export function seatReadiness(seat: RegisteredSeat) {
  const reasons: string[] = [];
  if (!seat.owner) reasons.push("待指定负责人");
  if (!seat.runtime || !seat.usable) reasons.push("设备登记待核验");
  if (!seat.online || !seat.presence) reasons.push("等待电脑上线同步");
  if (seat.presence?.acceptingWork === false || seat.dispatch?.intakePaused) reasons.push("已暂停接单");
  if (!seat.dispatch?.enabled) reasons.push("平台接单规则未启用");
  else {
    if (!seat.dispatch.projectId || !seat.dispatch.workspaceId) reasons.push("项目仓库未绑定");
    if (!seat.dispatch.jiraPatConfigured) reasons.push("Jira 凭据未配置");
    if (!seat.dispatch.readyStatuses.length || !seat.dispatch.issueTypes.length) reasons.push("接单范围未配置");
  }
  for (const check of seat.presence?.checks ?? []) if (check.status === "fail") reasons.push(check.message || check.label);
  if (seat.online && seat.presence && ["config_error", "error"].includes(seat.presence.state)) reasons.push("席位配置或连接异常");
  return { ready: reasons.length === 0, reasons, queueLength: seat.presence?.tasks.filter(t => !["done", "cancelled"].includes(t.status)).length ?? null };
}

