import { describe, expect, it, vi } from "vitest";
import { readDeliveryDemand } from "./delivery-demand-lookup.js";

const input = { demandNo: "TWGF-00919", credentials: async () => ({ username: "fixture", password: "secret" }) };
function source(rows: Record<string, unknown>[], total = rows.length) {
  return vi.fn(async (target: URL | string | Request, init?: RequestInit) => {
    const url = new URL(String(target));
    if (url.pathname === "/api/auth/login") return new Response(JSON.stringify({ accessToken: "fixture-token" }));
    expect(url.searchParams.get("uc")).toBe("UC_PROJ2_DEMAND_ITEM_ALL_SEARCH");
    expect((init!.body as URLSearchParams).get("demandNo")).toBe("TWGF-00919");
    return new Response(JSON.stringify({ success: true, code: "0", rows, total }));
  });
}
describe("exact source demand lookup", () => {
  it("finds an unscheduled demand using only the exact demand endpoint and returns bounded public fields", async () => {
    const fetcher = source([{ urid: "200", demandNo: input.demandNo, theme: "未排期需求", demandState_show: "待需求分析", splitter_show: "拆分人员", requirementer_show: "分析人员", privateField: "not-public" }]);
    const result = await readDeliveryDemand(input, fetcher as typeof fetch);
    expect(result).toMatchObject({ demandNo: input.demandNo, title: "未排期需求", sourceStatus: "待需求分析", owner: "拆分人员", analysisOwner: "分析人员" });
    expect(JSON.stringify(result)).not.toContain("not-public");
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
  it.each([[], [{ urid: "200", demandNo: "TWGF-009190" }], [{ urid: "200", demandNo: input.demandNo }, { urid: "201", demandNo: input.demandNo }]].map(rows => ({ rows })))("rejects missing, partial and ambiguous matches", async ({ rows }) => {
    await expect(readDeliveryDemand(input, source(rows) as typeof fetch)).rejects.toMatchObject({ code: "invalid_response" });
  });
  it("rejects truncated source results", async () => {
    await expect(readDeliveryDemand(input, source([{ urid: "200", demandNo: input.demandNo }], 2) as typeof fetch)).rejects.toMatchObject({ code: "incomplete_response" });
  });
});
