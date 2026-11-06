import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { Project } from "@paperclipai/shared";
import { dsp7SeatsApi } from "@/api/dsp7-seats";
import { jiraRequirementsApi } from "@/api/jira-requirements";
import { useNavigate } from "@/lib/router";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
export const requirementModeLabels = { development: "研发 Harness", "human-review": "人工评审", "harness-linked": "随编码交付，不另派单", qa: "测试 Harness", unmapped: "待配置映射" };
export function JiraRequirementIntake({ project }: { project: Project }) {
  return <RequirementIntakeForm key={project.id} project={project} />;
}
function RequirementIntakeForm({ project }: { project: Project }) {
  const navigate = useNavigate(); const cache = useQueryClient();
  const [key, setKey] = useState(""); const [seatId, setSeatId] = useState(""); const [ownerId, setOwnerId] = useState("");
  const seats = useQuery({ queryKey: ["dsp7-registered-seats", project.companyId], queryFn: () => dsp7SeatsApi.list(project.companyId) });
  const connections = (seats.data ?? []).filter(seat => seat.dispatch?.jiraPatConfigured);
  const connection = seatId || (connections.length === 1 ? connections[0].agentId : "");
  const preview = useMutation({ mutationFn: () => jiraRequirementsApi.preview(project.companyId, connection, { jiraKey: key.trim().toUpperCase(), projectId: project.id }), onSuccess: result => setOwnerId(result.ownerUserId ?? "") });
  const snapshot = preview.data;
  const valid = snapshot?.key === key.trim().toUpperCase() && !preview.isPending;
  const importPlan = useMutation({ mutationFn: () => jiraRequirementsApi.import(project.companyId, connection, { jiraKey: snapshot!.key, projectId: project.id, fingerprint: snapshot!.fingerprint, ...(ownerId ? { ownerUserId: ownerId } : {}) }), onSuccess: async result => { await cache.invalidateQueries({ queryKey: ["issues"] }); navigate(`/issues/${result.taskId}`); } });
  function changed() { preview.reset(); importPlan.reset(); setOwnerId(""); }
  return <section className="space-y-4 rounded-lg border border-border p-4">
    <div><h2 className="text-lg font-semibold">接入 Jira 主需求</h2><p className="text-sm text-muted-foreground">统一管理设计、开发与测试子工单。接入只建立需求关系，不会启动 Agent 或改变 Jira 状态。</p></div>
    <label className="block space-y-1 text-sm">主需求编号<Input value={key} onChange={event => { setKey(event.target.value); changed(); }} placeholder="ATSES-513244" /></label>
    <label className="block space-y-1 text-sm">用于读取 Jira 的连接<select aria-label="Jira 读取连接" className="block w-full rounded-md border border-border bg-background p-2" value={connection} onChange={event => { setSeatId(event.target.value); changed(); }}><option value="">请选择已配置 Jira PAT 的席位连接</option>{connections.map(seat => <option key={seat.agentId} value={seat.agentId}>{seat.name}</option>)}</select></label>
    <p className="text-xs text-muted-foreground">此席位只提供已有 Jira 连接，不代表它将执行全部子工单；执行席位按各子工单负责人分别匹配。</p>
    {seats.isError && <p role="alert" className="text-sm text-destructive">读取连接失败，请刷新重试。</p>}
    {!seats.isPending && !connections.length && <p className="text-sm text-muted-foreground">请先在席位接单设置中配置 Jira PAT。</p>}
    <Button variant="outline" disabled={!connection || !/^[A-Z][A-Z0-9_]*-\d+$/.test(key.trim().toUpperCase()) || preview.isPending || importPlan.isPending} onClick={() => preview.mutate()}> {preview.isPending ? "正在读取主子工单…" : "预览主需求及子工单"}</Button>
    {preview.error && <p role="alert" className="text-sm text-destructive">{preview.error.message}</p>}
    {snapshot && valid && <div className="space-y-3">
      <h3 className="font-medium">{snapshot.key} · {snapshot.summary}</h3>
      <p className="text-sm">研发负责人：{snapshot.owner?.name ?? "Jira 字段缺失或不唯一"} · Jira 状态：{snapshot.status}</p>
      {snapshot.owner && !snapshot.ownerUserId && <label className="block space-y-1 text-sm">关联研发负责人账号（不能用经办人替代）<select className="block w-full rounded-md border border-border bg-background p-2" value={ownerId} onChange={event => setOwnerId(event.target.value)}><option value="">请选择对应的组织成员</option>{snapshot.members.map(member => <option key={member.id} value={member.id}>{member.name} · {member.email}</option>)}</select></label>}
      <div className="overflow-x-auto"><table className="w-full text-left text-sm"><thead><tr className="border-b border-border"><th className="p-2">子工单</th><th className="p-2">类型与执行方式</th><th className="p-2">负责人／席位</th><th className="p-2">Jira 状态</th></tr></thead><tbody>{snapshot.children.map(child => <tr key={child.key} className="border-b border-border"><td className="p-2">{child.key}<p className="text-xs text-muted-foreground">{child.summary}</p></td><td className="p-2">{child.issueType}<p>{requirementModeLabels[child.mode]}</p></td><td className="p-2">{child.assignee?.name ?? "Jira 未指派"}<p className="text-xs text-muted-foreground">{!child.userId ? "平台账号待关联" : child.mode !== "development" ? "按对应流程处理" : child.seats.length === 1 ? child.seats[0].name : child.seats.length > 1 ? "多个席位，派单时选择" : "暂无符合项目规则的席位"}</p></td><td className="p-2">{child.status}</td></tr>)}</tbody></table></div>
      <p className="text-xs text-muted-foreground">代码评审的范围、报告、提交版本与独立 Tracker 回执由研发 Harness 核验；同父关系不代表评审已完成。测试用例编写和功能测试保留各自真实工单号。</p>
      <Button disabled={!ownerId || !snapshot.owner || importPlan.isPending} onClick={() => importPlan.mutate()}>{importPlan.isPending ? "正在接入…" : `确认接入主需求与 ${snapshot.children.length} 张子工单`}</Button>
      {importPlan.error && <p role="alert" className="text-sm text-destructive">{importPlan.error.message}</p>}
    </div>}
  </section>;
}
