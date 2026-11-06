import { useState } from "react";
import { Button } from "@/components/ui/button";
import { copyTextToClipboard } from "@/lib/clipboard";

type Kind = "analysis" | "development" | "qa";
export function HarnessEnrollmentGuide({ agentId, seats, defaultKind = "analysis", fixedKind }: {
  agentId?: string;
  seats?: { id: string; name: string }[];
  defaultKind?: Kind;
  fixedKind?: Kind;
}) {
  const [selectedKind, setKind] = useState<Kind>(defaultKind);
  const kind = fixedKind ?? selectedKind;
  const [selectedSeat, setSelectedSeat] = useState("");
  const [command, setCommand] = useState("");
  const [copyStatus, setCopyStatus] = useState("");
  const target = agentId ?? selectedSeat;
  function reset() { setCommand(""); setCopyStatus(""); }
  function generate() {
    if (!target || !/^[a-f0-9-]{36}$/i.test(target)) return;
    setCommand(`harness capability register --kind ${kind}${kind === "analysis" ? " --profile dsp" : ""} --choose --seat-id ${target}`);
    setCopyStatus("");
  }
  async function copy() {
    try { await copyTextToClipboard(command); setCopyStatus("命令已复制，请在所选席位对应电脑的终端执行。"); }
    catch { setCopyStatus("浏览器不允许自动复制，请选中下方命令，按 ⌘C 或 Ctrl+C 复制。"); }
  }
  return <section className="space-y-3 rounded-md border border-border p-3" aria-label="Harness 目录接入向导">
    <h3 className="font-medium">选择本机 Harness 目录</h3>
    <p className="text-sm text-muted-foreground">先更新客户端，再生成免填路径命令。在对应电脑执行后弹出系统文件夹选择框，选择 Harness Git 根目录，校验通过后保存到该席位。</p>
    <div className="flex flex-wrap items-end gap-3">
      {!agentId && <label className="space-y-2 text-sm"><span className="block">配置哪台电脑</span><select aria-label="登记 Harness 的席位" className="rounded-md border border-border bg-background p-2" value={selectedSeat} onChange={e => { setSelectedSeat(e.target.value); reset(); }}><option value="">选择要配置的席位</option>{seats?.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}</select></label>}
      {!fixedKind && <label className="space-y-2 text-sm"><span className="block">套件用途</span><select aria-label="Harness 套件用途" className="rounded-md border border-border bg-background p-2" value={kind} onChange={e => { setKind(e.target.value as Kind); reset(); }}><option value="analysis">需求分析 Harness（DSP）</option><option value="development">研发 Harness（设计、编码、评审）</option><option value="qa">测试 Harness（用例、功能测试）</option></select></label>}
      <Button type="button" variant="outline" disabled={!target} onClick={generate}>生成选目录命令</Button>
    </div>
    {command && <div className="space-y-3"><ol className="list-decimal space-y-2 pl-5 text-sm"><li>在这台席位电脑更新客户端，随后执行下方命令。Windows、macOS、Linux 使用同一条命令。</li><li>在系统弹框中选择对应 Harness 的 Git 根目录（包含 CLAUDE.md 和相关技能）。取消选择不修改登记。</li><li>校验成功后自动保存登记；刷新网页即可选择。选错套件或席位有运行中任务时会提示原因，不会切换现有运行。</li></ol><label className="block space-y-2 text-sm">在对应电脑执行<textarea aria-label="Harness 选目录命令" readOnly rows={3} value={command} className="block w-full rounded-md border border-border bg-muted p-3 font-mono text-sm" onFocus={e => e.currentTarget.select()} /></label><Button type="button" variant="outline" onClick={() => void copy()}>复制命令</Button>{copyStatus && <p role="status" className="text-sm">{copyStatus}</p>}</div>}
    <p className="text-xs text-muted-foreground">同一席位可登记多类套件，无须全部配置；承接需求分析才登记分析套件，承接测试才登记测试套件。测试能力登记不代表 QA 自动执行通道已开放。无图形桌面的 Linux 可使用原有 --path 命令。</p>
  </section>;
}
