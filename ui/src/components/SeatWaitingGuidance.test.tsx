import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { describe, expect, it } from "vitest";
import { SeatWaitingGuidance } from "./SeatWaitingGuidance";

const companyId = "bf49caa4-5d09-4f5c-b6ae-a5d80b90a5e8";
const runId = "eb8982a1-e647-4830-ba73-e0a042b3c846";
function render({ online = true, activeTaskId = "task", alertTaskId = "task", alertId = `${runId}:native:permission`, selectedRun = runId } = {}) {
  const cache = new QueryClient();
  cache.setQueryData(["dsp7-registered-seats", companyId], [{
    agentId: "seat", name: "研发电脑", online,
    presence: { state: "waiting_decision", activeTaskId, runId, alerts: [{ id: alertId, taskId: alertTaskId, message: "Claude 正在等待确认权限" }] },
  }]);
  return renderToStaticMarkup(<QueryClientProvider client={cache}><SeatWaitingGuidance companyId={companyId} taskId="task" seatId="seat" runId={selectedRun} /></QueryClientProvider>);
}
describe("native Claude wait guidance", () => {
  it("routes a live native wait to its computer and exact organization/run", () => {
    const html = render();
    expect(html).toContain("等待本机 Claude 处理 · 研发电脑");
    expect(html).toContain("网页评论和会话记录不能代替终端操作");
    expect(html).toContain(`harness --company ${companyId} attach-run ${runId}`);
    expect(html).not.toContain("<button");
  });
  it.each([
    { online: false }, { activeTaskId: "other-task" }, { alertTaskId: "other-task" },
    { alertId: "ATSES-123:confirmation" }, { alertId: "other-run:native:permission" },
    { selectedRun: "historical-run" },
  ])("does not turn unrelated, historical or business waits into native controls: %j", options => {
    expect(render(options)).toBe("");
  });
});
