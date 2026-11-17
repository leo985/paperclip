import { describe, expect, it } from "vitest";
import { harnessObservationSchema, parseBoundHarnessObservation } from "./harness-observation.js";
import { managedEventSchema, managedMetadataSchemas } from "./managed-sessions.js";
export const summary = {
  schema: "harness.v2.observation-summary/1", runId: "10000000-0000-4000-8000-000000000001",
  companyId: "10000000-0000-4000-8000-000000000002", taskId: "10000000-0000-4000-8000-000000000003",
  streamId: "stream-1", sourceDigest: "a".repeat(64), resourceDigest: "b".repeat(64),
  observedEvents: 3, droppedEvents: 0, observedSessionEnd: false, pendingObservedCalls: 0,
  hostSessionConfirmed: false, processExitConfirmed: false, platformAccepted: false, durationMinutes: null,
};
describe("Harness observation private protocol", () => {
  it("accepts only the new metadata event with matched scope", () => {
    expect(parseBoundHarnessObservation(summary, summary, "harness:stream-1")).toEqual(summary);
    expect(managedMetadataSchemas["harness.observation"].safeParse(summary).success).toBe(true);
    expect(managedMetadataSchemas.observation.safeParse(summary).success).toBe(false);
    expect(managedEventSchema.shape.eventType.parse("harness.observation")).toBe("harness.observation");
  });
  it("rejects foreign run/company/task/stream and arbitrary content", () => {
    for (const key of ["companyId", "runId", "taskId"] as const) {
      expect(() => parseBoundHarnessObservation(summary, { ...summary, [key]: "foreign" }, "harness:stream-1")).toThrow();
    }
    expect(() => parseBoundHarnessObservation(summary, summary, "collector")).toThrow();
    expect(harnessObservationSchema.safeParse({ ...summary, prompt: "private" }).success).toBe(false);
  });
  it("rejects fabricated timing, completion authority and invalid coverage", () => {
    for (const bad of [{durationMinutes: 1}, {platformAccepted:true}, {processExitConfirmed:true},
      {hostSessionConfirmed:true}, {observedEvents:513}, {droppedEvents:1}, {pendingObservedCalls:4}]) {
      expect(harnessObservationSchema.safeParse({...summary,...bad}).success).toBe(false);
    }
  });
});
