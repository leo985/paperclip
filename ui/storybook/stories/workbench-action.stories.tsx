import type { Meta, StoryObj } from "@storybook/react-vite";
import { WorkbenchActionCard } from "@/pages/Workbench";

const meta: Meta<typeof WorkbenchActionCard> = {
  title: "Delivery/Workbench Action",
  component: WorkbenchActionCard,
  args: {
    returnHref: "/dashboard?tab=pending",
    userNames: new Map([["reviewer", "李巍"]]),
    action: { id: "review", kind: "review", title: "TWGF-00919 需求分析", reason: "当前版本分析材料已上传，请核对业务场景、开发范围和验收要求。", actionLabel: "评审分析结果", href: "/issues/analysis-example", ownerUserId: "reviewer", createdAt: "2026-11-12T06:00:00Z" },
  },
  decorators: [Story => <div className="max-w-3xl p-6"><Story /></div>],
};
export default meta;
type Story = StoryObj<typeof WorkbenchActionCard>;
export const Review: Story = {};
export const Question: Story = { args: { action: { ...meta.args!.action!, id: "question", kind: "question", reason: "当前规则是否适用于所有账户？请确认业务范围。", actionLabel: "回答业务问题" } } };
export const UnassignedOrganizationAction: Story = { args: { action: { ...meta.args!.action!, id: "assignment", kind: "assignment", ownerUserId: null, reason: "任务尚未指定负责人，请组织管理员安排。", actionLabel: "安排任务负责人" } } };
