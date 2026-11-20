import { expect, it } from "vitest";
import { DELIVERY_STAGES } from "@paperclipai/shared";
import { taskMatchesStage, taskStageFilter } from "./task-delivery-stage";
it("uses the chain stage IDs and keeps unknown filters compatible", () => {
  for (const stage of DELIVERY_STAGES) expect(taskStageFilter(stage)).toBe(stage);
  expect(taskStageFilter("other")).toBe("other");
  expect(taskStageFilter("unknown")).toBe("all");
});
it("never treats missing metadata as other; supports explicit multiple-stage associations", () => {
  expect(taskMatchesStage({}, "other")).toBe(false);
  expect(taskMatchesStage({ deliveryStages: [] }, "other")).toBe(true);
  expect(taskMatchesStage({ deliveryStages: ["coding", "functional-test"] }, "coding")).toBe(true);
  expect(taskMatchesStage({ deliveryStages: ["coding"] }, "analysis")).toBe(false);
});
