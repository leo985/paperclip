import { describe,it,expect } from "vitest";
import { harnessBundleInputSchema } from "./harness-bundles.js";
import { harnessCapabilityInputSchema } from "./harness-capabilities.js";
const bundle={protocolVersion:1,bundleDigest:"a".repeat(64),project:"base-harness-infrastructure",mode:"candidate",
  packages:[{id:"harness-v2-runtime",version:"0.1.0",layer:"L3",manifestDigest:"b".repeat(64),skills:["harness-runtime-inspect"]},
    {id:"fingard-history-methods",version:"0.1.0",layer:"L4",manifestDigest:"c".repeat(64),skills:["git-history-analyzer"]}]};
describe("bundle discovery contract",()=>{
  it("accepts only the closed candidate contract",()=>{expect(harnessBundleInputSchema.parse(bundle)).toEqual(bundle);});
  it("rejects private paths and execution claims",()=>{
    for(const extra of [{root:"/private/path"},{executionReady:true},{roles:["coding"]},{token:"secret"}])expect(harnessBundleInputSchema.safeParse({...bundle,...extra}).success).toBe(false);
  });
  it("rejects duplicate layers and duplicate skills",()=>{
    for(const change of [{layer:"L3"},{skills:["harness-runtime-inspect"]},{id:"harness-v2-runtime"}])expect(harnessBundleInputSchema.safeParse({...bundle,packages:[bundle.packages[0],{...bundle.packages[1],...change}]}).success).toBe(false);
  });
  it("cannot masquerade as a legacy execution capability",()=>{expect(harnessCapabilityInputSchema.safeParse(bundle).success).toBe(false);});
});
