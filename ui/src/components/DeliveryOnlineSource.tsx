import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { DeliveryConnection, DeliveryPlan, DeliverySnapshot, DeliverySourceOrganizations } from "@paperclipai/shared";
import { api } from "@/api/client";
import { Button } from "@/components/ui/button";
import { SearchableSelect } from "@/components/SearchableSelect";

const statuses: Record<string, string> = { not_checked: "尚未核验", verified: "已核验", authentication_required: "需要核对账号凭据", connection_unavailable: "来源暂不可达", incomplete_response: "来源数据不完整", source_rejected: "来源拒绝访问", invalid_response: "来源返回格式异常" };
export function DeliveryOnlineSource({ companyId, projectId, onPlan, onSaved, initialDemandNo = "" }: { companyId: string; projectId: string; onPlan: (plan: DeliveryPlan) => void; onSaved?: () => void; initialDemandNo?: string }) {
  const qc = useQueryClient();
  const base = `/companies/${companyId}/delivery-connections`;
  const connection = useQuery({ queryKey: ["delivery-connection", companyId, projectId], queryFn: () => api.get<DeliveryConnection | null>(`${base}?projectId=${projectId}`) });
  const [jiraBaseUrl, setJiraBaseUrl] = useState("");
  const [jiraToken, setJiraToken] = useState("");
  const [organizationId, setOrg] = useState("");
  const [username, setUser] = useState(""); const [password, setPassword] = useState("");
  const [showSingle, setShowSingle] = useState(!!initialDemandNo);
  const [demandNo, setDemand] = useState(initialDemandNo); const [months, setMonths] = useState(new Date().toISOString().slice(0, 7));
  const [busy, setBusy] = useState(false); const [error, setError] = useState(""); const [message, setMessage] = useState("");
  const [manualOrganizations,setManualOrganizations]=useState<DeliverySourceOrganizations|null>(null);
  const [organizationBusy,setOrganizationBusy]=useState(false),[organizationError,setOrganizationError]=useState("");
  const editingCredentials=!!username||!!password;
  const savedOrganizations=useQuery({queryKey:["delivery-source-organizations",companyId,projectId,connection.data?.revision],queryFn:()=>api.post<DeliverySourceOrganizations>(`${base}/organizations`,{projectId,expectedRevision:connection.data!.revision}),enabled:!!connection.data?.credentialsConfigured&&!editingCredentials,retry:false,staleTime:300000});
  const organizationOptions=(editingCredentials?manualOrganizations:savedOrganizations.data)?.items??[];
  const selectedOrganization=organizationOptions.find(item=>item.id===organizationId);
  useEffect(()=>{if(!organizationId&&organizationOptions.length===1)setOrg(organizationOptions[0].id);},[organizationId,organizationOptions]);
  async function readOrganizations(){
    setOrganizationError("");
    if(!editingCredentials){await savedOrganizations.refetch();return;}
    if(!username||!password){setOrganizationError("请同时填写轻舟账号和密码，再读取组织");return;}
    setOrganizationBusy(true);
    try{
      const result=await api.post<DeliverySourceOrganizations>(`${base}/organizations`,{projectId,expectedRevision:connection.data?.revision??0,credentials:{username,password}});
      setManualOrganizations(result);
      if(!result.items.some(item=>item.id===organizationId))setOrg(result.items.length===1?result.items[0].id:"");
    }catch(e){setOrganizationError(e instanceof Error?e.message:"组织读取失败，请重试");}finally{setOrganizationBusy(false);}
  }
  useEffect(() => { setJiraBaseUrl(connection.data?.jiraBaseUrl ?? ""); setJiraToken(""); setOrg(connection.data?.organizationId ?? ""); setUser(""); setPassword(""); setManualOrganizations(null);setOrganizationError(""); }, [connection.data?.id, connection.data?.revision]);
  async function act(operation: "save" | "test" | "sync") {
    setBusy(true); setError(""); setMessage("");
    try {
      if (operation === "save") {
        if(!organizationId||(!selectedOrganization&&(editingCredentials||organizationId!==connection.data?.organizationId)))throw Error("请先读取组织并选择轻舟排期组织");
        if (!!username !== !!password) throw Error("更新凭据时请同时填写账号和密码");
        const saved = await api.put<DeliveryConnection>(base, { projectId, expectedRevision: connection.data?.revision ?? 0, jira: {baseUrl:jiraBaseUrl.trim(),...(jiraToken.trim()?{token:jiraToken.trim()}:{})}, organizationId, ...(username && password ? { credentials: { username, password } } : {}) });
        setUser(""); setPassword(""); qc.setQueryData(["delivery-connection", companyId, projectId], saved); setMessage("来源配置已保存，可按月份浏览组织条目。");
        onSaved?.();
      } else {
        const result = await api.post<{ plan: DeliveryPlan; snapshot?: DeliverySnapshot; existing?: boolean }>(`${base}/${operation}`, { projectId, expectedRevision: connection.data?.revision, demandNo: demandNo.trim(), months: months.split(/[,，\s]+/).filter(Boolean) });
        onPlan(result.plan); setMessage(operation === "test" ? "核验完成，尚未保存快照。" : result.existing ? "此来源版本已保存，未重复纳管。" : "在线只读版本已保存，未创建执行任务。");
        await qc.invalidateQueries({ queryKey: ["delivery-snapshots", companyId] });
        await qc.invalidateQueries({ queryKey: ["delivery-connection", companyId, projectId] });
      }
    } catch (e) { setError(e instanceof Error ? e.message : "操作失败，请重试"); }
    finally { setBusy(false); }
  }
  const field = "block w-full rounded-md border border-border bg-background p-2";
  return <section className="space-y-3 rounded-lg border border-border p-4" aria-label="在线来源">
    <h2 className="font-semibold">组织来源配置</h2>
    <p className="text-sm text-muted-foreground">选择组织并保存后，即可按排期月份浏览该组织的条目，无需逐条接入。读取和展示不会派单或修改来源数据。</p>
    {connection.isPending ? <p>正在加载来源配置…</p> : connection.isError ? <p role="alert">来源配置加载失败。<Button variant="outline" onClick={() => { void connection.refetch(); }}>重试</Button></p> : <>
      <p className="text-sm">连接状态：{statuses[connection.data?.lastCheckStatus ?? "not_checked"] ?? "核验未通过"}{connection.data?.lastCheckedAt && ` · ${new Date(connection.data.lastCheckedAt).toLocaleString()}`}</p>
      <fieldset disabled={busy||organizationBusy} className="space-y-3"><legend className="sr-only">项目来源配置</legend>
        <section className="space-y-3" aria-label="项目 Jira 连接">
          <h3 className="text-sm font-medium">项目 Jira 连接</h3>
          <p className="text-sm text-muted-foreground">统一为当前项目读取工单信息，不绑定个人电脑或执行席位；派单时再选择执行席位。</p>
          <div className="grid gap-3 md:grid-cols-2">
            <label className="block space-y-2 text-sm">Jira 服务地址<input className={field} type="url" value={jiraBaseUrl} onChange={e=>setJiraBaseUrl(e.target.value)} placeholder="http://jira.fingard.com:6001" autoComplete="off" /></label>
            <label className="block space-y-2 text-sm">Jira PAT<input className={field} type="password" value={jiraToken} onChange={e=>setJiraToken(e.target.value)} placeholder={connection.data?.jiraCredentialsConfigured?"已配置，留空保留原凭据":"首次配置请填写 PAT"} autoComplete="new-password" /></label>
          </div>
          <p className="text-xs text-muted-foreground">PAT 加密保存，不回显。变更 Jira 服务地址时需重新填写 PAT。</p>
          {connection.data?.jiraConnectionMode==="legacy_seat"&&<p className="text-sm text-muted-foreground">检测到旧席位连接。保存后会复制为项目独立凭据，不修改席位原有配置；地址未变时无需重新填写 PAT。</p>}
        </section>
        <div className="grid gap-3 md:grid-cols-2"><label className="block space-y-2 text-sm">轻舟登录账号<input className={field} value={username} onChange={e => {setUser(e.target.value);setManualOrganizations(null);setOrganizationError("");}} autoComplete="off" /></label><label className="block space-y-2 text-sm">轻舟密码<input className={field} type="password" value={password} onChange={e => {setPassword(e.target.value);setManualOrganizations(null);setOrganizationError("");}} autoComplete="new-password" /></label></div>
        <p className="text-sm text-muted-foreground">{connection.data?.credentialsConfigured ? "已保存加密凭据；账号和密码均留空可保留原配置。" : "首次配置需要填写轻舟账号和密码，保存后不回显。"}</p>
        <section className="space-y-3" aria-label="轻舟排期组织选择">
          <div className="flex flex-wrap items-center justify-between gap-3"><h3 className="text-sm font-medium">轻舟排期组织</h3><Button type="button" variant="outline" disabled={organizationBusy||savedOrganizations.isFetching||(!connection.data?.credentialsConfigured&&(!username||!password))} onClick={()=>void readOrganizations()}>{organizationBusy||savedOrganizations.isFetching?"正在读取组织…":organizationOptions.length?"刷新组织":"读取组织"}</Button></div>
          <p className="text-xs text-muted-foreground">先填写轻舟账号密码，再读取并选择所属研发组或测试组；已有配置可直接复用保存的凭据。读取组织不会保存账号或修改来源配置。</p>
          <label className="block space-y-2 text-sm">选择轻舟组织
            <SearchableSelect
              value={organizationId}
              onValueChange={value=>setOrg(value)}
              disabled={busy||organizationBusy||savedOrganizations.isFetching||organizationOptions.length===0}
              placeholder={organizationOptions.length?"请选择排期所属组织":"请先读取轻舟组织"}
              searchPlaceholder="搜索组织名称、编码或类型…"
              emptyMessage="没有匹配的组织，请调整关键词"
              groups={[{id:"qingzhou-organizations",options:[
                ...(organizationId&&!selectedOrganization?[{key:organizationId,value:organizationId,label:`已保存的组织（编号 ${organizationId}）`,disabled:true}]:[]),
                ...organizationOptions.map(item=>({key:item.id,value:item.id,label:`${item.name}${item.code?` · ${item.code}`:""} · ${item.kinds.map(kind=>kind==="researchGroup"?"研发":"测试").join("／")}`,searchText:item.id})),
              ]}]}
            />
          </label>
          {(organizationError||(!editingCredentials&&savedOrganizations.isError))&&<p role="alert" className="text-sm text-destructive">{organizationError||savedOrganizations.error?.message||"组织读取失败，请核对轻舟连接后重试"}</p>}
          {((editingCredentials&&manualOrganizations)||savedOrganizations.isSuccess&&!editingCredentials)&&organizationOptions.length===0&&<p className="text-sm text-muted-foreground">当前轻舟账号未返回可选研发组或测试组，请核对账号权限。</p>}
          {organizationId&&!selectedOrganization&&<p className="text-xs text-muted-foreground">保留原组织配置。成功读取后可查看名称或重新选择，不会自动切换组织。</p>}
        </section>
        <div className="flex justify-end"><Button type="button" disabled={organizationBusy||!organizationId||!jiraBaseUrl.trim()} onClick={() => void act("save")}>保存并查看组织条目</Button></div>
        <details className="space-y-3" open={showSingle || undefined}>
          <summary className="cursor-pointer text-sm font-medium">更多操作</summary>
          <Button type="button" variant="outline" aria-expanded={showSingle} onClick={()=>setShowSingle(!showSingle)}>{showSingle?"收起单条补录":"补录指定条目"}</Button>
          {showSingle&&<section className="space-y-3 rounded-md border border-border p-3" aria-label="补录指定条目">
          <h3 className="text-sm font-medium">补录指定条目</h3>
          <p className="text-sm text-muted-foreground">用于补录月度列表之外的已知条目，或核对跨月排期；日常浏览请使用需求条目的月度排期。</p>
        <div className="grid gap-3 md:grid-cols-2"><label className="block space-y-2 text-sm">轻舟条目号<input className={field} value={demandNo} onChange={e => setDemand(e.target.value)} placeholder="ATS3-00156" /></label><label className="block space-y-2 text-sm">排期查询范围<input className={field} value={months} onChange={e => setMonths(e.target.value)} placeholder="2026-10,2026-11" /></label></div>
        <p className="text-sm text-muted-foreground">跨月条目可补充全部排期月份，以逗号分隔，最多 12 个月。这里只读取排期，不设置开工时间。</p>
        <div className="flex items-center justify-between"><Button variant="outline" disabled={!connection.data || !demandNo} onClick={() => void act("test")}>读取并核对</Button><Button disabled={!connection.data || !demandNo} onClick={() => void act("sync")}>同步只读版本</Button></div>
          </section>}
        </details>
      </fieldset>
    </>}
    {busy && <p role="status" className="text-sm">正在处理来源请求…</p>}{error && <p role="alert" className="text-sm text-destructive">{error}</p>}{message && <p role="status" className="text-sm">{message}</p>}
  </section>;
}
