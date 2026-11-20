import type { Meta, StoryObj } from "@storybook/react-vite";
import { SeatQingzhouAccountForm } from "@/components/SeatQingzhouAccount";

const meta: Meta<typeof SeatQingzhouAccountForm> = {
  title: "Seats/Qingzhou Account", component: SeatQingzhouAccountForm,
  args: { account: { seatId: "seat", username: null, configured: false, revision: 0, lastCheckStatus: "not_checked", lastCheckedAt: null, updatedAt: null }, busy: false, onSave: () => {}, onCheck: () => {}, onRemove: () => {} },
  decorators: [Story => <div className="max-w-3xl p-6"><Story/></div>],
};
export default meta;
type Story = StoryObj<typeof SeatQingzhouAccountForm>;
export const Unconfigured: Story = {};
export const Configured: Story = { args: { account: { ...meta.args!.account!, username: "seat-analyst", configured: true, revision: 1, lastCheckStatus: "valid" } } };
export const Failed: Story = { args: { ...Configured.args, error: "轻舟认证未就绪，请检查席位账号和密码" } };
export const Busy: Story = { args: { ...Configured.args, busy: true } };
