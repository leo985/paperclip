import { expect, it } from "vitest";
import { compareDeliveryPriority, deliveryCounts, groupDeliveryEmployees, groupDeliveryMainIssues, matchesDeliveryFilter, needsDeliveryAttention, type DashboardIssue } from "./delivery-dashboard";

function issue(id: string, seatIds: string[], risk: DashboardIssue["risk"], interrupted = false): DashboardIssue {
  return {
    id, seatIds, risk, interrupted, key: "DEMO-" + id, parentKey: "DEMO-0", issueType: "功能测试", title: "", status: "", completed: risk === "done", inMonth: risk !== "unscheduled",
    dueDate: risk === "unscheduled" ? null : "2026-11-19", deadlineSource: null,
    projectId: "project", projectName: "Project", demandNo: "DEMO", snapshotId: "snapshot", collectedAt: "2026-11-19T00:00:00Z",
  };
}

it("deduplicates seats owned by one employee while preserving independent employees with the same name", () => {
  const shared = issue("1", ["a", "b", "c"], "done");
  const missing = issue("2", ["d"], "unscheduled");
  const report = groupDeliveryEmployees([
    { id: "a", name: "A", ownerUserId: "first", ownerName: "同名" },
    { id: "b", name: "B", ownerUserId: "first", ownerName: "同名" },
    { id: "c", name: "C", ownerUserId: "second", ownerName: "同名" },
    { id: "d", name: "D", ownerUserId: null, ownerName: null },
  ], [shared, missing]);
  expect(report.employees.map(person => [person.id, person.seats, person.issues]))
    .toEqual([["user:first", ["A", "B"], [shared]], ["user:second", ["C"], [shared]]]);
  expect(report.unassigned.issues).toEqual([missing]);
  expect(deliveryCounts([shared, missing])).toMatchObject({ total: 1, done: 1, unscheduled: 1 });
});

it("prioritizes overdue and interrupted work without counting overlapping risks twice in the queue", () => {
  const items = [
    issue("1", [], "due_soon"), issue("2", [], "overdue", true),
    { ...issue("3", [], "unscheduled", true), inMonth: true }, issue("4", [], "on_track"),
  ];
  expect(items.filter(needsDeliveryAttention).sort(compareDeliveryPriority).map(item => item.id)).toEqual(["2", "3", "1"]);
  expect(deliveryCounts(items)).toMatchObject({ total: 4, overdue: 1, due_soon: 1, interrupted: 2 });
});

it("counts Jira completions within the project's monthly scope even when the child has no deadline", () => {
  const done = { ...issue("1", [], "unscheduled"), inMonth: true, completed: true };
  const pending = { ...issue("2", [], "unscheduled"), inMonth: true };
  const unknown = issue("3", [], "unscheduled");
  expect(deliveryCounts([done, pending, unknown])).toMatchObject({ total: 2, done: 1, waiting_for_deadline: 1, unscheduled: 3 });
});

it("keeps a main issue's children together and orders groups by their most urgent child", () => {
  const items = [
    { ...issue("1", [], "done"), parentKey: "DEMO-A" },
    { ...issue("2", [], "due_soon"), parentKey: "DEMO-B" },
    { ...issue("3", [], "overdue"), parentKey: "DEMO-A" },
  ];
  expect(groupDeliveryMainIssues(items).map(group => [group.parentKey, group.issues.map(child => child.id)]))
    .toEqual([["DEMO-A", ["3", "1"]], ["DEMO-B", ["2"]]]);
  expect(items.map(item => item.id)).toEqual(["1", "2", "3"]);
  const filtered = items.filter(item => matchesDeliveryFilter(item, "remaining", new Set()));
  expect(groupDeliveryMainIssues(filtered).map(group => group.issues.map(child => child.id)))
    .toEqual([["3"], ["2"]]);
});

it("isolates identical parent keys across projects and explicitly groups missing parents per project", () => {
  const items = [
    issue("1", [], "done"),
    { ...issue("2", [], "done"), projectId: "other" },
    { ...issue("3", [], "done"), parentKey: "" },
    { ...issue("4", [], "done"), parentKey: "  " },
    { ...issue("5", [], "done"), parentKey: "", projectId: "other" },
  ];
  const groups = groupDeliveryMainIssues(items);
  expect(groups.map(group => [group.parentKey, group.issues.map(child => child.id)]))
    .toEqual([["DEMO-0", ["1"]], ["DEMO-0", ["2"]], [null, ["3", "4"]], [null, ["5"]]]);
  expect(new Set(groups.map(group => group.id)).size).toBe(4);
  expect(groupDeliveryMainIssues([])).toEqual([]);
});
