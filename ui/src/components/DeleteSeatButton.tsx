import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { dsp7SeatsApi, type RegisteredSeat } from "@/api/dsp7-seats";
import { useManagementAccess } from "@/hooks/useManagementAccess";
import { queryKeys } from "@/lib/queryKeys";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  AlertDialog, AlertDialogContent, AlertDialogHeader,
  AlertDialogTitle, AlertDialogDescription,
} from "@/components/ui/alert-dialog";

export function DeleteSeatButton({ companyId, seat, onDeleted }: {
  companyId: string; seat: RegisteredSeat; onDeleted: () => void;
}) {
  const { canManage } = useManagementAccess();
  const cache = useQueryClient();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  if (!canManage) return null;

  async function remove() {
    if (busy || name !== seat.name || seat.online) return;
    setBusy(true); setError("");
    try {
      await dsp7SeatsApi.remove(companyId, seat.agentId);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "删除失败，请重试");
      setBusy(false); return;
    }
    cache.setQueryData<RegisteredSeat[]>(["dsp7-registered-seats", companyId], previous => previous?.filter(item => item.agentId !== seat.agentId));
    onDeleted();
    void cache.invalidateQueries({ queryKey: ["dsp7-registered-seats", companyId] });
    void cache.invalidateQueries({ queryKey: queryKeys.agents.list(companyId) });
    void cache.invalidateQueries({ queryKey: ["managed-seat-report", companyId] });
    setOpen(false); setBusy(false);
  }

  return <>
    <Button type="button" variant="outline" className="text-destructive" disabled={seat.online}
      title={seat.online ? "请先在电脑下线或卸载客户端，等待显示离线后再删除" : "仅管理员可删除席位"}
      onClick={() => { setName(""); setError(""); setOpen(true); }}>删除席位</Button>
    <AlertDialog open={open} onOpenChange={value => { if (!busy) setOpen(value); }}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>删除席位“{seat.name}”？</AlertDialogTitle>
          <AlertDialogDescription>此操作会永久删除该席位对应的智能体、运行记录、所发评论和接入凭据，无法撤销。不会卸载电脑上的客户端。存在未结束任务时，请先完成、取消或转派任务。</AlertDialogDescription>
        </AlertDialogHeader>
        <label className="space-y-2 text-sm">输入席位名称确认删除
          <Input aria-label="输入席位名称确认删除" value={name} disabled={busy} onChange={event => setName(event.target.value)} />
        </label>
        {seat.online && <p role="alert" className="text-sm text-destructive">席位已重新上线，请先下线后再删除。</p>}
        {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
        <div className="flex items-center justify-between gap-3">
          <Button type="button" variant="outline" disabled={busy} onClick={() => setOpen(false)}>取消</Button>
          <Button type="button" variant="destructive" disabled={busy || name !== seat.name || seat.online} onClick={() => void remove()}>{busy ? "正在删除…" : "确认删除席位"}</Button>
        </div>
      </AlertDialogContent>
    </AlertDialog>
  </>;
}
