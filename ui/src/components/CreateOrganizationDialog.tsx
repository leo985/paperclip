import { useEffect, useRef, useState } from "react";
import type { Company } from "@paperclipai/shared";
import { companiesApi } from "@/api/companies";
import { useCompany } from "@/context/CompanyContext";
import { useDialogActions } from "@/context/DialogContext";
import { useManagementAccess } from "@/hooks/useManagementAccess";
import { useNavigate } from "@/lib/router";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";

/** Organization creation has no model, agent, repository or task side effects. */
export function CreateOrganizationDialog() {
  const { closeOnboarding } = useDialogActions();
  const { reloadCompanies, setSelectedCompanyId } = useCompany();
  const { isInstanceAdmin, loading } = useManagementAccess();
  const navigate = useNavigate();
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [created, setCreated] = useState<Company | null>(null);
  const submitting = useRef(false);
  const active = useRef(true);
  useEffect(() => { active.current = true; return () => { active.current = false; }; }, []);
  async function submit() {
    if (submitting.current || !isInstanceAdmin || !name.trim()) return;
    submitting.current = true; setBusy(true); setError("");
    let result = created;
    try {
      result ??= await companiesApi.create({ name: name.trim(), description: description.trim() || null });
      if (!active.current) { void reloadCompanies().catch(() => {}); return; }
      setCreated(result);
      await reloadCompanies();
      if (!active.current) return;
      setSelectedCompanyId(result.id, { source: "route_sync" });
      closeOnboarding();
      navigate(`/${result.issuePrefix}/setup`);
    } catch (err) {
      if (active.current) setError(result ? "组织已创建，列表刷新失败。请重试进入配置，无需重复创建。" : err instanceof Error ? err.message : "创建组织失败，请重试。");
    } finally {
      submitting.current = false;
      if (active.current) setBusy(false);
    }
  }
  return <Dialog open onOpenChange={open => { if (!open && !busy) closeOnboarding(); }}><DialogContent>
    <DialogHeader><DialogTitle>创建组织</DialogTitle><DialogDescription>建立人员、项目和席位的管理空间。创建后按初始化清单接入研发电脑，无需先配置模型或智能体。</DialogDescription></DialogHeader>
    <form className="space-y-4" onSubmit={e => { e.preventDefault(); void submit(); }}>
      <label className="block space-y-2 text-sm"><span>组织名称</span><Input autoFocus required value={name} disabled={busy || !!created} onChange={e => setName(e.target.value)} placeholder="例如：DSP7 研发团队" /></label>
      <label className="block space-y-2 text-sm"><span>组织说明（可选）</span><Textarea value={description} disabled={busy || !!created} onChange={e => setDescription(e.target.value)} placeholder="描述团队负责的业务范围" /></label>
      {!loading && !isInstanceAdmin && <p role="alert" className="text-sm text-destructive">创建组织需要实例管理员权限。请联系平台管理员。</p>}
      {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
      <DialogFooter className="flex-row items-center justify-between sm:justify-between"><Button type="button" variant="outline" disabled={busy} onClick={closeOnboarding}>{created ? "稍后配置" : "取消"}</Button><Button type="submit" disabled={busy || loading || !isInstanceAdmin || !name.trim()}>{busy ? "正在保存…" : created ? "进入初始化清单" : "创建并配置"}</Button></DialogFooter>
    </form>
  </DialogContent></Dialog>;
}
