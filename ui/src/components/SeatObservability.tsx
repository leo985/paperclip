import { useState, type FormEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { seatWorkScheduleSchema, type SeatWorkSchedule, type SeatWorktime } from "@paperclipai/shared";
import { managedSessionsApi } from "@/api/managed-sessions";
import { duration } from "@/components/ManagedSessionPanel";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Link } from "@/lib/router";

const weekdays = ["周一", "周二", "周三", "周四", "周五", "周六", "周日"];
const gapDate = new Intl.DateTimeFormat("zh-CN", { timeZone: "Asia/Shanghai", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false });

function scheduleLabel(schedule: SeatWorkSchedule) {
  return `${schedule.days.map(day => weekdays[day - 1]).join("、")} ${schedule.periods.map(p => `${p.start}–${p.end}`).join("、")}（Asia/Shanghai）`;
}

function OnlineTime({ value }: { value: SeatWorktime }) {
  return <>
    {duration(value.onlineMs)}
    {value.onlineGaps.length > 0 && <details className="text-xs text-muted-foreground">
      <summary className="cursor-pointer">统计不完整</summary>
      <div className="space-y-1 whitespace-normal">
        <p>仅累计已收到心跳的连接时长，以下工作时段缺少记录，不推算为离线。</p>
        {value.onlineGaps.slice(0, 10).map(gap => <p key={gap.from}>{gapDate.format(new Date(gap.from))} 至 {gapDate.format(new Date(gap.to))}</p>)}
        {value.onlineGaps.length > 10 && <p>另有 {value.onlineGaps.length - 10} 段未覆盖时段。</p>}
      </div>
    </details>}
  </>;
}

