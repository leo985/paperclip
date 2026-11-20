import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { DeliveryMonthlySyncSchedule } from "@paperclipai/shared";
import { api } from "@/api/client";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";

const formatDate = new Intl.DateTimeFormat("zh-CN", {
  timeZone: "Asia/Shanghai", dateStyle: "medium", timeStyle: "short",
});
const labels = {
  running: "同步中", succeeded: "已完成", partial: "部分成功", failed: "失败", interrupted: "已中断",
};

export function DeliveryMonthlySchedule({ companyId, projectId }: { companyId: string; projectId: string }) {
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<{ enabled: boolean; time: string } | null>(null);
  const path = `/companies/${companyId}/delivery-connections/monthly-schedule`;
  const key = ["delivery-monthly-schedule", companyId, projectId];
  const schedule = useQuery({
    queryKey: key,
    queryFn: () => api.get<DeliveryMonthlySyncSchedule>(`${path}?${new URLSearchParams({ projectId })}`),
    enabled: open,
    refetchInterval: query => query.state.data?.lastRun?.status === "running" ? 5_000 : 30_000,
    retry: false,
  });
  const save = useMutation({
    mutationFn: (settings: { enabled: boolean; time: string }) => api.put<DeliveryMonthlySyncSchedule>(path, { projectId, ...settings }),
    onSuccess(data) {
      queryClient.setQueryData(key, data);
      setDraft(null);
    },
  });
  const settings = draft ?? schedule.data ?? { enabled: false, time: "06:00" };
  const lastRun = schedule.data?.lastRun;
  const nextRun = schedule.data?.nextRunAt;
  function edit(change: Partial<typeof settings>) {
    save.reset();
    setDraft({ enabled: settings.enabled, time: settings.time, ...change });
  }

  return <Popover open={open} onOpenChange={setOpen}>
    <PopoverTrigger asChild>
      <Button type="button" size="sm" variant="outline">定时同步</Button>
    </PopoverTrigger>
    <PopoverContent align="end" className="space-y-3" aria-label="定时同步">
      <div className="space-y-1">
        <h3 className="text-sm font-semibold">定时同步</h3>
        <p className="text-xs text-muted-foreground">每天按北京时间同步运行时所在月份的全部条目。关闭网页后仍会运行，只更新来源快照。</p>
      </div>
      {schedule.isPending && <p role="status" className="text-sm text-muted-foreground">正在读取设置…</p>}
      {schedule.isError && <div role="alert" className="flex flex-wrap items-center gap-2 text-sm text-destructive">
        {schedule.error.message}<Button variant="outline" size="sm" onClick={() => void schedule.refetch()}>重试</Button>
      </div>}
      {schedule.data && <form className="space-y-3" onSubmit={event => {
        event.preventDefault();
        save.mutate({ enabled: settings.enabled, time: settings.time });
      }}>
        <div className="flex flex-wrap items-center gap-4">
          <label className="flex items-center gap-2 text-sm">
            <Checkbox checked={settings.enabled} disabled={save.isPending} onCheckedChange={value => edit({ enabled: value === true })} />
            每天自动同步
          </label>
          <label className="flex items-center gap-2 text-sm">
            同步时间
            <Input type="time" className="w-auto" required value={settings.time} disabled={save.isPending} onChange={event => edit({ time: event.target.value })} />
          </label>
        </div>
        <p className="text-sm text-muted-foreground">{nextRun ? `下次运行 ${formatDate.format(new Date(nextRun))}` : "当前未开启定时同步"}</p>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <Button type="button" size="sm" variant="ghost" disabled={!draft || save.isPending} onClick={() => { setDraft(null); save.reset(); }}>取消修改</Button>
          <Button type="submit" size="sm" disabled={!draft || !settings.time || save.isPending}>{save.isPending ? "正在保存…" : "保存定时设置"}</Button>
        </div>
        {save.isError && <p role="alert" className="text-sm text-destructive">{save.error.message}</p>}
        {save.isSuccess && <p role="status" className="text-sm text-muted-foreground">定时设置已保存。</p>}
      </form>}
      {lastRun && <div className="space-y-1 border-t border-border pt-3 text-sm" aria-label="最近一次定时同步">
        <p><span className="font-medium">{labels[lastRun.status]}</span> · {lastRun.month} · {formatDate.format(new Date(lastRun.startedAt))}</p>
        {lastRun.total !== null && <p className="text-muted-foreground">
          已处理 {lastRun.succeeded + lastRun.failed}/{lastRun.total} · 成功 {lastRun.succeeded} · 失败 {lastRun.failed}
        </p>}
        {lastRun.message && <p className="text-muted-foreground">{lastRun.message}</p>}
      </div>}
    </PopoverContent>
  </Popover>;
}
