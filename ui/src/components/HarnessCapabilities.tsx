import { Link } from "@/lib/router";
import { HarnessEnrollmentGuide } from "./HarnessEnrollmentGuide";
import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { HarnessCapabilityRegistry, HarnessCapabilityInput } from "@paperclipai/shared";
import type { SeatRuntime } from "@/api/dsp7-seats";
import { api } from "@/api/client";
import { Button } from "@/components/ui/button";

const labels: Record<HarnessCapabilityInput["roles"][number], string> = {
  "requirements-analysis": "需求分析",
  "system-design": "系统设计",
  coding: "编码",
  "bug-fix": "缺陷修复",
  "design-review":"设计评审", "test-case-review":"用例评审", "code-review": "代码评审",
  "test-cases": "测试用例",
  "functional-test": "功能测试",
};

export function HarnessCapabilities({ companyId, agentId, canConfigure = false, active = true, defaultRoot, runtime }: { companyId: string; agentId: string; canConfigure?: boolean; active?: boolean; defaultRoot?: string; runtime?: SeatRuntime | null }) {
  const [enrolling, setEnrolling] = useState<HarnessCapabilityInput["kind"] | null>(null);
  const qc=useQueryClient();const [busy,setBusy]=useState(false);const [error,setError]=useState("");const [message,setMessage]=useState("");
  const query = useQuery({
    queryKey: ["harness-capabilities", companyId, agentId],
    queryFn: () => api.get<HarnessCapabilityRegistry>(`/companies/${companyId}/dsp7-seats/${agentId}/harness-capabilities`),
    enabled: active,
    refetchInterval: active ? 5000 : false,
    refetchIntervalInBackground: false,
  });
  async function selectRoute(kind: HarnessCapabilityInput["kind"], capabilityId: string) {
    if(!query.data)return;setBusy(true);setError("");setMessage("");
    try { const result=await api.put<HarnessCapabilityRegistry>(`/companies/${companyId}/dsp7-seats/${agentId}/harness-routing`,{kind,capabilityId,expectedRevision:query.data.revision});qc.setQueryData(["harness-capabilities",companyId,agentId],result);setMessage("路由已保存；不会切换运行中的任务或自动派单。"); }
    catch(e){setError(e instanceof Error?e.message:"保存失败，请刷新后重试");}finally{setBusy(false);}
  }
  return (
    <section className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-3"><h3 className="font-medium">本机 Harness 能力</h3><Button type="button" variant="outline" disabled={query.isFetching} onClick={() => void query.refetch()}>刷新能力登记</Button></div>
      <p className="text-xs text-muted-foreground">本机登记后约 5 秒更新。展开查看完整路径、技能与版本；登记不等于执行授权。</p>
      {query.isPending && <p className="text-sm" role="status">正在加载能力登记…</p>}
      {query.isError && <p role="alert" className="text-sm text-destructive">能力登记刷新失败，以下若有数据为上次读取结果。请点击“刷新能力登记”重试。</p>}
      {query.data && <>
        <p className="text-xs text-muted-foreground">能力登记版本：{query.data.revision}</p>
        {(["development", "analysis", "qa"] as const).map(kind => {
          const items = query.data!.items.filter(item => item.kind === kind);
          const selected = query.data!.routing?.[kind] ?? (items.length === 1 ? items[0].id : undefined);
          const title = { development: "研发 Harness", analysis: "需求分析 Harness", qa: "测试 Harness" }[kind];
          return <section key={kind} className="space-y-3 rounded-md border border-border p-4" aria-label={title}>
            <div className="flex items-start justify-between gap-3">
              <h4 className="min-w-0 font-medium">{title} · {items.length ? `已登记 ${items.length} 个套件` : kind === "development" ? "沿用默认研发目录" : "尚未登记"}</h4>
              {canConfigure && <Button type="button" size="sm" variant="outline" className="shrink-0" aria-label={`${items.length || (kind === "development" && defaultRoot) ? "更新登记" : "登记"}${title}`} aria-expanded={enrolling === kind} aria-controls={`harness-enrollment-${agentId}-${kind}`} onClick={() => setEnrolling(enrolling === kind ? null : kind)}>{enrolling === kind ? "收起" : items.length || (kind === "development" && defaultRoot) ? "更新登记" : "登记"}</Button>}
            </div>
            <p className="truncate font-mono text-xs text-muted-foreground" title={items.find(item => item.id === selected)?.root ?? (kind === "development" ? defaultRoot : undefined)}>{items.find(item => item.id === selected)?.root ?? (kind === "development" ? defaultRoot : undefined) ?? (items.length > 1 ? "多个套件，请展开核对并指定路由" : "尚未选择本机目录")}</p>
            {canConfigure && enrolling === kind && <div id={`harness-enrollment-${agentId}-${kind}`}><HarnessEnrollmentGuide key={kind} agentId={agentId} fixedKind={kind} /></div>}
            {kind === "development" && !items.length && defaultRoot && <details className="text-sm"><summary className="cursor-pointer">查看套件详情</summary><div className="mt-3 space-y-3" aria-label="默认研发 Harness 套件详情">
              <p className="font-medium">默认研发目录 · 来自设备登记</p>
              <dl className="grid gap-3 break-all text-sm md:grid-cols-2">
                <div><dt className="text-muted-foreground">Harness 根目录</dt><dd className="font-mono">{defaultRoot}</dd></div>
                <div><dt className="text-muted-foreground">Claude 命令</dt><dd className="font-mono">{runtime?.claudeCommand ?? "未登记"}</dd></div>
                <div><dt className="text-muted-foreground">Claude 版本</dt><dd>{runtime?.claudeVersion ?? "未登记"}</dd></div>
                <div><dt className="text-muted-foreground">Claude 配置来源</dt><dd className="font-mono">{runtime?.claudeSettingsFile ?? "Claude 本机默认配置"}</dd></div>
                <div><dt className="text-muted-foreground">设备登记版本</dt><dd>{runtime?.revision ?? "未登记"}</dd></div>
                <div><dt className="text-muted-foreground">最近设备登记／检查</dt><dd>{runtime?.checkedAt ? new Date(runtime.checkedAt).toLocaleString() : "未登记"}</dd></div>
              </dl>
              <p className="text-xs text-muted-foreground">当前沿用设备登记的研发目录。共享仓库、技能清单、Git 版本及文件摘要尚未通过能力登记上报；更新登记后可查看。启动任务时仍会核验本机配置与执行权限。</p>
            </div></details>}
            {items.length > 0 && <details className="text-sm"><summary className="cursor-pointer">查看套件详情（{items.length}）</summary><div className="mt-3 space-y-4">
            {items.map(capability => <article key={capability.id} className="space-y-3" aria-label={`${title} 套件详情`}>
              <p className="text-sm font-medium">{capability.id === selected ? "当前默认套件" : "已登记套件"} · {capability.profile}</p>
              <dl className="grid gap-3 break-all text-sm md:grid-cols-2">
                <div><dt className="text-muted-foreground">Harness 根目录</dt><dd className="font-mono">{capability.root}</dd></div>
                <div><dt className="text-muted-foreground">共享仓库</dt><dd>{capability.repository}</dd></div>
                <div><dt className="text-muted-foreground">套件配置（profile）</dt><dd>{capability.profile}</dd></div>
                <div><dt className="text-muted-foreground">已识别技能</dt><dd>{capability.roles.map(role => labels[role]).join("、")}</dd></div>
                <div><dt className="text-muted-foreground">Git 版本</dt><dd className="font-mono">{capability.commit}</dd></div>
                <div><dt className="text-muted-foreground">最近登记／本机文件检查</dt><dd>{new Date(capability.checkedAt).toLocaleString()}</dd></div>
              </dl>
              <p className="text-xs text-muted-foreground">本机文件校验已通过；启动仍会复核文件及执行权限。{kind === "qa" ? "测试用例和功能测试由条目自动交付流程授权派发，需新版客户端。" : kind === "analysis" ? "需求分析需新版客户端及独立派发授权。" : "沿用研发执行授权。"}</p>
              <details className="text-xs text-muted-foreground"><summary className="cursor-pointer">能力标识与文件摘要</summary><p className="break-all font-mono">{capability.id}</p><p className="break-all font-mono">{capability.manifestDigest}</p></details>
            </article>)}            </div></details>}

          </section>;
        })}
      </>}
      {canConfigure&&query.data&&(["analysis","development","qa"] as const).map(kind=>{
        const items=query.data!.items.filter(item=>item.kind===kind);if(items.length < 2)return null;
        const selected=query.data!.routing?.[kind]??(items.length===1?items[0].id:"");
        return <label key={kind} className="block space-y-2 text-sm">{{analysis:"需求分析",development:"研发",qa:"测试"}[kind]} Harness 路由<select aria-label={`${kind} Harness 路由`} className="block w-full rounded-md border border-border bg-background p-2" value={selected} disabled={busy} onChange={e=>void selectRoute(kind,e.target.value)}><option value="" disabled>请选择该领域的 Harness</option>{items.map(item=><option key={item.id} value={item.id}>{item.repository} · {item.profile}</option>)}</select></label>;
      })}
      {error&&<p role="alert" className="text-sm text-destructive">{error}</p>}{message&&<p role="status" className="text-sm">{message}</p>}
      <Link to="/help?section=harness-registration" className="inline-flex text-sm text-muted-foreground underline underline-offset-4 hover:text-foreground">登记遇到问题？</Link>
    </section>
  );
}
