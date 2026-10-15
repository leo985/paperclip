import { navigateTopLevel } from "@/lib/browserNavigation";
import { useId, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { LockKeyhole, LoaderCircle } from "lucide-react";
import { authApi, AuthApiError } from "@/api/auth";
import { useCloudInstance } from "@/hooks/useCloudInstance";
import { queryKeys } from "@/lib/queryKeys";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useSignOut } from "@/hooks/useSignOut";

const passwordErrors: Record<string, string> = {
  INVALID_PASSWORD: "旧密码不正确，请重新输入。",
  PASSWORD_TOO_SHORT: "新密码至少需要 8 个字符。",
  PASSWORD_TOO_LONG: "新密码不能超过 128 个字符。",
  CREDENTIAL_ACCOUNT_NOT_FOUND: "当前账号没有本地密码，请使用所属登录服务管理密码。",
  SESSION_NOT_FRESH: "请重新登录后再修改密码。",
  UNAUTHORIZED: "登录会话已失效，请重新登录后再修改密码。",
};

export function ChangePasswordForm({requiredChange=false}:{requiredChange?:boolean}) {
  const cloud = useCloudInstance();
  const signOut = useSignOut();
  const cache = useQueryClient();
  const id = useId();
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [revokeOtherSessions, setRevokeOtherSessions] = useState(true);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [message, setMessage] = useState("");
  const [needsLogin, setNeedsLogin] = useState(false);
  // Passwords stay in the form, rather than being retained as mutation variables.
  const mutation = useMutation({
    mutationFn: () => authApi.changePassword({ currentPassword, newPassword, revokeOtherSessions }),
    onSuccess: () => {
      setCurrentPassword("");
      setNewPassword("");
      setConfirmation("");
      setErrors({});
      setMessage(revokeOtherSessions
        ? "密码已修改，其他设备的登录会话已退出。当前登录保留，下次登录请使用新密码。"
        : "密码已修改，当前登录保留。下次登录请使用新密码。");
      void cache.invalidateQueries({ queryKey: queryKeys.auth.session });
      void cache.invalidateQueries({ queryKey: queryKeys.auth.passwordStatus });
      if(requiredChange)navigateTopLevel("/");
    },
    onError: (error) => {
      const code = error instanceof AuthApiError ? error.code : null;
      const needsLogin = code === "SESSION_NOT_FRESH" || error instanceof AuthApiError && error.status === 401;
      setNeedsLogin(needsLogin);
      setErrors({ [code === "INVALID_PASSWORD" ? "current" : "request"]:
        needsLogin ? "请重新登录后再修改密码。" : passwordErrors[code ?? ""] ?? "密码修改失败，请稍后重试。" });
    },
  });

  function edit(setValue: (value: string) => void, value: string) {
    setValue(value);
    setErrors({});
    setMessage("");
    setNeedsLogin(false);
  }
  function fieldError(key: string) {
    return errors[key] ? <p id={`${id}-${key}-error`} role="alert" className="text-xs text-destructive">{errors[key]}</p> : null;
  }

  return <Card className="block p-6">
    <div className="mb-4 space-y-2">
      <h2 className="flex items-center gap-2 font-semibold"><LockKeyhole className="size-4" />修改密码</h2>
      <p className="text-sm text-muted-foreground">修改当前登录账号的密码，需先验证旧密码。</p>
    </div>
    {cloud ? <p className="text-sm text-muted-foreground">此账号由外部登录服务管理，请到所属登录服务修改密码。</p> : <form
      className="max-w-xl space-y-4"
      onSubmit={event => {
        event.preventDefault();
        if (mutation.isPending) return;
        setMessage("");
        setNeedsLogin(false);
        const next: Record<string, string> = {};
        if (!currentPassword) next.current = "请输入旧密码。";
        if (newPassword.length < 8 || newPassword.length > 128) next.new = "新密码需要 8–128 个字符。";
        else if (newPassword === currentPassword) next.new = "新密码不能与旧密码相同。";
        if (!confirmation || confirmation !== newPassword) next.confirm = "两次输入的新密码不一致。";
        setErrors(next);
        if (!Object.keys(next).length) mutation.mutate();
      }}>
      <div className="space-y-2"><Label htmlFor={`${id}-current`}>旧密码</Label><Input
        id={`${id}-current`} type="password" autoComplete="current-password" value={currentPassword}
        disabled={mutation.isPending} aria-invalid={!!errors.current} aria-describedby={errors.current ? `${id}-current-error` : undefined}
        onChange={event => edit(setCurrentPassword, event.target.value)} />{fieldError("current")}</div>
      <div className="space-y-2"><Label htmlFor={`${id}-new`}>新密码</Label><Input
        id={`${id}-new`} type="password" autoComplete="new-password" value={newPassword} maxLength={128}
        disabled={mutation.isPending} aria-invalid={!!errors.new} aria-describedby={`${id}-hint${errors.new ? ` ${id}-new-error` : ""}`}
        onChange={event => edit(setNewPassword, event.target.value)} /><p id={`${id}-hint`} className="text-xs text-muted-foreground">8–128 个字符，与旧密码不同。</p>{fieldError("new")}</div>
      <div className="space-y-2"><Label htmlFor={`${id}-confirm`}>确认新密码</Label><Input
        id={`${id}-confirm`} type="password" autoComplete="new-password" value={confirmation} maxLength={128}
        disabled={mutation.isPending} aria-invalid={!!errors.confirm} aria-describedby={errors.confirm ? `${id}-confirm-error` : undefined}
        onChange={event => edit(setConfirmation, event.target.value)} />{fieldError("confirm")}</div>
      <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={revokeOtherSessions} disabled={mutation.isPending||requiredChange}
        onChange={event => {setRevokeOtherSessions(event.target.checked); setMessage("");}} />退出其他设备的登录会话</label>
      {fieldError("request")}
      {needsLogin && <Button type="button" variant="outline" disabled={signOut.isPending} onClick={() => signOut.mutate()}>{signOut.isPending ? "正在退出…" : "退出并重新登录"}</Button>}
      {signOut.error && <p role="alert" className="text-sm text-destructive">退出未完成，请刷新页面后重试。</p>}
      {message && <p role="status" className="text-sm">{message}</p>}
      <Button type="submit" disabled={mutation.isPending}>{mutation.isPending && <LoaderCircle className="size-4 animate-spin" />}{mutation.isPending ? "正在修改…" : "保存新密码"}</Button>
    </form>}
  </Card>;
}
