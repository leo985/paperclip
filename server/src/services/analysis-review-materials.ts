import { createHash } from "node:crypto";
import type { AnalysisSnapshot } from "@paperclipai/shared";
import { badRequest, conflict } from "../errors.js";

export function validateReviewMaterials(snapshot: AnalysisSnapshot, runId: string) {
  const materials = snapshot.reviewMaterials;
  if (materials && (snapshot.phase !== "P3" || materials.runId !== runId ||
    materials.documents.some(file => Buffer.byteLength(file.content, "utf8") > 120000 ||
      createHash("sha256").update(file.content).digest("hex") !== file.sha256))) {
    throw badRequest("评审材料版本或文件校验无效");
  }
}

export function requireReviewMaterials(snapshot: AnalysisSnapshot | null, decision: { runId: string; inputDigest: string }) {
  const materials = snapshot?.reviewMaterials;
  if (!materials || snapshot?.phase !== "P3" || materials.runId !== decision.runId || materials.inputDigest !== decision.inputDigest)
    throw conflict("当前版本评审材料尚未上传或已变化，请等待材料展示后再批准");
}
