import type { Meta, StoryObj } from "@storybook/react-vite";
import type { AnalysisExecution } from "@paperclipai/shared";
import { AnalysisQingzhouWriteback } from "@/components/AnalysisQingzhouWriteback";

const execution = {
  id: "analysis-example",
  demandNo: "ATS3-00156",
  delivery: { inputDigest: "a".repeat(64) },
  qingzhouWriteback: { status: "pending" },
} as AnalysisExecution;

const meta: Meta<typeof AnalysisQingzhouWriteback> = {
  title: "Delivery/Analysis Qingzhou Writeback",
  component: AnalysisQingzhouWriteback,
  args: { execution, canManage: true, busy: false, onRetry: () => {} },
  decorators: [Story => <div className="max-w-3xl p-6"><Story/></div>],
};
export default meta;
type Story = StoryObj<typeof AnalysisQingzhouWriteback>;
export const Pending: Story = { args: { execution: { ...execution, delivery: null } } };
export const Failed: Story = { args: { execution: { ...execution, qingzhouWriteback: { status: "failed", error: "轻舟拒绝保存，请核对执行席位的轻舟账号是否为条目分析负责人及条目状态", options: { workGenerality: "2", workHour: "3" } } } } };
export const Saved: Story = { args: { execution: { ...execution, qingzhouWriteback: { status: "saved", savedAt: "2026-11-10T06:00:00Z" } } } };
export const MemberReadOnly: Story = { args: { ...Failed.args, canManage: false } };
