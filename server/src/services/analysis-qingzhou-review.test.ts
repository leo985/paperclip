import { describe, expect, it, vi } from "vitest";
import type { AnalysisQingzhouWriteback } from "@paperclipai/shared";
import { qingzhouClient } from "./qingzhou-client.js";
import { analysisQingzhouHtml, saveAndSubmitQingzhouAnalysis } from "./analysis-qingzhou-writeback.js";

function fixture() {
  const id = "1828643972046290945", demandNo = "TWGF-00919", markdown = "# 当前批准的分析\n正文";
  let body = "旧正文", state = "3", reviewer: string | null = "9007199254740993", mode = "ok";
  const events: string[] = [];
  const fetcher = vi.fn(async (target: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(target)), uc = url.searchParams.get("uc");
    if (url.pathname === "/api/auth/login") return new Response(JSON.stringify({ accessToken: "test-token" }));
    events.push(uc!);
    let data: Record<string, unknown> = {};
    if (uc === "UC_PROJ2_DEMAND_DETAIL") data = { data: { demandDto: { urid: id, demandNo, demandState: state, reviewer, requirementer: "123", areaCode: "1" }, demandAnalysisDetailsDTO: { demandAnalysisDto: { analysisResult: body } } } };
    else if (uc === "UC_PROJ2_DEMAND_SPLIT_ANALYZE") {
      body = String((init!.body as FormData).get("demandAnalysisDto.analysisResult"));
      if (mode === "save-lost") throw new Error("private-token lost response");
      if (mode === "save-mismatch") body = "他人修改";
    } else if (uc === "UC_PROJ2_DEMAND_APPLY_REVIEW") {
      expect(init!.body).toBeInstanceOf(URLSearchParams);
      expect((init!.body as URLSearchParams).get("urid")).toBe(id);
      expect((init!.body as URLSearchParams).get("reviewer")).toBe(reviewer);
      if (mode === "rejected") return new Response(JSON.stringify({ success: false, code: "PROJ0502", info: "private-token" }));
      if (mode !== "no-transition") state = "5";
      if (mode === "review-lost") throw new Error("private-token lost response");
      if (mode === "review-mismatch") body = "他人修改";
    } else throw new Error("Unexpected operation");
    return new Response(JSON.stringify({ success: true, code: "0", ...data }));
  });
  const receipt: AnalysisQingzhouWriteback = { status: "pending", inputDigest: "a".repeat(64) };
  const client = qingzhouClient({ fetch: fetcher as typeof fetch, credentials: async () => ({ username: "fixture", password: "fixture" }) });
  return { receipt, events, setMode: (v: string) => { mode = v; }, setReviewer: (v: string | null) => { reviewer = v; }, setBody: (v: string) => { body = v; }, setState: (v: string) => { state = v; },
    run: () => saveAndSubmitQingzhouAnalysis(client, id, demandNo, markdown, receipt, async () => ({ "demandAnalysisDto.analysisResult": analysisQingzhouHtml(markdown) })) };
}
const saves = (f: ReturnType<typeof fixture>) => f.events.filter(e => e === "UC_PROJ2_DEMAND_SPLIT_ANALYZE").length;
const submissions = (f: ReturnType<typeof fixture>) => f.events.filter(e => e === "UC_PROJ2_DEMAND_APPLY_REVIEW").length;

describe("approved analysis Qingzhou completion", () => {
  it("saves and verifies content before applying review, then verifies state and reviewer", async () => {
    const f = fixture(); await f.run();
    expect(f.events).toEqual(["UC_PROJ2_DEMAND_DETAIL", "UC_PROJ2_DEMAND_SPLIT_ANALYZE", "UC_PROJ2_DEMAND_DETAIL", "UC_PROJ2_DEMAND_APPLY_REVIEW", "UC_PROJ2_DEMAND_DETAIL"]);
    expect(f.receipt).toMatchObject({ status: "saved", reviewStatus: "submitted", sourceState: "5", reviewerId: "9007199254740993", reviewVerifiedAt: expect.any(String) });
    await f.run(); expect(saves(f)).toBe(1); expect(submissions(f)).toBe(1);
  });
  it("never submits when saved content fails readback", async () => {
    const f = fixture(); f.setMode("save-mismatch"); await expect(f.run()).rejects.toThrow("回读正文不一致"); expect(submissions(f)).toBe(0);
  });
  it("recovers a lost save response by readback without saving again", async () => {
    const f = fixture(); f.setMode("save-lost"); await expect(f.run()).rejects.toMatchObject({ code: "connection_unavailable" });
    f.setMode("ok"); await f.run(); expect(f.receipt.reviewStatus).toBe("submitted"); expect(saves(f)).toBe(1);
  });
  it("reconciles a lost submission response without a second submission", async () => {
    const f = fixture(); f.setMode("review-lost"); await f.run();
    expect(f.receipt.reviewStatus).toBe("submitted"); expect(submissions(f)).toBe(1);
  });
  it("keeps saved success when submission is rejected, retries only the unfinished step", async () => {
    const f = fixture(); f.setMode("rejected"); await f.run();
    expect(f.receipt).toMatchObject({ status: "saved", reviewStatus: "failed", reviewError: expect.stringContaining("拒绝申请评审") });
    expect(JSON.stringify(f.receipt)).not.toContain("private-token");
    f.setMode("ok"); await f.run(); expect(f.receipt.reviewStatus).toBe("submitted"); expect(saves(f)).toBe(1); expect(submissions(f)).toBe(2);
  });
  it("does not report success when source state has not changed", async () => {
    const f = fixture(); f.setMode("no-transition"); await f.run();
    expect(f.receipt).toMatchObject({ status: "saved", reviewStatus: "failed", sourceState: "3" }); expect(submissions(f)).toBe(1);
  });
  it.each([null, "123", "unsafe"])("requires a source-assigned distinct reviewer (%s)", async reviewer => {
    const f = fixture(); f.setReviewer(reviewer); await f.run(); expect(f.receipt).toMatchObject({ status: "saved", reviewStatus: "failed" }); expect(submissions(f)).toBe(0);
  });
  it("does not resubmit or overwrite changed content", async () => {
    const f = fixture(); f.setMode("review-mismatch"); await f.run(); expect(f.receipt.reviewStatus).toBe("failed");
    await expect(f.run()).rejects.toThrow("已变化"); expect(saves(f)).toBe(1); expect(submissions(f)).toBe(1);
  });
  it("does not overwrite a demand already in review or regress a later state", async () => {
    const f = fixture(); f.setState("5"); await expect(f.run()).rejects.toThrow("当前状态"); expect(saves(f)).toBe(0);
    const g = fixture(); g.setMode("no-transition"); await g.run(); g.setState("7"); await g.run();
    expect(g.receipt.reviewStatus).toBe("failed"); expect(submissions(g)).toBe(1);
  });
  it("completes a legacy saved-only receipt without rewriting the report", async () => {
    const f = fixture(); f.setMode("rejected"); await f.run(); delete f.receipt.reviewStatus; delete f.receipt.reviewAttemptedAt;
    f.setMode("ok"); await f.run(); expect(f.receipt.reviewStatus).toBe("submitted"); expect(saves(f)).toBe(1);
  });
});
