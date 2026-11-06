import { describe, expect, it } from "vitest";
import { seatConcurrencyLimit, seatConcurrencySchema, seatCanAcceptWork } from "./seat-concurrency.js";
describe("seat concurrency contract", () => {
  const seat = (value: unknown, capabilities = ["seat-concurrency-v1"]) => ({ adapterConfig: { dsp7Transport: "outbound", dsp7SeatPresence: { capabilities } }, runtimeConfig: { heartbeat: { maxConcurrentRuns: value } } });
  it("defaults seats and old clients to one while validating independent limits", () => {
    expect(seatConcurrencyLimit(seat(4))).toBe(4);
    expect(seatConcurrencyLimit(seat(4, []))).toBe(1);
    for (const value of [undefined, 0, 51, 1.5, "4", Infinity]) expect(seatConcurrencyLimit(seat(value))).toBe(1);
    for (const value of [1, 2, 50]) expect(seatConcurrencySchema.parse({ maxConcurrentRuns: value }).maxConcurrentRuns).toBe(value);
    for (const value of [0, 51, 1.5, "4"]) expect(seatConcurrencySchema.safeParse({ maxConcurrentRuns: value }).success).toBe(false);
  });
  it("allows additional work while another task waits, preserving configuration and pause gates", () => {
    expect(seatCanAcceptWork({ state: "waiting_decision" })).toBe(true);
    expect(seatCanAcceptWork({ state: "busy" })).toBe(true);
    expect(seatCanAcceptWork({ state: "busy", acceptingWork: false })).toBe(false);
    expect(seatCanAcceptWork({ state: "config_error" })).toBe(false);
    expect(seatCanAcceptWork(undefined)).toBe(false);
  });
});
