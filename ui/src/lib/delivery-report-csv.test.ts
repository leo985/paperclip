import { describe,expect,it } from "vitest";
import { deliveryReportCsv } from "./delivery-report-csv";
import type { DeliveryInsights } from "@paperclipai/shared";
describe("permission-scoped delivery CSV",()=>{
 it("preserves unknowns, guards formula text and includes denominators without conversation bodies",()=>{
   const report={methodologyVersion:"delivery-insights-v1",from:"from",to:"to",generatedAt:"now",seats:[{name:'=HYPERLINK("bad")',ownerName:"负责人",currentOpen:1,started:0,delivered:0,cancelled:0,runs:1,executingMs:1,waitingMs:2,unknownMs:3,idleMs:null,usage:{runs:1,measuredRuns:0,finalRuns:0,inputTokens:null,outputTokens:null,cachedInputTokens:null,unpricedRuns:1,reportedCostCents:null},quality:{linkedDefects:null,matureEligible:3,measuredMature:2,affectedMature:1,observedDefectRate:0.5,coverage:2/3}}],notes:["缺失不是零"]} as unknown as DeliveryInsights;
   const csv=deliveryReportCsv(report);expect(csv.startsWith("\uFEFF")).toBe(true);expect(csv).toContain("'=HYPERLINK");expect(csv).toContain('"未知"');expect(csv).toContain("有完整观测成熟工单数");expect(csv).not.toContain("session");
 });
});
