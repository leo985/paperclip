import { describe, expect, it, vi } from "vitest";
import { readOnlineDelivery } from "./delivery-source-reader.js";
import { fixture } from "./delivery-intake.fixture.js";
const input = { projectId: fixture().projectId, demandNo: "ATS3-00156", months: ["2026-08", "2026-09"], organizationId: "123",
  credentials: async () => ({ username: "fixture", password: "fixture-password" }), jira: { baseUrl: "http://jira.fingard.com:6001", token: "fixture-pat" } };
function source(options: { truncated?: boolean; wrongOrg?: boolean; secondJira?: boolean; detailRejected?: boolean } = {}) {
  const f = fixture();
  return vi.fn(async (target: URL | string | Request, _init?: RequestInit) => {
    const url = new URL(String(target));let raw;
    if (url.pathname === "/api/auth/login") raw = JSON.stringify({ accessToken: "fixture-token" });
    else if (url.searchParams.get("uc") === "UC_PROJ2_DEMAND_ITEM_ALL_SEARCH") raw = f.demandJson;
    else if (url.searchParams.get("uc") === "UC_PROJ2_DEMAND_DETAIL") {
      if (options.detailRejected) return new Response(JSON.stringify({success:false,code:"403"}));
      expect(new URLSearchParams(String(_init?.body)).get("demandId")).toBe("1828643972046290945");
      raw = JSON.stringify({success:true,code:"0",data:{demandDto:{urid:"1828643972046290945",demandNo:input.demandNo},demandAnalysisDetailsDTO:{analysisResult:"<p>分析结论</p>"},demandReviewStageDtoList:[{role:"需求评审",statusTranslate:"通过"}]}});
    }
    else if (url.searchParams.get("uc") === "UC_PROJ2_DEMAND_GET_DEMAND_ANALYSIS") raw = f.analysisJson;
    else if (url.searchParams.get("uc") === "UC_PROJ2_SCHEDULE_ALLOT_SEARCH") {
      expect(url.searchParams.get("targetDate")?.split(",")).toHaveLength(2);
      raw = JSON.stringify({ success: true, code: "0", total: 1, rows: [{ organizationId: options.wrongOrg ? "other" : "123", urid: "1828643972046290001" }] });
    } else if (url.searchParams.get("uc") === "UC_PROJ2_SCHEDULE_ISSUE_SEARCH") raw = f.scheduleJsons[0];
    else if (url.pathname === "/rest/api/2/search") {
      const jira = JSON.parse(f.jiraJson);const start = Number(url.searchParams.get("startAt"));
      raw = JSON.stringify({ startAt: start, total: options.truncated ? 4 : jira.total, issues: start === 0 ? jira.issues.slice(0, 2) : options.truncated ? [] : jira.issues.slice(2) });
    } else throw Error("Unexpected source");
    return new Response(raw);
  });
}
describe("online delivery snapshot assembly", () => {
  it("reads all Jira pages, deduplicates plan contexts and never grants execution", async () => {
    const fetcher = source();const result = await readOnlineDelivery(input, fetcher as typeof fetch);
    expect(result.plan).toMatchObject({ sourceMode: "online_readonly", executionAllowed: false, scheduleCount: 1 });
    expect(result.plan.sourceAnalysis).toMatchObject({analysisSaved:true,reviewStages:[{role:"需求评审",status:"通过"}]});
    expect(result.plan.items).toHaveLength(3);
    expect(fetcher.mock.calls.filter(([target]) => String(target).includes("SCHEDULE_ISSUE_SEARCH"))).toHaveLength(1);
    const jira = fetcher.mock.calls.filter(([target]) => String(target).includes("/rest/api/2/search"));
    expect(jira).toHaveLength(2);expect(jira[0]![1]?.headers).toMatchObject({ Authorization: "Bearer fixture-pat" });
    expect(JSON.stringify(result)).not.toMatch(/fixture-pat|fixture-password|fixture-token/);
  });
  it("rejects an incomplete Jira page and unrelated organization plans", async () => {
    await expect(readOnlineDelivery(input, source({ truncated: true }) as typeof fetch)).rejects.toMatchObject({ code: "incomplete_response" });
    await expect(readOnlineDelivery(input, source({ wrongOrg: true }) as typeof fetch)).rejects.toMatchObject({ code: "incomplete_response" });
  });
  it("surfaces rejected detail queries instead of silently treating missing analysis as unarranged", async () => {
    await expect(readOnlineDelivery(input, source({ detailRejected: true }) as typeof fetch)).rejects.toMatchObject({code:"source_rejected"});
  });
  it("does not send Jira credentials to an unapproved origin", async () => {
    const fetcher = source();await expect(readOnlineDelivery({ ...input, jira: { ...input.jira, baseUrl: "http://unapproved.example" } }, fetcher as typeof fetch)).rejects.toMatchObject({ code: "source_rejected" });
    expect(fetcher.mock.calls.some(([target]) => String(target).includes("unapproved"))).toBe(false);
  });
});