function WorkScheduleSettings({ companyId, schedule }: { companyId: string; schedule: SeatWorkSchedule }) {
  const cache = useQueryClient();
  const [draft, setDraft] = useState<SeatWorkSchedule | null>(null);
  const [error, setError] = useState("");
  const [saved, setSaved] = useState(false);
  const value = draft ?? schedule;
  const save = useMutation({
    mutationFn: (next: SeatWorkSchedule) => managedSessionsApi.updateWorkSchedule(companyId, next),
    onSuccess: async () => {
      await cache.invalidateQueries({ queryKey: ["managed-seat-report", companyId] });
      setDraft(null);
      setSaved(true);
    },
    onError: (err: Error) => setError(err.message),
  });
  function change(next: SeatWorkSchedule) { setDraft(next); setError(""); setSaved(false); }
  function submit(event: FormEvent) {
    event.preventDefault();
    const parsed = seatWorkScheduleSchema.safeParse(value);
    if (!parsed.success) { setError(parsed.error.issues[0]?.message ?? "请检查工作日和时间段"); return; }
    setError(""); setSaved(false); save.mutate(parsed.data);
  }
  return <details className="text-sm">
    <summary className="cursor-pointer text-muted-foreground">工作时段设置</summary>
    <form className="mt-3 space-y-3" onSubmit={submit}>
      <p className="text-xs text-muted-foreground">应用于本组织所有席位，仅影响“工作时段在线”辅助统计；修改后历史查询也按新口径计算。时区为 Asia/Shanghai。</p>
      <fieldset disabled={save.isPending} className="space-y-3">
        <legend className="sr-only">工作日和工作时段</legend>
        <div className="flex flex-wrap gap-3">{weekdays.map((label, i) => <label key={label} className="flex items-center gap-2">
          <Checkbox checked={value.days.includes(i + 1)} onCheckedChange={checked => change({ ...value, days: checked === true ? [...value.days, i + 1].sort((a, b) => a - b) : value.days.filter(day => day !== i + 1) })} />{label}
        </label>)}</div>
        <div className="space-y-2">{value.periods.map((period, i) => <div key={i} className="flex flex-wrap items-center gap-2">
          <Input className="w-auto" aria-label={`时段 ${i + 1} 开始`} type="time" required value={period.start} onChange={e => change({ ...value, periods: value.periods.map((p, j) => j === i ? { ...p, start: e.target.value } : p) })} />
          <span>至</span>
          <Input className="w-auto" aria-label={`时段 ${i + 1} 结束`} type="time" required value={period.end} onChange={e => change({ ...value, periods: value.periods.map((p, j) => j === i ? { ...p, end: e.target.value } : p) })} />
          <Button type="button" variant="ghost" aria-label={`移除时段 ${i + 1}`} disabled={value.periods.length === 1} onClick={() => change({ ...value, periods: value.periods.filter((_, j) => j !== i) })}>移除</Button>
        </div>)}</div>
        <Button type="button" variant="outline" disabled={value.periods.length >= 4} onClick={() => change({ ...value, periods: [...value.periods, { start: "18:00", end: "19:00" }] })}>添加时段</Button>
      </fieldset>
      {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
      {saved && <p role="status" className="text-sm text-muted-foreground">工作时段已保存。</p>}
      <div className="flex items-center justify-between gap-3">
        <Button type="button" variant="ghost" disabled={save.isPending} onClick={() => { setDraft(null); setError(""); setSaved(false); }}>取消修改</Button>
        <Button type="submit" disabled={save.isPending}>{save.isPending ? "正在保存…" : "保存工作时段"}</Button>
      </div>
    </form>
  </details>;
}

export function SeatObservability({ companyId, onSelectSeat, active = true }: { companyId: string; onSelectSeat?: (seatId: string) => void; active?: boolean }) {
  const today = () => new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 10);
  const [period, setPeriod] = useState("week"), [date, setDate] = useState(today);
  const [dimension, setDimension] = useState("work"), [search, setSearch] = useState("");
  const report = useQuery({ queryKey: ["managed-seat-report", companyId, period, date], queryFn: () => managedSessionsApi.report(companyId, period, date), refetchInterval: active ? 30000 : false, enabled: active && /^\d{4}-\d{2}-\d{2}$/.test(date) });
  const data = report.data;
  const rows = data?.seats.filter(s => `${s.name} ${s.ownerName ?? "未指定"}`.toLowerCase().includes(search.toLowerCase())) ?? [];
  const onlineHint = data ? `${scheduleLabel(data.workSchedule)}；只累计截至当前、有效心跳覆盖的连接时长，心跳有效期 90 秒；不代表人员工时。` : "";
  function shift(direction: number) {
    const value = new Date(`${date}T00:00:00Z`);
    if (!Number.isFinite(value.getTime())) return;
    if (period === "day" || period === "week") value.setUTCDate(value.getUTCDate() + direction * (period === "week" ? 7 : 1));
    else if (period === "year") value.setUTCFullYear(value.getUTCFullYear() + direction, 0, 1);
    else value.setUTCMonth(value.getUTCMonth() + direction * (period === "quarter" ? 3 : 1), 1);
    setDate(value.toISOString().slice(0, 10));
  }
  const headers = dimension === "work" ? ["期末 Jira 在手", "期末平台在手", "首次开始", "首次交付", "取消"] : dimension === "time" ? ["Agent 执行", "等待人工", "在线空闲", "未知时间", "时间覆盖率", "工作时段在线"] : ["关联缺陷数", "关联缺陷发生率", "完整观测 / 全部成熟工单", "成熟样本覆盖率"];
  return <section className="space-y-4 rounded-lg border border-border p-4">
    <header className="space-y-1"><h2 className="font-semibold">席位工单与时间统计</h2><p className="text-sm text-muted-foreground">管理员查看本组织，负责人查看自己的席位。点击席位名称可返回运行工作台。</p><Link className="text-sm underline" to={`/delivery-workbench?view=reports&period=${period}&date=${date}`}>按项目、领域与负责人查看交付报表</Link></header>
    <div className="flex flex-wrap items-center gap-3">
      <label className="flex items-center gap-2 text-sm">统计周期<select aria-label="统计周期" value={period} onChange={e => setPeriod(e.target.value)} className="rounded-md border border-border bg-background p-2 text-sm">{[["day", "日"], ["week", "周"], ["month", "月"], ["quarter", "季度"], ["year", "年"]].map(([v, label]) => <option key={v} value={v}>{label}</option>)}</select></label>
      <Button variant="outline" onClick={() => shift(-1)} disabled={!date}>上一周期</Button><Input aria-label="统计日期" type="date" value={date} onChange={e => setDate(e.target.value)} className="w-auto" /><Button variant="outline" onClick={() => shift(1)} disabled={!date}>下一周期</Button><Button variant="ghost" onClick={() => setDate(today())}>回到本期</Button>
    </div>
    <div className="flex flex-wrap items-center justify-between gap-3"><div className="flex flex-wrap gap-2" role="group" aria-label="统计维度">{[["work","工单与交付"],["time","工作与等待"],["quality","缺陷与质量"]].map(([value,label])=><Button key={value} variant={dimension===value?"secondary":"ghost"} aria-pressed={dimension===value} onClick={()=>setDimension(value)}>{label}</Button>)}</div><Input aria-label="搜索统计席位或负责人" placeholder="搜索席位或负责人" className="w-full md:w-64" value={search} onChange={e=>setSearch(e.target.value)}/></div>
    {report.isLoading && <p role="status" className="text-sm">正在汇总…</p>}
    {!date && <p className="text-sm text-muted-foreground">请选择统计日期。</p>}
    {report.error && <div role="alert" className="space-y-2 text-sm"><p className="text-destructive">统计加载失败：{report.error.message}</p><Button variant="outline" onClick={()=>void report.refetch()}>重新加载</Button></div>}
    {data && <>
      <p className="text-xs text-muted-foreground">{new Date(data.from).toLocaleDateString("zh-CN", { timeZone: data.timezone })} 至 {new Date(Date.parse(data.to) - 1).toLocaleDateString("zh-CN", { timeZone: data.timezone })} · Asia/Shanghai · 周一开周 · 每 30 秒更新</p>
      <p className="rounded-md bg-muted p-3 text-sm">{dimension==="work"?"在手数为期末快照，开始与交付为本期首次业务事件。未采集的数据以“暂无快照”显示。":dimension==="time"?"执行、等待人工、在线空闲分别统计；离线或缺少证据计入未知，不推算为闲置。这些是 Agent 时间，不代表人员工时。":"关联缺陷发生率 = 出现关联缺陷的成熟工单数 ÷ 有完整14天观测的成熟工单数；覆盖率 = 完整观测成熟工单数 ÷ 全部成熟工单数。仅统计交付后14天内 Jira 显式关联缺陷，尚不代表已确认归因的编码 Bug 率。"}</p>
      <div className="overflow-x-auto"><table className="w-full text-left text-sm"><caption className="sr-only">按席位统计的{dimension==="work"?"工单与交付":dimension==="time"?"执行与等待时间":"缺陷与质量"}</caption>
        <thead><tr className="border-b border-border"><th scope="col" className="whitespace-nowrap p-2 font-medium">席位 / 负责人</th>{headers.map(label => <th key={label} scope="col" title={label === "工作时段在线" ? onlineHint : undefined} className="whitespace-nowrap p-2 font-medium">{label}</th>)}</tr></thead>
        <tbody>{rows.map(s => <tr key={s.seatId + ":" + s.ownerUserId} className="border-b border-border">
          <th scope="row" className="p-2 font-normal">{onSelectSeat?<button type="button" className="text-left font-medium underline focus-visible:outline-primary" onClick={()=>onSelectSeat(s.seatId)}>{s.name}</button>:s.name}<p className="text-xs text-muted-foreground">{s.ownerName ?? "未指定"}</p></th>
          {dimension==="work"&&<><td className="p-2 font-mono">{s.jiraBacklog ?? "暂无快照"}</td><td className="p-2 font-mono">{s.backlog ?? "暂无快照"}</td><td className="p-2 font-mono">{s.started}</td><td className="p-2 font-mono">{s.delivered}</td><td className="p-2 font-mono">{s.cancelled}</td></>}
          {dimension==="time"&&<><td className="whitespace-nowrap p-2">{duration(s.executingMs)}</td><td className="whitespace-nowrap p-2">{duration(s.waitingMs)}</td><td className="whitespace-nowrap p-2">{duration(s.idleMs)}</td><td className="whitespace-nowrap p-2">{duration(s.unknownMs)}</td><td className="p-2 font-mono">{(s.coverage*100).toFixed(0)}%</td><td className="whitespace-nowrap p-2 text-muted-foreground" title={onlineHint}><OnlineTime value={s} /></td></>}
          {dimension==="quality"&&<><td className="p-2 font-mono">{s.defects===null?"无关联数据":s.defects}</td><td className="p-2 font-mono">{s.defectRate===null?"暂无成熟样本":`${(s.defectRate*100).toFixed(1)}%`}</td><td className="p-2 font-mono">{s.matureDeliveries} / {s.matureEligible??"未知"}{s.affectedMature!==undefined&&<p className="text-xs text-muted-foreground">发生率分子 {s.affectedMature}</p>}</td><td className="p-2 font-mono">{s.matureEligible===0?"暂无成熟工单":`${(s.qualityCoverage*100).toFixed(0)}%`}</td></>}
        </tr>)}</tbody>
      </table></div>
      {!rows.length&&<p className="text-sm text-muted-foreground">{data.seats.length?"没有匹配的席位或负责人，请调整搜索。":"本期暂无你可查看的席位统计。"}</p>}
      {dimension==="time"&&<details className="text-sm"><summary className="cursor-pointer">人员时间汇总（同一人的多电脑并行取时间并集）</summary><div className="mt-3 space-y-3">{data.people.filter(p=>!search||p.name.toLowerCase().includes(search.toLowerCase())||rows.some(s=>s.ownerUserId===p.ownerUserId)).map(p => <div key={p.ownerUserId}>
        <p>{p.name} · 执行 {duration(p.executingMs)} · 等待人工 {duration(p.waitingMs)} · 在线空闲 {duration(p.idleMs)} · 未知 {duration(p.unknownMs)}</p><div className="text-xs text-muted-foreground">工作时段在线 <OnlineTime value={p} /></div>
      </div>)}</div></details>}
      <details className="text-sm text-muted-foreground"><summary className="cursor-pointer">查看统计口径与数据完整性说明</summary><p className="mt-3">{data.note}</p></details>
      {data.canConfigureWorkSchedule && <WorkScheduleSettings key={companyId} companyId={companyId} schedule={data.workSchedule} />}
    </>}
  </section>;
}
