import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import type { RegisteredSeat } from "@/api/dsp7-seats";
import { copyTextToClipboard } from "@/lib/clipboard";
import { Button } from "@/components/ui/button";
import { dsp7SeatsApi } from "@/api/dsp7-seats";
import { useManagementAccess } from "@/hooks/useManagementAccess";

const quote = (value: string) => "'" + value.replace(/'/g, "'\\''") + "'";
const psQuote = (value: string) => "'" + value.replace(/'/g, "''") + "'";

type SeatPlatform = "unix" | "windows";

function rememberedPlatform(key: string): SeatPlatform | null {
  try {
    const value = localStorage.getItem(key);
    return value === "unix" || value === "windows" ? value : null;
  } catch { return null; }
}

function registeredPlatform(seat: RegisteredSeat): SeatPlatform {
  // Use the target seat's paths, never the operator's browser OS or seat name.
  const paths = [seat.runtime?.harnessRoot, seat.runtime?.claudeCommand, seat.runtime?.claudeSettingsFile];
  return paths.some(path => path && /^(?:[a-z]:[\\/]|\\\\)/i.test(path)) ? "windows" : "unix";
}

export function SeatClientUpgrade({ companyId, seat, active = true }: { companyId: string; seat: RegisteredSeat; active?: boolean }) {
  const { canManage } = useManagementAccess();
  const [requestBusy, setRequestBusy] = useState(false);
  const [requestError, setRequestError] = useState("");
  const upgrade = useQuery({ queryKey: ["seat-client-upgrade", companyId, seat.agentId], queryFn: () => dsp7SeatsApi.upgradeStatus(companyId, seat.agentId), enabled: active && seat.canConfigure, refetchInterval: active ? 5000 : false });
  const platformKey = `paperclip:seat-upgrade-platform:${companyId}:${seat.agentId}`;
  const [platformChoices, setPlatformChoices] = useState<Record<string, SeatPlatform>>({});
  const [platformSaveError, setPlatformSaveError] = useState<string | null>(null);
  const platform = platformChoices[platformKey] ?? rememberedPlatform(platformKey) ?? registeredPlatform(seat);
  function selectPlatform(value: string) {
    if (value !== "unix" && value !== "windows") return;
    setPlatformChoices(previous => ({ ...previous, [platformKey]: value }));
    setCopyStatus("");
    try {
      localStorage.setItem(platformKey, value);
      setPlatformSaveError(null);
    } catch { setPlatformSaveError(platformKey); }
  }
  const [expanded, setExpanded] = useState(false);
  const [copyStatus, setCopyStatus] = useState("");
  const manifest = useQuery({
    queryKey: ["dsp7-bridge-release"],
    queryFn: async () => {
      const response = await fetch("/dsp7-bridge-manifest.json", { cache: "no-store" });
      if (!response.ok) throw new Error("无法读取最新客户端版本");
      const value: unknown = await response.json();
      if (!value || typeof value !== "object" || !("sha256" in value) || typeof value.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(value.sha256)) throw new Error("客户端版本信息无效");
      return value.sha256;
    },
    enabled: active,
    refetchInterval: active ? 60000 : false,
  });
  const legacy = seat.executionTransport === "ssh";
  const migrating = ["prepared", "rolled_back"].includes(seat.migrationState ?? "");
  const current = seat.presence?.bridgeVersion;
  const remoteSupported = seat.presence?.capabilities?.includes("seat-admin-upgrade-v1");
  const pendingUpgrade = upgrade.data && ["queued", "claimed", "verifying"].includes(upgrade.data.status);
  const status = !manifest.data ? "正在读取最新版本" : !current ? "版本未知，建议更新" : current === manifest.data ? "已是最新版本" : "有可用更新";
  const origin = window.location.origin;
  const command = platform === "windows"
    ? "$seatInstaller = Join-Path ([IO.Path]::GetTempPath()) ([guid]::NewGuid().ToString() + '.ps1'); try { Invoke-WebRequest -UseBasicParsing -Uri " + psQuote(origin + "/dsp7-install.ps1") + " -OutFile $seatInstaller; & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $seatInstaller -Server " + psQuote(origin) + " -Upgrade -AgentId " + psQuote(seat.agentId) + " } finally { Remove-Item -LiteralPath $seatInstaller -ErrorAction SilentlyContinue }"
    : "(seat_installer=$(mktemp) && trap 'rm -f \"$seat_installer\"' EXIT && curl -fsS " + quote(origin + "/dsp7-install.py") + ' -o "$seat_installer" && python3 "$seat_installer" --server ' + quote(origin) + " --upgrade --agent-id " + quote(seat.agentId) + ")";
  async function copy() {
    try { await copyTextToClipboard(command); setCopyStatus("更新命令已复制，请在对应电脑的终端执行。"); }
    catch { setCopyStatus("浏览器不允许自动复制，请选中下方命令，按 ⌘C 或 Ctrl+C 手动复制。"); }
  }
  async function requestUpgrade(cancel = false) {
    if (!manifest.data) return;
    setRequestBusy(true); setRequestError("");
    try {
      if (cancel && upgrade.data) await dsp7SeatsApi.cancelUpgrade(companyId, seat.agentId, upgrade.data.requestId, upgrade.data.targetSha256);
      else await dsp7SeatsApi.requestUpgrade(companyId, seat.agentId, manifest.data);
      await upgrade.refetch();
    } catch (error) { setRequestError(error instanceof Error ? error.message : "升级请求未完成，请重试"); }
    finally { setRequestBusy(false); }
  }
  return <section className="space-y-3 rounded-md border border-border p-3">
    <div className="flex flex-wrap items-center justify-between gap-3"><h3 className="font-medium">本机接入桥 · {manifest.error ? "版本读取失败" : status}</h3>{seat.canConfigure && <Button variant="outline" onClick={() => setExpanded(!expanded)} aria-expanded={expanded}>{expanded ? "收起更新步骤" : legacy ? "迁移并更新客户端" : "更新客户端"}</Button>}</div>
    {canManage && <div className="space-y-2 text-sm">
      <div className="flex flex-wrap items-center justify-between gap-3"><p>由管理员逐席位下发升级；发布新版本不会自动升级。</p><Button disabled={requestBusy || !remoteSupported || !manifest.data || current === manifest.data || !!pendingUpgrade} onClick={() => void requestUpgrade()}>{requestBusy ? "正在提交…" : "下发客户端升级"}</Button></div>
      <p className="text-xs text-muted-foreground">当前 {current?.slice(0, 16) ?? "未知"} → 目标 {manifest.data?.slice(0, 16) ?? "读取中"}。无需电脑端再次确认；有活动任务时等待空闲，离线时等待恢复连接。</p>
      {!remoteSupported && <p className="text-xs text-muted-foreground">此客户端尚不支持网页升级，请先在原电脑按下方步骤更新一次。</p>}
    </div>}
    {upgrade.data && <div role="status" className="flex flex-wrap items-center justify-between gap-3 text-sm"><p>{upgrade.data.message}</p>{canManage && upgrade.data.status === "queued" && <Button variant="ghost" disabled={requestBusy} onClick={() => void requestUpgrade(true)}>取消升级请求</Button>}</div>}
    {(requestError || upgrade.error) && <p role="alert" className="text-sm text-destructive">{requestError || upgrade.error?.message}</p>}
    <details className="text-sm"><summary className="cursor-pointer text-muted-foreground">版本与启动方式详情</summary><div className="mt-3 space-y-3">
    <div className="space-y-1 rounded-md bg-muted p-3 text-sm"><p className="font-medium">正式任务启动方式</p>{seat.presence?.capabilities?.includes("harness-root-launch-v1") ? <><p>客户端支持从登记的 Harness 根目录启动新会话，原生加载该工程的规则、技能及 MCP；业务源码遵守本机 Harness 的仓库与工作树规则。</p><p className="text-xs text-muted-foreground">{seat.presence.checks.find(check => check.id === "harness_launch")?.message ?? "等待本机上报启动环境检查结果；能力上报不代表已通过检查。"}</p></> : seat.presence?.capabilities?.includes("harness-source-launch-compat-v1") ? <p>本机显式使用旧源码目录兼容模式。现有登记不变，新会话暂未切换为 Harness 根目录启动。</p> : <p>尚未收到新版启动能力上报。旧客户端可继续使用；更新接入桥后，新正式会话才采用 Harness 根目录启动。已有运行不会切换目录。</p>}{!seat.online && <p className="text-xs text-muted-foreground">电脑离线，以上仅为最后上报状态。</p>}</div>
    <dl className="grid gap-3 text-sm md:grid-cols-2"><div><dt className="text-muted-foreground">本机版本（最近心跳）</dt><dd>{current?.slice(0, 16) ?? "旧版未上报版本"}{!seat.online && " · 电脑离线，需上线确认"}</dd></div><div><dt className="text-muted-foreground">网站当前版本</dt><dd>{manifest.data?.slice(0, 16) ?? "尚未获取"}</dd></div></dl>
    </div></details>
    {manifest.error && <p role="alert" className="text-sm text-destructive">{manifest.error.message}。<Button variant="ghost" onClick={() => void manifest.refetch()}>重试</Button></p>}
    {migrating && <p role="status" className="text-sm text-muted-foreground">席位迁移尚未结束，服务端保持暂停派工。请在原电脑重新执行下方更新命令恢复；不要删除配置或重新注册。</p>}
    {expanded && seat.canConfigure && <div className="space-y-3">
      <p className="text-sm text-muted-foreground">在“{seat.name}”对应的电脑、原注册用户下执行，无需新接入码。保留席位身份、仓库、Jira 及模型配置；有执行中或等待响应的会话时会拒绝更新，请处理结束后重试。</p>
      {legacy && <p className="text-sm text-muted-foreground">当前为旧 SSH 接入。此命令会同时将原席位迁移为本机主动连接，无需重新注册；切换期间暂停派工，保留原负责人和历史工单。</p>}
      <label className="block text-sm">这台电脑的系统<select className="mt-1 block w-full rounded-md border border-input bg-background p-2 text-sm" value={platform} onChange={event => selectPlatform(event.target.value)}><option value="unix">macOS／Linux（终端）</option><option value="windows">Windows（PowerShell）</option></select></label>
      {platformSaveError === platformKey && <p role="alert" className="text-sm text-destructive">当前浏览器无法保存系统选择，下次打开时请重新确认。</p>}
      <Button variant="outline" disabled={!manifest.data} onClick={() => void copy()}>复制更新命令</Button>
      {copyStatus && <p role="status" className="text-sm">{copyStatus}</p>}
      <pre className="overflow-x-auto whitespace-pre-wrap break-all rounded-md bg-muted p-3 text-xs"><code>{command}</code></pre>
      <ol className="list-decimal space-y-2 pl-5 text-sm"><li>等待当前任务及 Claude 会话结束，再执行命令。</li><li>更新器校验下载包，备份配置，切换后台服务；失败时恢复原配置。</li><li>回到本页等待心跳，确认版本一致，并在“诊断结果”核对正式任务启动方式检查通过，再启动新工单。若未恢复在线，请查看终端提示。</li></ol>
      <p className="text-xs text-muted-foreground">本操作更新接入桥，首次更新后可用 harness online 上线、harness doctor 诊断、harness upgrade 更新。Harness 框架仍通过 Git 更新；独立会话和更新前的历史记录不会自动补采。旧 SSH 席位会在本次更新中同步迁移为主动连接模式。网络中断后可重试同一命令恢复。</p>
    </div>}
  </section>;
}
