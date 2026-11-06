import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { managementFollowUpApi } from "@/api/management-follow-ups";
import { authApi } from "@/api/auth";
import { useManagementAccess } from "@/hooks/useManagementAccess";
import { accessApi } from "@/api/access";
import { Button } from "./ui/button";

/** Follow-up ownership is separate from execution assignment and formal decisions. */
export function ManagementFollowUpControls({ companyId, issueId }: { companyId: string; issueId: string }) {
  const [open, setOpen] = useState(false), [target, setTarget] = useState("");
  const client = useQueryClient(), { canManage } = useManagementAccess();
  const key = ["management-follow-up", companyId, issueId];
  const record = useQuery({ queryKey: key, queryFn: () => managementFollowUpApi.get(companyId, issueId), enabled: open, retry: false, refetchInterval: open ? 30_000 : false });
  const session = useQuery({ queryKey: ["auth", "session"], queryFn: () => authApi.getSession(), enabled: open });
  const directory = useQuery({ queryKey: ["follow-up-users", companyId], queryFn: () => accessApi.listUserDirectory(companyId), enabled: open && canManage, retry: false });
  const actor = session.data?.user?.id ?? "local-board";
  const mutation = useMutation({
    mutationFn: (input: { ownerUserId?: string | null; remindAt?: string | null }) => managementFollowUpApi.update(companyId, issueId, { expectedVersion: record.data?.version ?? 0, ...input }),
    onSuccess: value => { client.setQueryData(key, value); },
    onError: () => { void client.invalidateQueries({ queryKey: key }); },
  });
  const row = record.data, mine = row?.ownerUserId === actor;
  const editable = (canManage || !row?.ownerUserId || mine) && record.isSuccess && !mutation.isPending;
  return <details className="space-y-2 text-sm" onToggle={event => setOpen(event.currentTarget.open)}>
    <summary className="cursor-pointer font-medium">协作跟进</summary>
    {open && <div className="space-y-3 pt-2">
      <p className="text-xs text-muted-foreground">认领仅记录协调责任，不改变工单指派、执行授权或正式审批。提醒在此显示，不代表已发送通知。</p>
      {record.isPending && <p>正在读取跟进记录…</p>}
      {record.isError && <p role="alert">跟进记录读取失败或当前服务未支持。<Button size="sm" variant="outline" onClick={() => void record.refetch()}>重试读取</Button></p>}
      {record.isSuccess && <><p>{row?.ownerUserId ? `当前跟进人：${mine ? "我" : directory.data?.users.find(u => u.principalId === row.ownerUserId)?.user?.name ?? row.ownerUserId}` : "尚未认领"}</p>
        {row?.remindAt && <p role="status">{Date.parse(row.remindAt) <= Date.now() ? "提醒已到期" : "下次提醒"}：{new Date(row.remindAt).toLocaleString("zh-CN")}</p>}
        <div className="flex flex-wrap items-center gap-2">
          {!row?.ownerUserId && <Button size="sm" disabled={!editable || session.isPending || session.isError} onClick={() => mutation.mutate({ ownerUserId: actor })}>由我跟进</Button>}
          {row?.ownerUserId && (mine || canManage) && <Button size="sm" variant="outline" disabled={!editable} onClick={() => mutation.mutate({ ownerUserId: null, remindAt: null })}>释放跟进</Button>}
          <Button size="sm" variant="outline" disabled={!editable} onClick={() => mutation.mutate({ remindAt: new Date(Date.now() + 3_600_000).toISOString() })}>一小时后提醒</Button>
          {row?.remindAt && <Button size="sm" variant="ghost" disabled={!editable} onClick={() => mutation.mutate({ remindAt: null })}>清除提醒</Button>}
        </div>
        {canManage && <div className="flex flex-wrap items-center gap-2"><label>转交给 <select className="rounded-md border border-border bg-background p-2" aria-label="跟进接收人" value={target} onChange={event => setTarget(event.target.value)}><option value="">选择成员</option>{directory.data?.users.map(user => <option key={user.principalId} value={user.principalId}>{user.user?.name ?? user.user?.email ?? user.principalId}</option>)}</select></label><Button size="sm" disabled={!editable || !target} onClick={() => mutation.mutate({ ownerUserId: target })}>转交跟进</Button>{directory.isError && <p role="alert">成员读取失败，请刷新重试。</p>}</div>}
      </>}
      {mutation.isError && <p role="alert">{mutation.error instanceof Error ? mutation.error.message : "保存失败，请刷新后重试"}</p>}
    </div>}
  </details>;
}
