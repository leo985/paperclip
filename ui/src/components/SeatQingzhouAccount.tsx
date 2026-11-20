import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { SeatQingzhouAccount as Account, SeatQingzhouSave } from "@paperclipai/shared";
import { dsp7SeatsApi } from "@/api/dsp7-seats";
import { Button } from "./ui/button";
import { Input } from "./ui/input";

export function SeatQingzhouAccountForm({ account, busy, error, message, onSave, onCheck, onRemove }: {
  account: Account; busy: boolean; error?: string; message?: string;
  onSave: (value: SeatQingzhouSave) => void; onCheck: () => void; onRemove: () => void;
}) {
  const [username, setUsername] = useState(account.username ?? ""), [password, setPassword] = useState("");
  const needsPassword = !account.configured || username.trim() !== account.username;
  return <form className="space-y-3 rounded-md border border-border p-3" aria-label="席位轻舟账号" onSubmit={event => {
    event.preventDefault(); onSave({ username: username.trim(), expectedRevision: account.revision, ...(password ? { password } : {}) });
  }}>
    <h3 className="text-sm font-medium">轻舟账号 · {account.configured ? "已配置" : "未配置"}</h3>
    <p className="text-sm text-muted-foreground">此账号代表当前席位，分析完成后使用它保存轻舟内容。账号须具备对应条目分析负责人的权限。密码加密保存，不会返回页面或交给模型。</p>
    {account.configured && <p className="text-sm">登录检查：{account.lastCheckStatus === "valid" ? "登录成功" : account.lastCheckStatus === "failed" ? "检查未通过" : "尚未检查"}。登录成功后仍需逐条核验业务权限。</p>}
    <label className="block space-y-1 text-sm">轻舟账号<Input aria-label="席位轻舟账号" name="qingzhou-username" autoComplete="off" maxLength={200} required disabled={busy} value={username} onChange={event => setUsername(event.target.value)}/></label>
    <label className="block space-y-1 text-sm">轻舟密码<Input aria-label="席位轻舟密码" name="qingzhou-password" type="password" autoComplete="new-password" maxLength={1000} required={needsPassword} disabled={busy} value={password} placeholder={needsPassword ? "请输入密码" : "****"} onChange={event => setPassword(event.target.value)}/></label>
    {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
    {message && <p role="status" className="text-sm">{message}</p>}
    <div className="flex flex-wrap items-center justify-between gap-3">
      <div className="flex flex-wrap gap-2"><Button type="button" variant="outline" disabled={busy || !account.configured} onClick={onCheck}>检查已保存账号</Button><Button type="button" variant="ghost" disabled={busy || !account.configured} onClick={onRemove}>移除账号</Button></div>
      <Button type="submit" disabled={busy || !username.trim() || (needsPassword && !password)}>{busy ? "正在处理…" : "保存轻舟账号"}</Button>
    </div>
  </form>;
}

export function SeatQingzhouAccount({ companyId, seatId }: { companyId: string; seatId: string }) {
  const cache = useQueryClient(), queryKey = ["seat-qingzhou-account", companyId, seatId];
  const query = useQuery({ queryKey, queryFn: () => dsp7SeatsApi.qingzhouAccount(companyId, seatId) });
  const [busy, setBusy] = useState(false), [error, setError] = useState(""), [message, setMessage] = useState("");
  async function action(work: () => Promise<Account & { error?: string }>, feedback: string) {
    if (busy) return;
    setBusy(true); setError(""); setMessage("");
    try { const result = await work(); cache.setQueryData(queryKey, result); if (result.error) setError(result.error); else setMessage(feedback); }
    catch (caught) { setError(caught instanceof Error ? caught.message : "轻舟账号操作失败，请重试"); }
    finally { setBusy(false); }
  }
  if (query.isPending) return <p className="text-sm">正在加载席位轻舟账号…</p>;
  if (query.error) return <div className="space-y-2"><p role="alert" className="text-sm text-destructive">{query.error.message}</p><Button variant="outline" onClick={() => void query.refetch()}>重新加载轻舟账号</Button></div>;
  const account = query.data;
  return <SeatQingzhouAccountForm key={seatId + ":" + account.revision} account={account} busy={busy} error={error} message={message}
    onSave={value => void action(() => dsp7SeatsApi.saveQingzhouAccount(companyId, seatId, value), "席位轻舟账号已保存。分析回写将使用此账号，可检查登录状态。")}
    onCheck={() => void action(() => dsp7SeatsApi.checkQingzhouAccount(companyId, seatId, account.revision), "轻舟登录成功；条目保存权限以轻舟实际校验为准。")}
    onRemove={() => void action(() => dsp7SeatsApi.removeQingzhouAccount(companyId, seatId, account.revision), "轻舟账号已移除。重新配置后才能回写分析成果。")}/>;
}
