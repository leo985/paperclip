import { describe, expect, it } from "vitest";
import { publicSeatLaunchOptions, seatLaunchOptionsSchema } from "@paperclipai/shared";

describe("seat launch options contract", () => {
  it("distinguishes unconfigured from an explicit empty override", () => {
    expect(publicSeatLaunchOptions({})).toEqual({ configured: false, extraArgs: [], revision: 0 });
    expect(publicSeatLaunchOptions({ dsp7SeatLaunchOptions: { extraArgs: [], revision: 2 } })).toEqual({ configured: true, extraArgs: [], revision: 2 });
  });
  it.each([
    ["--settings", "/local.json"], ["--session-id", "foreign"], ["--model"],
    ["--effort", "ultra"], ["--model", "a", "--model", "b"],
    ["--dangerously-skip-permissions", "--permission-mode", "plan"], ["--model", "$(secret)"],
  ])("rejects invalid or reserved args %j", (...args) => {
    expect(seatLaunchOptionsSchema.safeParse({ extraArgs: args }).success).toBe(false);
  });
  it("allows an explicit skip opt-in with model and effort", () => {
    const extraArgs = ["--dangerously-skip-permissions", "--model", "sonnet", "--effort", "high"];
    expect(seatLaunchOptionsSchema.parse({ extraArgs })).toEqual({ extraArgs });
  });
});
