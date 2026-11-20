import type { agents } from "@paperclipai/db";
import { expect, it } from "vitest";
import { fixture } from "./delivery-intake.fixture.js";
import { normalizeDeliverySnapshot } from "./delivery-intake.js";
import { collectSeatMonthlyIssues } from "./seat-monthly-report.js";

const origin = "https://jira.example.test";
function seat(id: string, ownerUserId: string, account?: string, configured = true) {
  return {
    id,
    adapterConfig: {
      dsp7Seat: { ownerUserId },
      ...(account ? { dsp7JiraDispatch: { ownerUserId, jiraBaseUrl: origin, jiraAssignee: account, jiraSecretId: configured ? "stored-reference" : undefined } } : {}),
    },
  } satisfies Pick<typeof agents.$inferSelect, "id" | "adapterConfig">;
}

function report(seats: ReturnType<typeof seat>[], directory: { username: string; userId: string }[], visibleSeatIds = seats.map(s => s.id)) {
  const input = fixture();
  const plan = normalizeDeliverySnapshot(input, "online_readonly");
  const attribution = plan.monthlyChildIssues!;
  attribution.jiraOrigin = origin;
  Object.assign(attribution.issues["ATSES-3"]!, { dueDate: "2026-11-26", account: "assignee", ownerAccount: "rd-owner" });
  return collectSeatMonthlyIssues([{
    id: "snapshot", projectId: input.projectId, projectName: "项目", demandNo: input.demandNo,
    collectedAt: new Date(input.collectedAt), plan,
  }], [], seats, new Set(visibleSeatIds), false, "2026-11", "2026-11-19", directory);
}

it("attributes either Jira role to a unique employee and groups that employee's seats", () => {
  const seats = [seat("a", "one", "assignee"), seat("b", "one"), seat("c", "two")];
  const directory = [{ username: "rd-owner", userId: "two" }];
  expect(report(seats, directory)[0]?.seatIds).toEqual(["a", "b", "c"]);
  expect(report(seats, directory, ["c"])[0]?.seatIds).toEqual(["c"]);
});

it("ignores accounts shared by different employees and the old rule retained after a seat transfer", () => {
  const seats = [seat("a", "one", "assignee"), seat("b", "two", "assignee"), seat("c", "three", "rd-owner", false)];
  expect(report(seats, [])).toEqual([]);
});
