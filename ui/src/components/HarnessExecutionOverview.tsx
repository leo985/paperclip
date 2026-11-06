import { useState } from "react";
import { StatusBadge } from "./StatusBadge";
import type { ManagedSessionDetail, ManagedTimelineEvent } from "@paperclipai/shared";

const phaseStates: Record<string, string> = {
  started: "执行中", observed: "已观察", reopened: "已重开",
  passed: "门禁通过", failed: "门禁未通过", skipped: "有依据跳过",
};
const stamp = (value: string) => new Date(value).toLocaleString("zh-CN");
function elapsed(ms: number) {
  const seconds = Math.floor(Math.max(0, ms) / 1000);
  return seconds < 60 ? `${seconds} 秒` : `${Math.floor(seconds / 60)} 分 ${seconds % 60} 秒`;
}
export function executionPhaseRows(events: ManagedTimelineEvent[]) {
  const groups = new Map<string, { key: string; name: string; version: string; events: ManagedTimelineEvent[] }>();
  for (const event of [...events].sort((a, b) => Date.parse(a.occurredAt) - Date.parse(b.occurredAt))) {
    if (event.eventType !== "phase" || typeof event.payload.phase !== "string" || !event.payload.phase.trim()) continue;
    const name = event.payload.phase;
    const version = String(event.payload.flowVersion ?? "未提供流程版本");
    const key = JSON.stringify([version, name]);
    if (!groups.has(key)) groups.set(key, { key, name, version, events: [] });
    groups.get(key)!.events.push(event);
  }
  return [...groups.values()].map(group => {
    const latest = group.events.at(-1)!;
    const status = String(latest.payload.status ?? "observed");
    const evidence = Array.isArray(latest.payload.evidence) ? latest.payload.evidence : [];
    // Observation alone is never a completed gate. Reopening supersedes an earlier pass.
    const passed = status === "passed" && typeof latest.payload.gateVersion === "string" && /^[a-f0-9]{64}$/.test(latest.payload.gateVersion) && evidence.length > 0 && evidence.every(item => item && typeof item === "object" && item.exitCode === 0 && typeof item.script === "string" && typeof item.scriptSha256 === "string" && /^[a-f0-9]{64}$/.test(item.scriptSha256));
    const start = group.events.findLast(e => ["started", "reopened"].includes(String(e.payload.status)));
    const closed = ["passed", "failed", "skipped"].includes(status);
    return { ...group, latest, status, evidence, passed, start, durationMs: start && closed ? Math.max(0, Date.parse(latest.occurredAt) - Date.parse(start.occurredAt)) : null };
  });
}
export function HarnessExecutionSummary({ detail }: { detail: ManagedSessionDetail }) {
  const { timing } = detail;
  const metrics = [
    ["本轮总历时", elapsed(timing.elapsedMs)], ["Agent 执行", elapsed(timing.executingMs)],
    ["人工等待", elapsed(timing.waitingMs)], ["状态未知", elapsed(timing.unknownMs)],
    ["时间观测覆盖", `${(timing.coverage * 100).toFixed(1)}%`],
    ["关联缺陷", detail.quality ? `${detail.quality.defects.length} 个` : "未采集"],
  ];
  return <section aria-label="本轮执行总览" className="space-y-2">
    <div className="grid grid-cols-2 gap-3 lg:grid-cols-6">{metrics.map(([label, value]) => <div key={label} className="rounded-md bg-muted p-3"><p className="text-xs text-muted-foreground">{label}</p><p className="mt-1 font-mono text-base font-semibold">{value}</p></div>)}</div>
    <p className="text-xs text-muted-foreground">仅统计当前执行会话；未知时间不计为空闲。Token 用量及阶段内执行／等待拆分尚未接入此视图；会话结束不代表正式交付验收通过。</p>
  </section>;
}
export function HarnessExecutionOverview({ detail }: { detail: ManagedSessionDetail }) {
  const [selection, setSelection] = useState<string | null>(null);
  const rows = executionPhaseRows(detail.phases);
  const latest = rows.reduce<(typeof rows)[number] | undefined>((current, row) => !current || Date.parse(row.latest.occurredAt) >= Date.parse(current.latest.occurredAt) ? row : current, undefined);
  const selected = rows.find(row => row.key === selection) ?? latest;
  const label = (row: (typeof rows)[number]) => row.status === "passed" && !row.passed ? "通过上报待核验" : phaseStates[row.status] ?? "阶段状态未知";
  return <section aria-label="Harness 执行流程" className="min-w-0 space-y-4">
    <div><h3 className="font-semibold">执行流程</h3><p className="text-xs text-muted-foreground">按本轮实际阶段上报排列；选择阶段查看门禁与证据。不同流程版本分别展示，不预设研发或测试阶段。</p></div>
    {!selected ? <p className="rounded-md bg-muted p-4 text-sm text-muted-foreground">尚未采集到 Harness 阶段事件。可切换查看已采集对话；不会根据对话或运行结束推测阶段完成。</p> : <>
      <div className="flex gap-3 overflow-x-auto pb-2" role="group" aria-label="选择执行阶段">{rows.map((row, index) => <button key={row.key} type="button" aria-pressed={selected.key === row.key} onClick={() => setSelection(row.key)} className={`flex shrink-0 flex-col items-start gap-1 rounded-md border p-3 text-left text-sm focus-visible:outline focus-visible:outline-primary ${selected.key === row.key ? "border-primary bg-accent" : "border-border hover:bg-accent"}`}>
        <span className="text-xs text-muted-foreground">阶段 {index + 1}</span><StatusBadge status={row.passed ? "succeeded" : row.status === "failed" ? "failed" : ["started", "reopened"].includes(row.status) ? "running" : "queued"} label={label(row)} /><span className="font-semibold">{row.name}</span><span className="font-mono text-xs text-muted-foreground">{row.durationMs === null ? "阶段耗时未闭合" : elapsed(row.durationMs)}</span>
      </button>)}</div>
      <section aria-label="所选阶段详情" className="space-y-4 rounded-lg border border-border p-4">
        <header className="flex flex-wrap items-center justify-between gap-2"><h4 className="font-semibold">{selected.name}</h4><StatusBadge status={selected.passed ? "succeeded" : selected.status === "failed" ? "failed" : ["started", "reopened"].includes(selected.status) ? "running" : "queued"} label={label(selected)} /></header>
        <dl className="grid gap-3 text-sm md:grid-cols-3"><div><dt className="text-xs text-muted-foreground">最近开始／重开</dt><dd>{selected.start ? stamp(selected.start.occurredAt) : "未采集"}</dd></div><div><dt className="text-xs text-muted-foreground">最近阶段事件</dt><dd>{stamp(selected.latest.occurredAt)}</dd></div><div><dt className="text-xs text-muted-foreground">本次阶段历时（含等待）</dt><dd>{selected.durationMs === null ? "未采集完整起止事件" : elapsed(selected.durationMs)}</dd></div></dl>
        <details className="text-xs text-muted-foreground"><summary className="cursor-pointer">流程与门禁版本</summary><p className="mt-2 break-all font-mono">流程：{selected.version}</p><p className="break-all font-mono">门禁：{String(selected.latest.payload.gateVersion ?? "未提供")}</p></details>
        <div className="space-y-2"><h5 className="text-sm font-medium">阶段门禁证据</h5>{!selected.evidence.length ? <p className="text-sm text-muted-foreground">尚无门禁证据；已观察到阶段不代表门禁通过。产物索引与正式交付物请在对应任务或条目交付流程查看。</p> : <div className="overflow-x-auto"><table className="w-full text-left text-sm"><caption className="sr-only">所选阶段上报的门禁脚本与结果</caption><thead><tr className="border-b border-border"><th className="p-2">检查脚本</th><th className="p-2">执行结果</th><th className="p-2">脚本指纹</th></tr></thead><tbody>{selected.evidence.map((item: unknown, i: number) => {const e = item && typeof item === "object" ? item as Record<string, unknown> : {};return <tr key={i} className="border-b border-border"><td className="break-all p-2 font-mono text-xs">{String(e.script ?? "未提供")}</td><td className="p-2">{e.exitCode === 0 ? "脚本执行通过" : typeof e.exitCode === "number" ? `未通过（${e.exitCode}）` : "未知"}</td><td className="break-all p-2 font-mono text-xs">{String(e.scriptSha256 ?? "未提供")}</td></tr>;})}</tbody></table></div>}</div>
        <details className="text-sm"><summary className="cursor-pointer">阶段事件历史（{selected.events.length}）</summary><ol className="mt-3 space-y-2">{selected.events.map(event => <li key={event.id}><p className="text-xs text-muted-foreground">{stamp(event.occurredAt)} · {phaseStates[String(event.payload.status)] ?? "阶段状态未知"}</p><pre className="max-h-64 overflow-auto whitespace-pre-wrap break-all rounded-md bg-muted p-3 text-xs">{JSON.stringify(event.payload, null, 2)}</pre></li>)}</ol></details>
      </section>
    </>}
    <details className="text-sm"><summary className="cursor-pointer">全部阶段与采集事件（{detail.phases.length}）</summary><pre className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap break-all rounded-md bg-muted p-3 text-xs">{JSON.stringify(detail.phases, null, 2)}</pre></details>
  </section>;
}
