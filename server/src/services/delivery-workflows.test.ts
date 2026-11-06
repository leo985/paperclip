import { randomUUID } from "node:crypto";
import { describe, it, expect } from "vitest";
import {
  deliveryWorkflowStartSchema,
  deliveryStageReceiptSchema,
  type DeliveryStageRecord,
  type DeliveryStageReceipt,
} from "@paperclipai/shared";
import {
  deliveryDigest,
  nextDeliveryAction,
  validateStageReceipt,
} from "./delivery-workflows.js";
const stage = (): DeliveryStageRecord => ({
  stage: "design",
  taskId: randomUUID(),
  seatId: randomUUID(),
  ownerUserId: "owner",
  jiraKey: "ATSES-1",
  dispatchId: randomUUID(),
  state: "running",
  runId: randomUUID(),
  capabilityId: "cap",
  registryRevision: 1,
  inputDigest: "a".repeat(64),
  receipt: null,
  receiptDigest: null,
  review: null,
  message: null,
});
const receipt = (s: DeliveryStageRecord): DeliveryStageReceipt => ({
  protocolVersion: 1,
  taskId: s.taskId,
  runId: s.runId!,
  stage: s.stage,
  jiraKey: s.jiraKey!,
  inputDigest: s.inputDigest,
  stateDigest: "b".repeat(64),
  trackerReceiptId: "42",
  jiraReference: "http://jira.example/browse/ATSES-1",
  artifacts: [{ path: "design.md", sha256: "c".repeat(64) }],
});
describe("delivery serial evidence gates", () => {
  it("binds domain review to the current upstream version and selected work tickets", () => {
    for (const intent of ["design-review", "test-case-review"] as const) {
      const s = { ...stage(), intent, reviewWorkKeys: ["ATSES-2"] };
      const r = { ...receipt(s), domainReview: { decision: "passed" as const, reviewedVersionDigest: deliveryDigest({ inputDigest: s.inputDigest, workKeys: s.reviewWorkKeys }), sourcePath: "design.md", sourceSha256: "c".repeat(64) } };
      expect(() => validateStageReceipt(s, r)).not.toThrow();
      expect(() => validateStageReceipt({ ...s, reviewWorkKeys: ["ATSES-3"] }, r)).toThrow();
      expect(() => validateStageReceipt(s, { ...r, domainReview: { ...r.domainReview, reviewedVersionDigest: "d".repeat(64) } })).toThrow();
    }
  });
  it("waits on running, waiting, review and interrupted stages without guessing success from exit", () => {
    for (const state of [
      "running",
      "waiting",
      "review",
      "interrupted",
    ] as const)
      expect(nextDeliveryAction([{ ...stage(), state }])).toBe("wait");
  });
  it("dispatches only the first unfinished stage and requires every stage done for acceptance", () => {
    expect(
      nextDeliveryAction([{ ...stage(), state: "pending" }, stage()]),
    ).toBe("dispatch");
    expect(nextDeliveryAction([{ ...stage(), state: "done" }, stage()])).toBe(
      "wait",
    );
    expect(nextDeliveryAction([{ ...stage(), state: "done" }])).toBe(
      "acceptance",
    );
  });
  it("binds delivery to the exact run, issue, stage, Jira identity and upstream digest", () => {
    const s = stage(),
      r = receipt(s);
    expect(() => validateStageReceipt(s, r)).not.toThrow();
    for (const change of [
      { taskId: randomUUID() },
      { runId: randomUUID() },
      { stage: "coding" },
      { jiraKey: "ATSES-2" },
      { inputDigest: "0".repeat(64) },
    ])
      expect(() =>
        validateStageReceipt(s, { ...r, ...change } as DeliveryStageReceipt),
      ).toThrow(/不匹配/);
  });
  it("rejects relabeled native rework state and historical attachments until updated formal materials exist",()=>{
    const s=stage(),old=receipt(s),r={...old,stateDigest:"d".repeat(64)};
    s.reworkHistory=[{round:1,reviewTaskId:s.taskId,rejection:{decision:"reject",digest:"e".repeat(64),reference:old.jiraReference,note:"补充异常处理",by:"owner",at:new Date().toISOString()},previous:{state:"done",inputDigest:s.inputDigest,dispatchId:s.dispatchId,runId:s.runId,receipt:old,receiptDigest:"e".repeat(64),review:null}}];
    expect(()=>validateStageReceipt(s,old)).toThrow(/不能复用退回版本/);
    expect(()=>validateStageReceipt(s,r)).toThrow(/不能复用退回版本/);
    expect(()=>validateStageReceipt(s,{...r,artifacts:[{path:"metrics-source.json",sha256:"f".repeat(64),downloadUrl:"http://jira.example/secure/attachment/43/metrics-source.json"}]})).toThrow(/不能复用退回版本/);
    r.artifacts=[{path:"design.md",sha256:"f".repeat(64),downloadUrl:"http://jira.example/secure/attachment/43/design.md"}];
    expect(()=>validateStageReceipt(s,r)).not.toThrow();
  });
  it("requires QA results bound to the exact record and rejects inconsistent counters", () => {
    const s = { ...stage(), stage: "functional-test" as const };
    const r = receipt(s);
    expect(() => validateStageReceipt(s, r)).toThrow(/测试/);
    const results = { total: 2, passed: 1, failed: 1, blocked: 0, skipped: 0, testedVersion: "build-123", sourcePath: "execution-records.md" as const, sourceSha256: "c".repeat(64) };
    const valid = { ...r, artifacts: [{ path: "execution-records.md", sha256: results.sourceSha256 }], testResults: results };
    expect(deliveryStageReceiptSchema.safeParse(valid).success).toBe(true);
    expect(() => validateStageReceipt(s, valid)).not.toThrow();
    expect(() => validateStageReceipt(s, { ...valid, testResults: { ...results, sourceSha256: "d".repeat(64) } })).toThrow(/指纹/);
    expect(deliveryStageReceiptSchema.safeParse({ ...valid, testResults: { ...results, passed: 2 } }).success).toBe(false);
    expect(deliveryStageReceiptSchema.safeParse({ ...valid, testResults: { ...results, testedVersion: "" } }).success).toBe(false);
    expect(() => validateStageReceipt({ ...s, stage: "coding" }, { ...valid, stage: "coding" })).toThrow(/只有功能测试/);
  });
  it("accepts only same-origin Jira attachment download references", () => {
    const s = stage(), r = receipt(s);
    const origin = new URL(r.jiraReference).origin;
    const withUrl = (downloadUrl: string) => ({ ...r, artifacts: [{ ...r.artifacts[0]!, downloadUrl }] });
    expect(() => validateStageReceipt(s, withUrl(origin + "/secure/attachment/123/design.pdf"))).not.toThrow();
    for (const url of ["https://foreign.example/secure/attachment/123/file", origin + "/browse/ATSES-1", origin + "/secure/attachment/123/file?token=secret", origin + "/secure/attachment/123/file#fragment", origin.replace("://", "://user:pass@") + "/secure/attachment/123/file"]) {
      expect(() => validateStageReceipt(s, withUrl(url))).toThrow();
    }
  });
  it("rejects duplicate and traversal artifacts and credentials in formal links", () => {
    const s = stage(),
      r = receipt(s);
    for (const path of ["../key", "/etc/file", "dir\\file"]) {
      expect(() =>
        validateStageReceipt(s, {
          ...r,
          artifacts: [{ ...r.artifacts[0]!, path }],
        }),
      ).toThrow();
    }
    expect(() =>
      validateStageReceipt(s, {
        ...r,
        artifacts: [r.artifacts[0]!, r.artifacts[0]!],
      }),
    ).toThrow();
    for (const jiraReference of [
      "https://user:password@jira.example/browse/ATSES-1",
      "https://jira.example/browse/ATSES-2",
      "file:///browse/ATSES-1",
    ])
      expect(() => validateStageReceipt(s, { ...r, jiraReference })).toThrow();
  });
  it("requires actual child keys and distinct configured execution domains", () => {
    expect(
      deliveryWorkflowStartSchema.safeParse({
        requestId: randomUUID(),
        snapshotId: randomUUID(),
      }).success,
    ).toBe(false);
  });
});
