import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { analysisReviewMaterialsSchema, type AnalysisSnapshot } from "@paperclipai/shared";
import { requireReviewMaterials, validateReviewMaterials } from "./analysis-review-materials.js";
const runId="11111111-1111-4111-8111-111111111111", digest="a".repeat(64);
function fixture() {
  return {phase:"P3",reviewMaterials:{runId,inputDigest:digest,capturedAt:new Date().toISOString(),documents:["intake.md","requirements.json","analysis.md"].map(path=>({path,content:"当前分析",sha256:createHash("sha256").update("当前分析").digest("hex")})),evidenceSha256:digest,evidence:[]}} as unknown as AnalysisSnapshot;
}
describe("version-bound online review materials",()=>{
  it("accepts complete material captured for the current run",()=>{
    const snapshot=fixture();expect(analysisReviewMaterialsSchema.safeParse(snapshot.reviewMaterials).success).toBe(true);
    expect(()=>validateReviewMaterials(snapshot,runId)).not.toThrow();expect(()=>requireReviewMaterials(snapshot,{runId,inputDigest:digest})).not.toThrow();
  });
  it("rejects approval without materials or for another input or run",()=>{
    expect(()=>requireReviewMaterials(null,{runId,inputDigest:digest})).toThrow();
    expect(()=>requireReviewMaterials(fixture(),{runId,inputDigest:"b".repeat(64)})).toThrow();
    expect(()=>requireReviewMaterials(fixture(),{runId:"other",inputDigest:digest})).toThrow();
  });
  it("rejects altered document bytes and cross-run uploads",()=>{
    const s=fixture();s.reviewMaterials!.documents[0]!.content="changed";expect(()=>validateReviewMaterials(s,runId)).toThrow();
    expect(()=>validateReviewMaterials(fixture(),"other")).toThrow();
  });
  it("requires all three distinct documents and phase P3",()=>{
    const s=fixture();s.reviewMaterials!.documents[1]=s.reviewMaterials!.documents[0]!;expect(analysisReviewMaterialsSchema.safeParse(s.reviewMaterials).success).toBe(false);
    s.phase="P2";expect(()=>validateReviewMaterials(s,runId)).toThrow();
  });
});
