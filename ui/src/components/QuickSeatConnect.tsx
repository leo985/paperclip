import { useState } from "react";
import { copyTextToClipboard } from "@/lib/clipboard";
import { dsp7SeatsApi } from "@/api/dsp7-seats";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
const shellQuote=(s:string)=>"'"+s.replace(/'/g,"'\\''")+"'";
const powershellQuote=(s:string)=>"'"+s.replace(/'/g,"''")+"'";
export function QuickSeatConnect({companyId}:{companyId:string}) {
 const [platform,setPlatform]=useState<"unix"|"windows">("unix");
 const [name,setName]=useState("我的研发电脑");const [command,setCommand]=useState("");const [expires,setExpires]=useState("");const [busy,setBusy]=useState(false);const [error,setError]=useState<string|null>(null);const [copied,setCopied]=useState(false);
 async function create(){setBusy(true);setError(null);setCommand("");try{const invite=await dsp7SeatsApi.quickInvite(companyId,{requestId:crypto.randomUUID(),name});const origin=window.location.origin;setCommand(platform==='windows' ? '$seatInstaller = Join-Path ([System.IO.Path]::GetTempPath()) ([guid]::NewGuid().ToString() + '+powershellQuote('.ps1')+'); try { Invoke-WebRequest -UseBasicParsing -Uri '+powershellQuote(origin+'/dsp7-install.ps1')+' -OutFile $seatInstaller; & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $seatInstaller -Server '+powershellQuote(origin)+' -Code '+powershellQuote(invite.invitationId+':'+invite.token)+' } finally { Remove-Item -LiteralPath $seatInstaller -ErrorAction SilentlyContinue }' : 'seat_installer=$(mktemp) && curl -fsS '+shellQuote(origin+'/dsp7-install.py')+' -o "$seat_installer" && python3 "$seat_installer" --server '+shellQuote(origin)+' --code '+shellQuote(invite.invitationId+':'+invite.token));setExpires(invite.expiresAt);setCopied(false);}catch(e){setError(e instanceof Error?e.message:"无法生成接入命令");}finally{setBusy(false);}}
 async function copy(){
  setError(null);
  setCopied(false);
  try {
    await copyTextToClipboard(command);
    setCopied(true);
  } catch {
    setError("复制失败，请选中上方命令，按 ⌘C（macOS）或 Ctrl+C（Windows／Linux）复制。");
  }
 }
 return <section className="space-y-4 rounded-lg border border-border p-4">
  <h2 className="text-lg font-medium">接入我的电脑</h2>
  <p className="text-sm text-muted-foreground">支持 macOS／Linux 与原生 Windows 接入。自动检测 Claude、Harness 和已有配置；确认接入后选择项目仓库。电脑主动连接网站，无需配置 SSH。</p>
  <label className="block text-sm">本机环境<select className="mt-1 block w-full rounded-md border border-input bg-background p-2 text-sm" disabled={busy} value={platform} onChange={e=>{setPlatform(e.target.value as "unix"|"windows");setCommand("");setCopied(false);setError(null);}}><option value="unix">macOS／Linux（终端）</option><option value="windows">Windows（原生 PowerShell）</option></select></label>
  {platform==="windows"&&<div className="space-y-2 rounded-md bg-muted p-3 text-sm">
   <p>需要 Windows 10 1809+／Windows 11、Python 3.10+（含 pip）、Git for Windows、已配置的 Claude Code 和 Harness 工程。不需要安装 WSL。</p>
   <p>复制命令到 PowerShell。安装器会补齐 pywinpty 终端依赖，复用 Windows 本机模型配置，并登记当前用户登录后启动的席位任务。</p>
   <p>安装后重新打开 PowerShell，使用 <code>harness</code>。网页启动请求会打开本机可见窗口；退出 Windows 登录、休眠或断网时席位会离线。首次接入后请检查心跳并验证模拟工单。</p>
  </div>}
  <label className="block text-sm">电脑席位名称<Input value={name} maxLength={100} onChange={e=>setName(e.target.value)}/></label>
  <ol className="list-decimal space-y-2 pl-5 text-sm"><li>执行环境内已安装 Claude Code、Python 3.9+、curl、Git，并准备好 Harness 工程。</li><li>生成接入命令，在本机终端执行（Windows 用 PowerShell）；检查检测到的路径并输入 yes。</li><li>选择项目与本机仓库，回到此页确认电脑在线。</li></ol>
  <p className="text-xs text-muted-foreground">智能体自动关联当前网站账号，模型／Jira 密钥保留本机。组织未授予创建权限或要求新智能体审批时，先由管理员按组织规则授权。已经接入的电脑会复用原席位。</p>
  {command&&<div className="space-y-2 rounded-md bg-muted p-3"><p className="text-xs">有效期至 {new Date(expires).toLocaleString()}；命令含一次性接入码，请勿转发。</p><pre className="overflow-x-auto whitespace-pre-wrap break-all text-xs"><code>{command}</code></pre><Button variant="outline" onClick={()=>void copy()}>{copied?"已复制":"复制接入命令"}</Button></div>}
  {error&&<p role="alert" className="text-sm text-destructive">{error}</p>}
  <div className="flex justify-end"><Button disabled={busy||!name.trim()} onClick={()=>void create()}>{busy?"正在生成…":command?"重新生成接入命令":"生成接入命令"}</Button></div>
  <p className="text-xs text-muted-foreground">以后关联其他项目，在执行环境内运行 <code>harness repo connect</code>，选择项目和目录即可。Windows／macOS 支持打开可见终端；Linux 自动打开终端需要图形桌面。</p>
 </section>;
}
