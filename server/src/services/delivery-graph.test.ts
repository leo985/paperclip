import { describe, it, expect } from "vitest";
import {
  readyDeliveryStages,
  assertDeliveryGraph,
  deliveryAncestors,
  deliveryStageCanStart,
} from "./delivery-graph.js";
import { nextDeliveryAction } from "./delivery-workflows.js";
import {
  DEFAULT_DELIVERY_TEMPLATE,
  deliveryTemplateDefinitionSchema,
} from "@paperclipai/shared";
import type { DeliveryStageRecord } from "@paperclipai/shared";
const stage = (taskId: string, dependsOn: string[], state = "pending") =>
  ({ taskId, dependsOn, state }) as DeliveryStageRecord;
describe("configurable delivery fork/join", () => {
  it("automatically installs the agreed design review and parallel coding default", () => {
    expect(DEFAULT_DELIVERY_TEMPLATE.stages.analysis.enabled).toBe(false);
    expect(DEFAULT_DELIVERY_TEMPLATE.stages.design.review).toBe("seat_owner");
    expect(DEFAULT_DELIVERY_TEMPLATE.codingExecution).toBe("parallel");
    expect(DEFAULT_DELIVERY_TEMPLATE.stages["test-cases"].review).toBe("seat_owner");
  });
  it("holds both coding branches for design approval and joins all coding before QA", () => {
    const stages = [
      stage("design", [], "review"),
      stage("front", ["design"]),
      stage("back", ["design"]),
      stage("cases", ["front", "back"]),
      stage("test", ["cases"]),
    ];
    assertDeliveryGraph(stages);
    expect(readyDeliveryStages(stages).map((s) => s.taskId)).toEqual([
      "design",
    ]);
    stages[0].state = "done";
    expect(readyDeliveryStages(stages).map((s) => s.taskId)).toEqual([
      "front",
      "back",
    ]);
    stages[1].state = "done";
    stages[2].state = "interrupted";
    expect(nextDeliveryAction(stages)).toBe("wait");
    stages[2].state = "done";
    expect(readyDeliveryStages(stages).map((s) => s.taskId)).toEqual(["cases"]);
    expect([...deliveryAncestors(stages, "cases")].sort()).toEqual([
      "back",
      "design",
      "front",
    ]);
  });
  it("preserves sequential dependencies of existing records", () => {
    const a = stage("a", []),
      b = stage("b", []);
    delete a.dependsOn;
    delete b.dependsOn;
    expect(readyDeliveryStages([a, b]).map((s) => s.taskId)).toEqual(["a"]);
  });
  it("cannot accept an unfinished invalid graph or launch before confirmation", () => {
    expect(() =>
      assertDeliveryGraph([stage("a", ["b"]), stage("b", ["a"])]),
    ).toThrow();
    expect(nextDeliveryAction([stage("a", ["missing"])])).toBe("wait");
    const s = { ...stage("a", []), startMode: "confirmation" as const };
    expect(deliveryStageCanStart(s)).toBe(false);
    expect(nextDeliveryAction([s])).toBe("wait");
    s.startApprovedBy = "owner";
    expect(nextDeliveryAction([s])).toBe("dispatch");
  });
  it("requires an enabled stage and a named reviewer when specified", () => {
    const def = structuredClone(DEFAULT_DELIVERY_TEMPLATE);
    Object.values(def.stages).forEach((s) => (s.enabled = false));
    expect(deliveryTemplateDefinitionSchema.safeParse(def).success).toBe(false);
    def.stages.design.enabled = true;
    def.stages.design.review = "specified_user";
    expect(deliveryTemplateDefinitionSchema.safeParse(def).success).toBe(false);
  });
});
