import type { Meta, StoryObj } from "@storybook/react-vite";
import { useEffect, useState } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { CompactIssue, DeliveryEntryDetail, Project } from "@paperclipai/shared";
import type { RegisteredSeat } from "@/api/dsp7-seats";
import { queryKeys } from "@/lib/queryKeys";
import { managementRows } from "@/lib/management-work";
import { ManagementWorkItem } from "@/components/ManagementWorkItem";
import { CollaborationWorkbench } from "@/components/CollaborationWorkbench";
import { DeliveryMaterials } from "@/components/DeliveryMaterials";
import { ProjectReadiness } from "@/components/ProjectReadiness";
import { DeliveryMonthlyBoard } from "@/components/DeliveryMonthlyBoard";

const companyId = "company-management-story";
const project = { id: "project-management-story", companyId, name: "DSP7 银企直联", urlKey: "dsp7", workspaces: [{ repoUrl: "https://gitlab.example.com/dsp7/harness.git", repoRef: "main" }] } as unknown as Project;
const task = { id: "task-management-story", identifier: "DSP-491887", companyId, title: "支付权限核验与异常恢复", status: "in_progress", projectId: project.id, assigneeAgentId: "seat-management-story", assigneeUserId: null, updatedAt: new Date(), originKind: "issue" } as unknown as CompactIssue;
const seat = { agentId: "seat-management-story", name: "研发 Windows 电脑", owner: { id: "management-user", name: "研发负责人" }, isMine: true, online: true, usable: true, runtime: { revision: 1 }, dispatch: null, presence: { state: "idle", activeTaskId: null, lastSeenAt: new Date().toISOString(), checks: [], tasks: [{ taskId: task.id, status: "interrupted", stoppedRunId: "previous-run" }], alerts: [{ id: "attention", taskId: task.id, message: "运行已中断，请核对停止依据与恢复条件。", elapsedMinutes: 20 }] } } as unknown as RegisteredSeat;
const tasks = [task, { ...task, id: "running-task", identifier: "DSP-491888", title: "银行接口回归验证", assigneeAgentId: null }, { ...task, id: "planned-task", identifier: "DSP-491889", title: "安排下一阶段开发", status: "todo" as const, assigneeAgentId: null }];
const entry = { snapshot: { id: "snapshot-management", projectId: project.id, collectedAt: new Date().toISOString() }, analyses: [] } as unknown as DeliveryEntryDetail;

function Fixture({ children }: { children: React.ReactNode }) {
  const [client] = useState(() => {
    const qc = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity, retry: false } } });
    qc.setQueryData(queryKeys.auth.session, { user: { id: "management-user" } });
    qc.setQueryData(queryKeys.health, { deploymentMode: "local_trusted" });
    qc.setQueryData([...queryKeys.issues.list(companyId), "management-compact", undefined, ""], { pages: [tasks], pageParams: [""] });
    qc.setQueryData(["dsp7-registered-seats", companyId], [seat]);
    qc.setQueryData(queryKeys.liveRuns(companyId), [{ issueId: "running-task", status: "running" }]);
    qc.setQueryData(queryKeys.access.companyUserDirectory(companyId), { users: [] });
    qc.setQueryData(["delivery-connection", companyId, project.id], null);
    return qc;
  });
  useEffect(() => {
    const original = window.fetch;
    window.fetch = async (input, init) => {
      const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url, window.location.origin);
      if (url.pathname.startsWith(`/api/companies/${companyId}/`)) {
        if (url.pathname.endsWith("/dsp7-seats")) return Response.json([seat]);
        if (url.pathname.endsWith("/live-runs")) return Response.json([{ issueId: "running-task", status: "running" }]);
        if (url.pathname.includes("/issues")) return Response.json(tasks);
        if (url.pathname.endsWith("/delivery-connections")) return Response.json(null);
        if (url.pathname.includes("user-directory")) return Response.json({ users: [] });
        return Response.json({ error: "交互示例不执行服务端操作" }, { status: 400 });
      }
      return original(input, init);
    };
    return () => { window.fetch = original; client.clear(); };
  }, [client]);
  return <QueryClientProvider client={client}><div className="mx-auto max-w-7xl space-y-6 p-4">{children}</div></QueryClientProvider>;
}
function ManagementSurface({ surface = "overview" }: { surface?: "overview" | "item" | "materials" | "readiness" | "monthly" }) {
  return <Fixture>{surface === "overview" ? <CollaborationWorkbench companyId={companyId} projects={[project]} pendingApprovals={2} /> : surface === "item" ? <ManagementWorkItem row={managementRows([task], [seat], new Set())[0]} userNames={new Map()} /> : surface === "materials" ? <DeliveryMaterials companyId={companyId} detail={entry} /> : surface === "readiness" ? <ProjectReadiness project={project} /> : <MonthlyFixture />}</Fixture>;
}
function MonthlyFixture() {
  const [client] = useState(() => {
    const qc = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity, retry: false } } });
    qc.setQueryData(["delivery-connection", companyId, project.id], { revision: 1, credentialsConfigured: true });
    const now = new Date(), month = `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,"0")}`;
    qc.setQueryData(["delivery-monthly", companyId, project.id, 1, month], { month, collectedAt: now.toISOString(), items: Array.from({ length: 25 }, (_, i) => ({ demandNo: `DSP-${i+1}`, title: "银行接口交付验证", owner: i === 24 ? "" : "研发负责人", sourceStatus: "开发中", startDate: `${month}-01`, endDate: `${month}-28`, snapshotId: `snapshot-${i}`, admission: null, workCount: 2 })) });
    return qc;
  });
  return <QueryClientProvider client={client}><p className="text-sm text-muted-foreground">交互示例：可筛选、排序与翻页；同步操作需真实服务端。</p><DeliveryMonthlyBoard companyId={companyId} projectId={project.id} canManage /></QueryClientProvider>;
}
const meta = { title: "Management/Operational overview", component: ManagementSurface, parameters: { layout: "fullscreen" } } satisfies Meta<typeof ManagementSurface>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Overview: Story = {};
export const AttentionItem: Story = { args: { surface: "item" } };
export const MissingMaterials: Story = { args: { surface: "materials" } };
export const ProjectConfiguration: Story = { args: { surface: "readiness" } };
export const MonthlyRisks: Story = { args: { surface: "monthly" } };
export const Mobile: Story = { globals: { viewport: { value: "mobile", isRotated: false } } };
