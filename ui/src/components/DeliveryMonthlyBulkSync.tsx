import { useEffect, useRef, useState } from "react";
import { ApiError } from "@/api/client";
import { Button } from "@/components/ui/button";

type Receipt = { ok: boolean; message: string; existing?: boolean };
export function DeliveryMonthlyBulkSync({ month, disabled, readMonth, syncEntry, onBusyChange, scopeLabel }: {
  month: string; disabled: boolean; scopeLabel?: string;
  readMonth: () => Promise<string[]>;
  syncEntry: (demandNo: string) => Promise<{ existing?: boolean }>;
  onBusyChange: (busy: boolean) => void;
}) {
  const [status, setStatus] = useState<"idle"|"reading"|"running"|"done"|"stopped"|"error">("idle");
  const [keys, setKeys] = useState<string[]>([]);
  const [receipts, setReceipts] = useState<Record<string, Receipt>>({});
  const [current, setCurrent] = useState("");
  const [error, setError] = useState("");
  const [stopRequested, setStopRequested] = useState(false);
  const lock = useRef(false), stop = useRef(false), alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => { alive.current = false; stop.current = true; onBusyChange(false); };
  }, []); // A month/source change remounts this component and stops unsent work.
  const running = status === "reading" || status === "running";
  const completed = keys.filter(key => receipts[key]).length;
  const success = keys.filter(key => receipts[key]?.ok).length;
  const failed = completed - success;
  const added = keys.filter(key => receipts[key]?.ok && receipts[key]?.existing === false).length;
  const unchanged = keys.filter(key => receipts[key]?.ok && receipts[key]?.existing === true).length;
  const remaining = keys.filter(key => !receipts[key]?.ok);

  async function run(retry?: string[]) {
    if (lock.current || disabled) return;
    lock.current = true; stop.current = false; setStopRequested(false);
    onBusyChange(true); setError("");
    // Freeze the source context for this run; source changes are rejected by the API.
    const execute = syncEntry;
    try {
      let queue: string[];
      if (retry) queue = retry;
      else {
        setStatus("reading"); setReceipts({}); setKeys([]); setCurrent("");
        queue = [...new Set(await readMonth())];
        if (!alive.current) return;
        setKeys(queue);
      }
      if (!alive.current) return;
      setStatus("running");
      for (const key of queue) {
        if (stop.current || !alive.current) break;
        setCurrent(key);
        try {
          const result = await execute(key);
          if (alive.current) setReceipts(previous => ({...previous,[key]:{ok:true,existing:result.existing,message:result.existing?"来源无变化，保留已有版本":"已同步最新来源版本"}}));
        } catch (cause) {
          if (alive.current) setReceipts(previous => ({...previous,[key]:{ok:false,message:cause instanceof Error?cause.message:"同步失败"}}));
          // Re-authentication/source revision errors affect the whole queue.
          if (cause instanceof ApiError && [401,403,409].includes(cause.status)) {
            stop.current = true;
            if (alive.current) setError("账号权限或来源配置已变化，已停止后续同步，请核对配置并刷新页面后重试。");
          }
        }
      }
      if (alive.current) { setCurrent(""); setStatus(stop.current?"stopped":"done"); }
    } catch (cause) {
      if (alive.current) { setError(cause instanceof Error?cause.message:"读取本月条目失败"); setStatus("error"); }
    } finally {
      lock.current = false;
      if (alive.current) onBusyChange(false);
    }
  }
  return <section className="space-y-3" aria-label="同步本月全部条目">
    <div className="flex flex-wrap items-center gap-3"><Button type="button" disabled={disabled||running} onClick={()=>void run()}>{status==="reading"?"正在读取本月完整清单…":running?"正在同步本月全部…":"一键同步本月全部条目"}</Button><span className="text-xs text-muted-foreground">重新读取 {month} 的{scopeLabel??"完整条目"}清单，逐条更新其 Jira 主单、子单及来源快照；包含已纳管条目，不受搜索、筛选、分页或勾选 20 条限制。不派单。</span></div>
    {status!=="idle"&&<div className="space-y-3 rounded-lg border border-border p-4" aria-label="本月全部同步进度">
      <p role="status" className="text-sm">{status==="reading"?"正在读取本月完整清单，尚未开始同步。":`${month} · ${status==="running"?"同步中":status==="stopped"?"已停止后续同步":status==="error"?"未能开始同步":"本轮同步结束"} · 已处理 ${completed}/${keys.length} · 成功 ${success} · 失败 ${failed} · 未处理 ${keys.length-completed}`}{current?` · 正在处理 ${current}`:""}</p>
      {completed>0&&<p className="text-sm">新增来源版本 {added} · 来源未变化 {unchanged}。新增来源版本包含首次导入和已有条目的来源更新。</p>}
      {keys.length>0&&<progress aria-label="本月同步进度" value={completed} max={keys.length} className="w-full"/>}
      {error&&<p role="alert" className="text-sm text-destructive">{error}</p>}
      {status==="done"&&!keys.length&&<p className="text-sm">本月没有条目，无需同步。</p>}
      <div className="flex flex-wrap items-center gap-3">{running&&<Button variant="outline" type="button" disabled={stopRequested} onClick={()=>{stop.current=true;setStopRequested(true);}}>停止后续同步</Button>}{!running&&remaining.length>0&&<Button variant="outline" type="button" disabled={disabled||!!error} onClick={()=>void run(remaining)}>重试失败及未完成（{remaining.length}）</Button>}{stopRequested&&running&&<span className="text-sm">等待当前请求结束后停止，已同步结果保留。</span>}</div>
      <p className="text-xs text-muted-foreground">同步期间请保持本页面打开；离开页面将停止后续请求，已保存结果不会撤销。逐条执行以减少来源压力；单条失败不影响其他条目。</p>
      {completed>0&&<details><summary className="cursor-pointer text-sm">查看逐条结果（{completed}）</summary><div className="mt-3 max-h-64 space-y-2 overflow-y-auto">{keys.filter(key=>receipts[key]).map(key=><p key={key} className={receipts[key]!.ok?"text-sm":"text-sm text-destructive"}>{key} · {receipts[key]!.ok?"成功":"失败"} · {receipts[key]!.message}</p>)}</div></details>}
    </div>}
  </section>;
}
