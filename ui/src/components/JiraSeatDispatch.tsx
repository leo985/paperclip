import { localizedStatus,  uiText } from "@/i18n/interface";
import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { projectsApi } from "@/api/projects";
import { dsp7SeatsApi, type JiraDispatchRule, type JiraPreview } from "@/api/dsp7-seats";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
const types=["编码","前端编码","功能","内部缺陷","线上问题","系统设计","系统设计补充","接口联调"];
export function JiraSeatDispatch({companyId,agentId}:{companyId:string;agentId:string}) {
 const cache=useQueryClient();
 const rule=useQuery({queryKey:["jira-seat-dispatch",companyId,agentId],queryFn:()=>dsp7SeatsApi.dispatch(companyId,agentId)});
 const projects=useQuery({queryKey:["jira-dispatch-projects",companyId],queryFn:()=>projectsApi.list(companyId)});
 const [form,setForm]=useState<JiraDispatchRule>({jiraBaseUrl:"http://jira.fingard.com:6001",enabled:false,jiraAssignee:"",jiraProjectKey:"ATSES",projectId:"",readyStatuses:[],issueTypes:types});
 const [pat,setPat]=useState("");const [patFocused,setPatFocused]=useState(false);const [dirty,setDirty]=useState(false);const [errors,setErrors]=useState<Record<string,string>>({});const [preview,setPreview]=useState<JiraPreview|null>(null);const [previewFingerprint,setPreviewFingerprint]=useState("");const [previewError,setPreviewError]=useState("");
 const [statusSearch,setStatusSearch]=useState("");
 const [statuses,setStatuses]=useState("");const [busy,setBusy]=useState(false);const [message,setMessage]=useState("");
 useEffect(()=>{if(rule.data&&!dirty){setForm(rule.data);setStatuses(rule.data.readyStatuses.join(","));}},[rule.data,dirty]);
 const project=projects.data?.find(p=>p.id===form.projectId);
 const readyStatuses=Array.from(new Set(statuses.split(/[,，]/).map(s=>s.trim()).filter(Boolean)));
 const fingerprint=JSON.stringify([form.jiraBaseUrl,form.jiraAssignee,form.jiraProjectKey,readyStatuses,form.issueTypes,pat]);
 const currentPreview=previewFingerprint===fingerprint?preview:null;
 const statusOptions=preview&&JSON.parse(previewFingerprint)[0]===form.jiraBaseUrl&&JSON.parse(previewFingerprint)[5]===pat?preview.statuses:[];
 const statusChoices=Array.from(new Set(statusOptions));
 const searchTerms=statusSearch.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
 const visibleStatuses=statusChoices.filter(status=>searchTerms.every(term=>status.toLocaleLowerCase().includes(term)));
 const selectedVisibleCount=visibleStatuses.filter(status=>readyStatuses.includes(status)).length;
 const allVisibleSelected=visibleStatuses.length>0&&selectedVisibleCount===visibleStatuses.length;
 function selectVisibleStatuses(selected:boolean){
  const next=selected?Array.from(new Set([...readyStatuses,...visibleStatuses])):readyStatuses.filter(status=>!visibleStatuses.includes(status));
  if(next.length>1000){setErrors(current=>({...current,status:"选择的状态超过 1000 个，请搜索并缩小范围。"}));return;}
  changeStatuses(next);
 }
 function changeStatuses(next:string[]){setStatuses(Array.from(new Set(next)).join(","));setDirty(true);setErrors(current=>({...current,status:""}));}
 function fieldError(key:string){return errors[key]?<span role="alert" className="block text-xs text-destructive">{errors[key]}</span>:null;}
 function validate(){const next:Record<string,string>={};
  try{const u=new URL(form.jiraBaseUrl);if(!["http:","https:"].includes(u.protocol)||u.username||u.password||u.search||u.hash)next.url="请输入有效的 Jira 网站地址";}catch{next.url="请输入有效的 Jira 网站地址";}
  if(!form.jiraAssignee.trim())next.assignee="请填写 Jira 登录名";
  if(!/^[A-Z][A-Z0-9_]*$/.test(form.jiraProjectKey))next.project="请输入有效的 Jira 项目代号";
  if(!project)next.projectScope="请选择有效的智研协同平台项目";
  if(!readyStatuses.length)next.status="请在“工单状态”中至少选择一个状态，才能确定何时允许执行。";
  else if(readyStatuses.length>1000)next.status="最多选择 1000 个工单状态，请搜索并缩小范围。";
  if(!form.issueTypes.length)next.types="至少选择一种工单类型";
  if(form.enabled&&!pat.trim()&&!form.jiraPatConfigured)next.pat="首次启用请填写 Jira PAT";
  setErrors(next);return !Object.keys(next).length;
 }
 async function verify(){setBusy(true);setPreviewError("");setPreview(null);try{
  const value=await dsp7SeatsApi.previewDispatch(companyId,agentId,{jiraBaseUrl:form.jiraBaseUrl,...(pat.trim()?{credentials:{token:pat.trim()}}:{}),...(form.jiraAssignee.trim()?{jiraAssignee:form.jiraAssignee}:{}),...(form.jiraProjectKey?{jiraProjectKey:form.jiraProjectKey}:{}),...(readyStatuses.length?{readyStatuses}:{}),...(form.issueTypes.length?{issueTypes:form.issueTypes}:{})});setPreview(value);setPreviewFingerprint(fingerprint);
 }catch(e){setPreviewError(e instanceof Error?e.message:"连接验证失败");}finally{setBusy(false);}}
 async function save(){if(!validate())return;
 if(form.enabled&&!rule.data?.enabled&&!window.confirm("开启后，仅自动执行在智研平台明确派发且符合规则的工单；Jira 指派不会触发开工。是否开启？"))return;
 if(!form.enabled&&rule.data?.enabled&&!window.confirm("停用规则会使当前自动工单授权失效，并停止正在执行的自动工单。仅暂时不接新工单，请在运行概览使用“暂停接单”。确认停用？"))return;
 setBusy(true);setMessage("");try{const {revision:_revision,ownerUserId:_owner,jiraPatConfigured:_configured,credentials:_credentials,workspaceId:_legacyWorkspace,...data}=form;await dsp7SeatsApi.saveDispatch(companyId,agentId,{...data,...(pat.trim()?{credentials:{token:pat.trim()}}:{}),readyStatuses});setPat("");await rule.refetch();setDirty(false);await cache.invalidateQueries({queryKey:["dsp7-registered-seats",companyId]});setMessage("已保存。席位将按此范围校验平台派单；不会根据 Jira 指派自动执行。");}catch(e){setMessage(e instanceof Error?e.message:"保存失败");}finally{setBusy(false);}}
 return <section className="space-y-3 rounded-md border border-border p-4" onChange={()=>{setDirty(true);setErrors({});}}><h3 className="font-medium">平台派单后自动执行</h3><p className="text-sm text-muted-foreground">配置此席位允许接收的平台工单范围。组长在智研平台点击“派单并执行”后，本机自动准备并打开可见 Claude 终端；Jira 中的指派不会自行触发执行。</p><label className="flex gap-2 text-sm"><input type="checkbox" checked={form.enabled} onChange={e=>setForm({...form,enabled:e.target.checked})}/>允许此电脑自动执行智研平台明确派发、且符合下方范围的工单（不会扫描 Jira 自动接单）</label><div className="grid gap-3 md:grid-cols-2"><label className="text-sm">Jira 网站地址<Input value={form.jiraBaseUrl} onChange={e=>setForm({...form,jiraBaseUrl:e.target.value})}/>{fieldError("url")}</label><label className="text-sm">{uiText("Jira PAT")}<Input type="password" aria-label="Jira PAT" autoComplete="new-password" value={pat || (form.jiraPatConfigured&&!patFocused?"••••••••":"")} onFocus={()=>setPatFocused(true)} onBlur={()=>setPatFocused(false)} onChange={e=>setPat(e.target.value)} placeholder={form.jiraPatConfigured?"输入新 PAT 可替换；留空保留":"首次启用请填写 Jira PAT"}/>{fieldError("pat")}</label><label className="text-sm">Jira 在手工单统计账号<Input value={form.jiraAssignee} onChange={e=>setForm({...form,jiraAssignee:e.target.value})} placeholder="用于 Jira 在手工单统计，不限制执行席位"/>{fieldError("assignee")}</label><label className="text-sm">Jira 项目代号<Input value={form.jiraProjectKey} onChange={e=>setForm({...form,jiraProjectKey:e.target.value.toUpperCase()})}/>{fieldError("project")}</label><label className="text-sm">智研协同平台项目<select className="w-full rounded-md border border-border bg-background p-2" value={form.projectId} onChange={e=>setForm({...form,projectId:e.target.value})}><option value="">请选择项目</option>{projects.data?.map(p=><option key={p.id} value={p.id}>{p.name}</option>)}</select>{fieldError("projectScope")}</label></div><p className="text-sm text-muted-foreground">执行仓库、本机目录和 Git 工作树由本机 Harness 套件管理。</p><div className="space-y-3"><Button variant="outline" disabled={busy||rule.isLoading} onClick={()=>void verify()}>{busy?"正在处理…":"验证 Jira 连接并读取状态"}</Button><p className="text-xs text-muted-foreground">先填写地址和 PAT 读取 Jira 状态。工单是否符合范围，在平台派单时核验；此操作不会派单或执行。</p>{previewError&&<p role="alert" className="text-sm text-destructive">{previewError}</p>}{preview&&!currentPreview&&<p className="text-xs text-muted-foreground">查询条件已更改，请重新验证接单范围。</p>}{currentPreview&&<div className="space-y-2 rounded-md bg-muted p-3 text-sm"><p>连接成功 · {currentPreview.actorName} · {new Date(currentPreview.verifiedAt).toLocaleString()}</p>{currentPreview.matches?<><p>匹配 {currentPreview.matches.total} 个未完成工单（最多预览 10 个）</p>{currentPreview.matches.issues.map(i=><p key={i.key}><a href={`${form.jiraBaseUrl.replace(/\/$/,"")}/browse/${i.key}`} target="_blank" rel="noreferrer" className="underline">{i.key}</a> · {i.summary} · {localizedStatus(i.status)}</p>)}</>:<p>Jira 连接正常。具体工单将在平台派单时核验。</p>}</div>}</div>
<fieldset className="space-y-3 rounded-lg border border-border p-4">
 <legend className="px-2 font-medium">① 工单状态：什么时候允许执行？</legend>
 <p className="text-sm text-muted-foreground">选择工单允许被接收及继续执行的 Jira 状态，例如“待编码”“编码中”。请按团队实际流程选择，未完成但不在所选状态内的工单不会开工。</p>
 <div className="flex flex-wrap items-center justify-between gap-2"><span className="text-sm font-medium">已选 {readyStatuses.length} 个状态</span><Button type="button" variant="ghost" size="sm" disabled={busy||!readyStatuses.length} onClick={()=>changeStatuses([])}>清空状态</Button></div>
 {readyStatuses.length?<div className="flex flex-wrap gap-2" aria-label="已选择的工单状态">{readyStatuses.map(status=><Button key={status} type="button" variant="secondary" size="sm" disabled={busy} aria-label={"移除状态："+status} onClick={()=>changeStatuses(readyStatuses.filter(s=>s!==status))}>{status}<span aria-hidden="true">×</span></Button>)}</div>:<p className="text-sm text-muted-foreground">尚未选择状态。先验证 Jira 连接，再从下方选择。</p>}
 {fieldError("status")}
 {statusChoices.length>0?<><Input aria-label="搜索 Jira 工单状态" value={statusSearch} onChange={e=>{e.stopPropagation();setStatusSearch(e.target.value);}} placeholder="搜索状态，例如：编码、设计、修复"/><label className="flex w-fit cursor-pointer items-center gap-2 text-sm font-medium"><input type="checkbox" disabled={busy||!visibleStatuses.length} checked={allVisibleSelected} ref={node=>{if(node)node.indeterminate=selectedVisibleCount>0&&!allVisibleSelected;}} onChange={e=>{e.stopPropagation();selectVisibleStatuses(e.target.checked);}}/>{searchTerms.length?"全选搜索结果":"全选状态"}</label><p className="text-xs text-muted-foreground">{visibleStatuses.length} 个匹配状态 · 搜索时全选只影响匹配结果，保留其他已选状态。Jira 返回的状态可能包含其他项目的流程，请按当前项目选取。</p><div className="grid max-h-64 grid-cols-1 gap-2 overflow-y-auto rounded-md border border-border p-3 sm:grid-cols-2 lg:grid-cols-3" role="group" aria-label="可选择的 Jira 工单状态">{visibleStatuses.map(status=><label key={status} className="flex cursor-pointer items-start gap-2 rounded-md p-2 text-sm hover:bg-accent"><input className="mt-1 shrink-0" type="checkbox" disabled={busy||(!readyStatuses.includes(status)&&readyStatuses.length>=1000)} checked={readyStatuses.includes(status)} onChange={e=>changeStatuses(e.target.checked?[...readyStatuses,status]:readyStatuses.filter(s=>s!==status))}/><span className="break-words">{status}</span></label>)}{!visibleStatuses.length&&<p className="text-sm text-muted-foreground">没有匹配的状态，请换个关键词。搜索不会清除已选状态。</p>}</div></>:<p className="text-sm text-muted-foreground">点击上方“验证 Jira 连接并读取状态”获取真实状态。</p>}
 <details className="rounded-md bg-muted p-3"><summary className="cursor-pointer text-sm">高级：手工填写状态名称</summary><label className="mt-3 block text-sm">Jira 状态原名（逗号分隔）<Input disabled={busy} value={statuses} onChange={e=>setStatuses(e.target.value)} placeholder="待编码,编码中"/></label><p className="mt-2 text-xs text-muted-foreground">与上方复选框同步，填写 Jira 中的准确状态名称；无需重复填写。</p></details>
</fieldset>
<fieldset className="space-y-3 rounded-lg border border-border p-4">
 <legend className="px-2 font-medium">② 工单类型：允许 Agent 做哪些工作？</legend>
 <p className="text-sm text-muted-foreground">这是工单的类别，与上方流程状态不同。例如勾选“编码”，代表接收编码类工单；还必须同时满足所选状态、经办人和项目条件。</p>
 <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3">{types.map(t=><label key={t} className="flex cursor-pointer items-center gap-2 rounded-md p-2 text-sm hover:bg-accent"><input type="checkbox" disabled={busy} checked={form.issueTypes.includes(t)} onChange={e=>setForm({...form,issueTypes:e.target.checked?[...form.issueTypes,t]:form.issueTypes.filter(x=>x!==t)})}/>{t}</label>)}</div>
 <p className="text-xs text-muted-foreground">接口联调使用 Harness 的 dsp-integration-test 技能。已选 {form.issueTypes.length} 种类型：{form.issueTypes.length?form.issueTypes.join("、"):"尚未选择"}</p>{fieldError("types")}
</fieldset>
<div className="space-y-2 rounded-md bg-muted p-3" aria-label="当前接单范围摘要"><h4 className="text-sm font-medium">平台派单校验范围（保存后生效）</h4><p className="text-sm">接收由平台明确派发、属于 <strong>{form.jiraProjectKey||"尚未填写的项目"}</strong> 的工单；类型为 <strong>{form.issueTypes.length?form.issueTypes.join("、"):"尚未选择"}</strong>，并且状态为 <strong>{readyStatuses.length?readyStatuses.join("、"):"尚未选择"}</strong>。所有条件须同时满足。</p><p className="text-xs text-muted-foreground">{form.enabled?"平台自动执行已勾选：仍需在平台明确派单；在线空闲后执行。":"平台自动执行未启用：可仅登记，不能自动开工。"}完成工单和父需求不会执行。Jira 经办人只用于来源展示和统计，执行由平台选择的席位承担。</p></div>
<p className="text-xs text-muted-foreground">PAT 加密保存，不会回显；本机使用该配置查询和核验 Jira。默认约每分钟查询 Jira。离线时等待上线，忙碌时排队；多个席位可使用同一 Jira 统计账号，实际执行权由平台逐单派发。完成工单和父需求不会执行。Jira 经办人变化不停止执行；需求或授权规则变化时停止并保留证据，跨席位转交需核对旧执行权。阻塞提醒使用“通知”标签中配置的接收人；接收人应为席位负责人。</p>{projects.error&&<p role="alert" className="text-sm text-destructive">{projects.error.message}</p>}{rule.error&&<p role="alert" className="text-sm text-destructive">{rule.error.message}</p>}{message&&<p role="status" className="text-sm">{message}</p>}<Button disabled={busy||rule.isLoading||!!rule.error||projects.isPending||!!projects.error} onClick={()=>void save()}>{busy?"正在保存…":"保存 Jira 自动执行规则"}</Button>{dirty&&<span className="ml-3 text-xs text-muted-foreground">有未保存的更改</span>}</section>;
}
