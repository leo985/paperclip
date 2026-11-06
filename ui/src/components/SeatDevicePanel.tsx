import { SeatClaudeLaunchSettings } from "./SeatClaudeLaunchSettings";
import type { RegisteredSeat } from "@/api/dsp7-seats";
import { Button } from "@/components/ui/button";
import { SeatClientUpgrade } from "./SeatClientUpgrade";
import { HarnessCapabilities } from "./HarnessCapabilities";

export function SeatDevicePanel({ companyId, seat, busy, active, onCheck, onRefresh }: {
  companyId: string; seat: RegisteredSeat; busy: boolean; active: boolean;
  onCheck: () => void; onRefresh: () => void;
}) {
  const checks = seat.presence?.checks ?? [];
  const concerns = checks.filter(c => c.status !== "pass");
  const passed = checks.filter(c => c.status === "pass");
  const autostart = checks.find(c => c.id === "autostart");
  return <div className="space-y-4" aria-label="设备诊断面板">
    <div className="flex flex-wrap items-center justify-between gap-3"><p className="text-sm text-muted-foreground">先查看状态；完整路径、更新步骤与检查说明可展开。</p><div className="flex flex-wrap gap-2"><Button type="button" disabled={busy || !seat.online || !seat.runtime} onClick={onCheck}>检查本机配置</Button><Button type="button" variant="outline" disabled={busy || !seat.online || !seat.runtime} onClick={onRefresh}>更新设备登记</Button></div></div>
    {!seat.online && <p className="rounded-md bg-muted p-3 text-sm">电脑离线，当前显示最后上报记录。在对应电脑执行 <code>harness online</code> 上线；未恢复时执行 <code>harness doctor</code>。</p>}
    <div className="grid gap-3 md:grid-cols-3">
      <div className="space-y-1 rounded-md bg-muted p-3"><p className="text-xs text-muted-foreground">设备连接</p><p className="text-sm font-medium">{seat.online ? "在线" : "离线"} · {seat.runtime ? "运行配置已登记" : "运行配置待登记"}</p></div>
      <div className="space-y-1 rounded-md bg-muted p-3"><p className="text-xs text-muted-foreground">登录后自动上线</p><p className="text-sm font-medium">{!autostart ? "尚未核验" : autostart.status === "pass" ? "检查通过" : "需要检查"}</p></div>
      <div className="space-y-1 rounded-md bg-muted p-3"><p className="text-xs text-muted-foreground">最近设备检查</p><p className="text-sm font-medium">{checks.length ? `${passed.length} 项通过 · ${concerns.length} 项需查看` : "尚无检查结果"}</p></div>
    </div>
    <SeatClientUpgrade companyId={companyId} seat={seat} />
    <SeatClaudeLaunchSettings companyId={companyId} seat={seat} />
    <HarnessCapabilities companyId={companyId} agentId={seat.agentId} canConfigure={seat.canConfigure} active={active} defaultRoot={seat.runtime?.harnessRoot} runtime={seat.runtime} />
    <details className="rounded-md border border-border p-3 text-sm"><summary className="cursor-pointer font-medium">Claude 与设备运行配置 · {seat.runtime?.claudeVersion ?? "待登记"}</summary><div className="mt-3 space-y-3"><dl className="grid gap-3 break-all md:grid-cols-2">
      <div><dt className="text-muted-foreground">执行环境</dt><dd>{seat.environmentName}</dd></div><div><dt className="text-muted-foreground">Claude 命令</dt><dd className="font-mono">{seat.runtime?.claudeCommand ?? "未登记"}</dd></div>
      <div><dt className="text-muted-foreground">Claude 配置来源</dt><dd className="font-mono">{seat.runtime?.claudeSettingsFile ?? "Claude 本机默认配置"}</dd></div><div><dt className="text-muted-foreground">默认研发 Harness 根目录</dt><dd className="font-mono">{seat.runtime?.harnessRoot ?? "未登记"}</dd></div>
      <div><dt className="text-muted-foreground">登记版本／检查时间</dt><dd>{seat.runtime?.revision ?? "无"} · {seat.runtime ? new Date(seat.runtime.checkedAt).toLocaleString() : "未检查"}</dd></div>
    </dl><p className="text-xs text-muted-foreground">修改 Claude 配置或运行路径后更新设备登记。启动任务仍会校验本机环境；在线只证明接入桥通信正常。</p><p>{seat.message}</p></div></details>
    <section className="space-y-3" aria-label="设备检查结果"><h3 className="font-medium">诊断结果 · {concerns.length} 项需查看</h3>{concerns.map(c => <div key={c.id} className="space-y-1 rounded-md border border-border p-3 text-sm"><p className={c.status === "fail" ? "font-medium text-destructive" : "font-medium"}>{c.status === "fail" ? "失败" : "提示"} · {c.label}</p><p className="text-muted-foreground">{c.message}</p></div>)}{!checks.length && <p className="text-sm text-muted-foreground">尚无检查结果，请在设备在线后检查本机配置。</p>}
      {!!passed.length && <details className="text-sm"><summary className="cursor-pointer text-muted-foreground">已通过 {passed.length} 项 · 展开查看</summary><div className="mt-3 space-y-3">{passed.map(c => <div key={c.id}><p>{c.label}</p><p className="text-muted-foreground">{c.message}</p></div>)}</div></details>}
    </section>
    <details className="text-sm"><summary className="cursor-pointer text-muted-foreground">自动上线与会话采集说明</summary><div className="mt-3 space-y-2"><p>{autostart?.message ?? "更新客户端后检查自动上线配置。"}</p><p>自动上线需要登录对应电脑用户；退出登录、休眠或断网可能离线。离线时的检查仅为历史记录。</p><p>{seat.presence?.capabilities?.includes("managed-session-v1") ? "支持受管会话采集，任务页展示已采集对话与阶段。" : "尚未上报受管会话采集能力，请更新客户端。"} 独立会话和更新前历史不保证补采，缺口会单独标注。</p></div></details>
  </div>;
}
