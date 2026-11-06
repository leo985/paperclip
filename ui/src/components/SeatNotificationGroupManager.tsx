import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { SeatNotificationGroup } from "@paperclipai/shared";
import { dsp7SeatsApi } from "@/api/dsp7-seats";
import { Input } from "./ui/input";
import { Button } from "./ui/button";

const blank = { name: "", botId: "", enabled: true, webhookUrl: "", signingSecret: "" };
export function SeatNotificationGroupManager({ companyId }: { companyId: string }) {
  const cache = useQueryClient();
  const groups = useQuery({ queryKey: ["dsp7-notification-groups", companyId], queryFn: () => dsp7SeatsApi.groups(companyId) });
  const bots = useQuery({ queryKey: ["dsp7-notification-bots", companyId], queryFn: () => dsp7SeatsApi.bots(companyId) });
  const [form, setForm] = useState(blank);
  const [id, setId] = useState<string>();
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  function edit(group?: SeatNotificationGroup) {
    setId(group?.id); setForm(group ? { ...blank, name: group.name, botId: group.botId, enabled: group.enabled } : blank);
    setEditing(true); setError(""); setMessage("");
  }
  async function save() {
    setBusy(true); setError(""); setMessage("");
    try {
      const { webhookUrl, signingSecret, ...fields } = form;
      if (Boolean(webhookUrl) !== Boolean(signingSecret)) throw new Error("更新密钥时请同时填写 Webhook 和加签密钥。");
      await dsp7SeatsApi.saveGroup(companyId, id, { ...fields, ...(webhookUrl ? { credentials: { webhookUrl, signingSecret } } : {}) });
      await cache.invalidateQueries({ queryKey: ["dsp7-notification-groups", companyId] });
      setForm(blank); setEditing(false); setMessage("通知群已保存。请在席位通知设置中选择该群并保存。");
    } catch (e) { setError(e instanceof Error ? e.message : "保存失败"); }
    finally { setBusy(false); }
  }
  return <details className="rounded-lg border border-border p-4">
    <summary className="cursor-pointer font-medium">钉钉通知群（管理员）</summary>
    <div className="mt-4 space-y-3">
      <p className="text-sm text-muted-foreground">在指定钉钉群添加“自定义机器人”，启用“加签”，将 Webhook 和 SEC 开头的密钥登记到这里。选择群所属企业的已登记机器人，用于匹配席位负责人的钉钉账号。群机器人仅用于群消息，个人提醒仍由企业机器人发送。</p>
      <p className="text-xs text-muted-foreground">Webhook 与加签密钥加密保存，不会回显或下发到席位电脑。负责人须已关联该企业的钉钉账号，并加入目标群；请核对群所属企业。群名称仅用于识别，实际发送目标由 Webhook 决定。</p>
      {(groups.error || bots.error) && <p role="alert" className="text-sm text-destructive">通知群或机器人加载失败，请刷新重试。</p>}
      {groups.data?.map(group => <div key={group.id} className="flex items-center justify-between gap-3 rounded-md border border-border p-3"><span className="text-sm">{group.name} · {group.enabled ? "启用" : "停用"}</span><Button variant="outline" disabled={busy} onClick={() => edit(group)}>编辑通知群</Button></div>)}
      {!editing && <Button variant="outline" onClick={() => edit()}>添加通知群</Button>}
      {editing && <div className="space-y-3">
        <label className="block text-sm">群名称<Input value={form.name} maxLength={100} disabled={busy} onChange={e => setForm({ ...form, name: e.target.value })} /></label>
        <label className="block text-sm">所属企业机器人<select className="w-full rounded-md border border-border bg-background p-2" value={form.botId} disabled={busy || Boolean(id)} onChange={e => setForm({ ...form, botId: e.target.value })}><option value="">请选择</option>{bots.data?.filter(bot => bot.enabled || bot.id === form.botId).map(bot => <option key={bot.id} value={bot.id}>{bot.name} · {bot.corpId}{bot.enabled ? "" : "（已停用）"}</option>)}</select></label>
        <label className="block text-sm">{id ? "Webhook（留空保留原密钥）" : "群机器人 Webhook"}<Input type="password" autoComplete="off" disabled={busy} value={form.webhookUrl} onChange={e => setForm({ ...form, webhookUrl: e.target.value })} /></label>
        <label className="block text-sm">{id ? "加签密钥（留空保留原密钥）" : "加签密钥（SEC 开头）"}<Input type="password" autoComplete="off" disabled={busy} value={form.signingSecret} onChange={e => setForm({ ...form, signingSecret: e.target.value })} /></label>
        <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={form.enabled} disabled={busy} onChange={e => setForm({ ...form, enabled: e.target.checked })} />启用通知群</label>
        <div className="flex items-center justify-between gap-3"><Button variant="outline" disabled={busy} onClick={() => { setForm(blank); setEditing(false); }}>取消</Button><Button disabled={busy || !form.name.trim() || !form.botId || (!id && (!form.webhookUrl || !form.signingSecret))} onClick={() => void save()}>{busy ? "正在保存…" : "保存通知群"}</Button></div>
      </div>}
      {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
      {message && <p role="status" className="text-sm">{message}</p>}
    </div>
  </details>;
}
