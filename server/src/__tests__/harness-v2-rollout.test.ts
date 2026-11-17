import { afterEach, describe, expect, it, vi } from "vitest";
import { harnessV2Enabled } from "../services/harness-v2-rollout.js";
const companyId="11111111-1111-4111-8111-111111111111";
const seatId="22222222-2222-4222-8222-222222222222";
const other="33333333-3333-4333-8333-333333333333";
describe("Harness V2 seat rollout",()=>{
  afterEach(()=>vi.unstubAllEnvs());
  it("requires the feature flag and an exact company-seat pair",()=>{
    vi.stubEnv("DSP7_HARNESS_V2_SEATS",JSON.stringify([{companyId,seatId}]));
    vi.stubEnv("DSP7_HARNESS_OBSERVATION_ENABLED","false");
    expect(harnessV2Enabled("observation",companyId,seatId)).toBe(false);
    vi.stubEnv("DSP7_HARNESS_OBSERVATION_ENABLED","true");
    expect(harnessV2Enabled("observation",companyId,seatId)).toBe(true);
    expect(harnessV2Enabled("observation",other,seatId)).toBe(false);
    expect(harnessV2Enabled("observation",companyId,other)).toBe(false);
    vi.stubEnv("DSP7_HARNESS_BUNDLES_ENABLED","false");
    expect(harnessV2Enabled("bundles",companyId,seatId)).toBe(false);
  });
  it.each(["", "[]", "null", "{", '[{"companyId":"*","seatId":"*"}]',
    JSON.stringify([{companyId,seatId,all:true}]),
    JSON.stringify(Array.from({length:17},()=>({companyId,seatId}))), " ".repeat(8193)])(
    "fails closed for absent or malformed configuration %#",raw=>{
      vi.stubEnv("DSP7_HARNESS_OBSERVATION_ENABLED","true");
      vi.stubEnv("DSP7_HARNESS_V2_SEATS",raw);
      expect(harnessV2Enabled("observation",companyId,seatId)).toBe(false);
    });
});
