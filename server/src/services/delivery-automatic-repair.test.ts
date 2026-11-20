import { describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { deliveryAutomaticRepairSchema, type DeliveryStageRecord, type DeliveryAutomaticRepairPolicy } from "@paperclipai/shared";
import { validateStageReceipt, deliveryDigest } from "./delivery-workflows.js";
import { automaticRepairRoute, existingRepairNodes } from "./delivery-automatic-repair.js";
const route = {
  module: "payments",
  developmentSeatId: randomUUID(),
  reviewSeatId: randomUUID(),
  qaSeatId: randomUUID()
};
const policy: DeliveryAutomaticRepairPolicy = {
  maxCycles: 2,
  jiraProjectKey: "TEST",
  defectIssueTypeId: "1",
  fixIssueTypeId: "2",
  reviewIssueTypeId: "3",
  retestIssueTypeId: "4",
  buildObservationUrl: "https://test.example/version",
  routes: [route]
};
const failed = () => ({
  stage: "functional-test",
  parentKey: "TEST-1",
  receipt: {
    testResults: {
      failed: 1
    },
    failureReport: {
      defects: [{
        caseId: "C1",
        module: "payments",
        kind: "product"
      }]
    }
  }
}) as DeliveryStageRecord;
describe("automatic repair policy and classification", () => {
  it("requires independent bounded module routes and an explicit build observer", () => {
    expect(deliveryAutomaticRepairSchema.safeParse(policy).success).toBe(true);
    for (const patch of [{
      maxCycles: 4
    }, {
      buildObservationUrl: "file:///secret"
    }, {
      routes: [{
        ...route,
        reviewSeatId: route.developmentSeatId
      }]
    }, {
      routes: [route, route]
    }]) expect(deliveryAutomaticRepairSchema.safeParse({
      ...policy,
      ...patch
    }).success).toBe(false);
  });
  it("routes only complete product defect reports, with a bounded cycle count", () => {
    expect(automaticRepairRoute(failed(), policy)).toEqual(route);
    for (const kind of ["environment", "test-case"] as const) {
      const s = failed();
      s.receipt!.failureReport!.defects[0].kind = kind;
      expect(() => automaticRepairRoute(s, policy)).toThrow("须人工处理");
    }
    const missing = failed();
    delete missing.receipt!.failureReport;
    expect(() => automaticRepairRoute(missing, policy)).toThrow();
    const exhausted = failed();
    exhausted.repairHistory = [{}, {}] as any;
    expect(() => automaticRepairRoute(exhausted, policy)).toThrow("上限");
    const missingParent = failed();
    delete missingParent.parentKey;
    expect(() => automaticRepairRoute(missingParent, policy)).toThrow("主工单");
  });
  it("escalates unknown or mixed module ownership instead of guessing", () => {
    const s = failed();
    s.receipt!.failureReport!.defects[0].module = "unknown";
    expect(() => automaticRepairRoute(s, policy)).toThrow("未配置");
    s.receipt!.testResults!.failed = 2;
    s.receipt!.failureReport!.defects.push({
      ...s.receipt!.failureReport!.defects[0],
      caseId: "C2",
      module: "payments"
    });
    expect(() => automaticRepairRoute(s, policy)).toThrow("多个模块");
  });
});
describe("automatic repair receipt admission", () => {
  const hash = "a".repeat(64);
  function fixture(intent: "bugfix" | "code-review" | "retest") {
    const stage = {
      taskId: randomUUID(),
      runId: randomUUID(),
      stage: intent === "retest" ? "functional-test" : "coding",
      jiraKey: "TEST-2",
      inputDigest: hash,
      intent,
      automaticRepairGenerated: true,
      reviewWorkKeys: intent === "code-review" ? ["TEST-1"] : undefined,
      repairFailure: {
        receipt: {
          testResults: {
            testedVersion: "old"
          }
        }
      }
    } as DeliveryStageRecord;
    const receipt: any = {
      protocolVersion: 1,
      taskId: stage.taskId,
      runId: stage.runId,
      stage: stage.stage,
      jiraKey: stage.jiraKey,
      inputDigest: hash,
      stateDigest: hash,
      trackerReceiptId: "1",
      jiraReference: "https://jira.example/browse/TEST-2",
      artifacts: []
    };
    return {
      stage,
      receipt
    };
  }
  it("rejects an old or unbound build, accepts a new pinned formal build", () => {
    const {
      stage,
      receipt
    } = fixture("bugfix");
    expect(() => validateStageReceipt(stage, receipt)).toThrow("新构建");
    receipt.build = {
      version: "new",
      environmentReference: "https://env.example",
      observationUrl: policy.buildObservationUrl,
      sourcePath: "delivery-build.json",
      sourceSha256: hash
    };
    expect(() => validateStageReceipt(stage, receipt)).toThrow("正式交付附件");
    receipt.artifacts = [{
      path: "delivery-build.json",
      sha256: hash,
      downloadUrl: "https://jira.example/secure/attachment/1/build.json"
    }];
    expect(() => validateStageReceipt(stage, receipt)).not.toThrow();
    receipt.build.version = "old";
    expect(() => validateStageReceipt(stage, receipt)).toThrow("新构建");
  });
  it("binds independent approval or rejection to the current repaired input", () => {
    const {
      stage,
      receipt
    } = fixture("code-review");
    receipt.artifacts = [{
      path: "review.md",
      sha256: hash
    }];
    receipt.codeReview = {
      decision: "rejected",
      note: "fix the bug",
      reviewedVersionDigest: "b".repeat(64),
      sourcePath: "review.md",
      sourceSha256: hash
    };
    expect(() => validateStageReceipt(stage, receipt)).toThrow("本次修复输入");
    receipt.codeReview.reviewedVersionDigest = deliveryDigest({
      inputDigest: stage.inputDigest,
      workKeys: stage.reviewWorkKeys
    });
    expect(() => validateStageReceipt(stage, receipt)).not.toThrow();
  });
  it("rejects a retest of any version other than the observed repair build", () => {
    const {
      stage,
      receipt
    } = fixture("retest");
    stage.expectedBuild = {
      version: "new",
      environmentReference: "https://env.example",
      observationUrl: policy.buildObservationUrl,
      sourcePath: "delivery-build.json",
      sourceSha256: hash
    };
    receipt.artifacts = [{
      path: "execution-records.md",
      sha256: hash
    }];
    receipt.testResults = {
      total: 1,
      passed: 1,
      failed: 0,
      blocked: 0,
      skipped: 0,
      testedVersion: "old",
      sourcePath: "execution-records.md",
      sourceSha256: hash
    };
    expect(() => validateStageReceipt(stage, receipt)).toThrow("被测版本");
    receipt.testResults.testedVersion = "new";
    expect(() => validateStageReceipt(stage, receipt)).not.toThrow();
  });
});
describe("repair reuses the original work graph", () => {
  function nodes() {
    const work = {
      taskId: "work",
      stage: "coding",
      jiraKey: "TEST-2",
      parentKey: "TEST-1",
      seatId: route.developmentSeatId
    } as DeliveryStageRecord;
    const review = {
      taskId: "review",
      stage: "coding",
      intent: "code-review",
      jiraKey: "TEST-3",
      parentKey: "TEST-1",
      seatId: route.reviewSeatId,
      reviewWorkKeys: ["TEST-2"]
    } as DeliveryStageRecord;
    const test = {
      ...failed(),
      taskId: "test",
      jiraKey: "TEST-4",
      seatId: route.qaSeatId
    } as DeliveryStageRecord;
    return {
      work,
      review,
      test,
      flow: {
        stages: [work, review, test]
      }
    };
  }
  it("returns the same task objects and accepts policy without any Jira creation types", () => {
    const f = nodes();
    expect(existingRepairNodes(f.flow, f.test, route)).toEqual({
      work: f.work,
      review: f.review,
      test: f.test,
      tests: [f.test]
    });
    expect(deliveryAutomaticRepairSchema.safeParse({
      mode: "reuse_existing",
      maxCycles: 2,
      buildObservationUrl: policy.buildObservationUrl,
      routes: [route]
    }).success).toBe(true);
  });
  it("blocks missing, ambiguous, foreign or reassigned original nodes instead of creating substitutes", () => {
    const f = nodes();
    expect(() => existingRepairNodes({
      stages: [f.test]
    }, f.test, route)).toThrow("原编码单");
    expect(() => existingRepairNodes({
      stages: [...f.flow.stages, {
        ...f.work,
        taskId: "duplicate"
      }]
    }, f.test, route)).toThrow("唯一");
    expect(() => existingRepairNodes({
      stages: [f.work, f.test]
    }, f.test, route)).toThrow("原代码评审单");
    f.review.parentKey = "OTHER-1";
    expect(() => existingRepairNodes(f.flow, f.test, route)).toThrow("原代码评审单");
    f.review.parentKey = "TEST-1";
    f.review.seatId = randomUUID();
    expect(() => existingRepairNodes(f.flow, f.test, route)).toThrow("原编码");
  });
  it("requires a new build on a reused coding node without changing its native intent", () => {
    const f = nodes();
    const stage = {
      ...f.work,
      runId: randomUUID(),
      inputDigest: "a".repeat(64),
      repairReused: true,
      repairFailure: {
        receipt: {
          testResults: {
            testedVersion: "old"
          }
        }
      }
    } as DeliveryStageRecord;
    const digest = "b".repeat(64);
    const receipt: any = {
      protocolVersion: 1,
      taskId: stage.taskId,
      runId: stage.runId,
      stage: "coding",
      jiraKey: stage.jiraKey,
      inputDigest: stage.inputDigest,
      stateDigest: digest,
      trackerReceiptId: "1",
      jiraReference: "https://jira.example/browse/TEST-2",
      artifacts: []
    };
    expect(() => validateStageReceipt(stage, receipt)).toThrow("新构建");
    receipt.build = {
      version: "new",
      environmentReference: "https://env.example",
      observationUrl: policy.buildObservationUrl,
      sourcePath: "delivery-build.json",
      sourceSha256: digest
    };
    receipt.artifacts = [{
      path: "delivery-build.json",
      sha256: digest,
      downloadUrl: "https://jira.example/secure/attachment/1/build.json"
    }];
    expect(() => validateStageReceipt(stage, receipt)).not.toThrow();
    expect(stage.intent).toBeUndefined();
  });
});
it("includes all original functional tests in regression without adding or renaming nodes", () => {
  const coding = {
    stage: "coding",
    taskId: "coding",
    seatId: route.developmentSeatId,
    parentKey: "TEST-1",
    jiraKey: "TEST-2"
  } as DeliveryStageRecord;
  const review = {
    stage: "coding",
    intent: "code-review",
    taskId: "review",
    seatId: route.reviewSeatId,
    parentKey: "TEST-1",
    jiraKey: "TEST-3",
    reviewWorkKeys: ["TEST-2"]
  } as DeliveryStageRecord;
  const test = {
    ...failed(),
    taskId: "qa",
    seatId: route.qaSeatId,
    jiraKey: "TEST-4"
  };
  const regression = {
    ...test,
    taskId: "regression",
    jiraKey: "TEST-5"
  };
  const result = existingRepairNodes({
    stages: [coding, review, test, regression]
  }, test, route);
  expect(result.tests).toEqual([test, regression]);
  expect(result.tests[0]).toBe(test);
  expect(result.tests[1]).toBe(regression);
});
