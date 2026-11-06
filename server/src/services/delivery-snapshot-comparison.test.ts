import { describe,expect,it } from "vitest";
import { normalizeDeliverySnapshot } from "./delivery-intake.js";
import { fixture } from "./delivery-intake.fixture.js";
import { compareDeliveryPlans } from "./delivery-snapshot-comparison.js";
describe("immutable delivery version comparison",()=>{
  it("makes newly collected analysis and review evidence inspectable in version comparisons",()=>{
    const a=normalizeDeliverySnapshot(fixture()),b=structuredClone(a);
    b.sourceAnalysis={sourceStatus:"待开发",analysisSaved:true,reviewStages:[{role:"需求负责人",status:"通过"}]};
    expect(compareDeliveryPlans(a,b)).toContainEqual({key:b.demandNo,field:"sourceAnalysis",before:null,after:"待开发 · 分析已保存 · 需求负责人：通过"});
  });
  it("ignores order and fingerprint changes without inventing business changes",()=>{
    const a=normalizeDeliverySnapshot(fixture()),b=structuredClone(a);
    b.items.reverse();b.mains.reverse();b.fingerprint="different";
    expect(compareDeliveryPlans(a,b)).toEqual([]);
  });
  it("keeps membership, reassignment, hierarchy and status changes separate",()=>{
    const a=normalizeDeliverySnapshot(fixture()),b=structuredClone(a);
    const original=structuredClone(a);
    b.items[0].assignee="new-owner";b.items[0].status="new-status";b.items[0].parentKey="OTHER-123";
    const removed=b.items.pop()!;b.items.push({...removed,key:"NEW-123"});
    const result=compareDeliveryPlans(a,b);
    expect(result).toEqual(expect.arrayContaining([expect.objectContaining({field:"assignee",after:"new-owner"}),expect.objectContaining({field:"status",after:"new-status"}),expect.objectContaining({field:"parentKey",after:"OTHER-123"}),expect.objectContaining({key:removed.key,field:"membership",after:null}),expect.objectContaining({key:"NEW-123",field:"membership",before:null})]));
    expect(a).toEqual(original);expect(a.executionAllowed).toBe(false);
  });
});
