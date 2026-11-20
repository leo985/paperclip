import { describe, expect, it, vi } from "vitest";
import { qingzhouClient, QingzhouReadError, parseQingzhouJson } from "./qingzhou-client.js";
const credentials = async () => ({ username: "test-user", password: "fixture-password" });
const success = (data: Record<string, unknown> = {}) => new Response(JSON.stringify({ success: true, code: "0", ...data }));
const authenticated = () => new Response(JSON.stringify({ accessToken: "fixture-token" }));
describe("Qingzhou read-only source client", () => {
  it("reads every delivery-month page with a stable product and date filter", async () => {
    const rows=Array.from({length:101},(_,i)=>({urid:String(200+i),demandNo:`TWGF-${i}`,subProductAttribution:"DSP",estimatedDeliveryDate:"2026-11-01"}));
    const fetcher=vi.fn(async(url:string,init?:RequestInit)=>{
      if(url.includes("/auth/login"))return authenticated();
      const body=init!.body as URLSearchParams;
      expect(body.get("estimatedDeliveryDate")).toBe("2026-11-01,2026-11-30");
      expect(body.get("subProductAttribution")).toBe("DSP");expect(body.get("sortName")).toBe("urid");
      const page=Number(body.get("pageNum"));return success({total:101,rows:rows.slice((page-1)*100,page*100)});
    });
    expect(await qingzhouClient({credentials,fetch:fetcher as typeof fetch}).deliveryMonthDemands("2026-11","DSP")).toHaveLength(101);
    expect(fetcher).toHaveBeenCalledTimes(3);
  });
  it("rejects ignored product/month filters, repeated pages and inconsistent totals", async()=>{
    const good={urid:"200",demandNo:"TWGF-00919",subProductAttribution:"DSP",estimatedDeliveryDate:"2026-11-01"};
    for(const pages of [
      [{total:1,rows:[{...good,subProductAttribution:"ATS"}]}],
      [{total:1,rows:[{...good,estimatedDeliveryDate:"2026-10-01"}]}],
      [{total:2,rows:[good]},{total:2,rows:[good]}],
      [{total:2,rows:[good]},{total:3,rows:[]}],
      [{total:2,rows:[good]},{total:2,rows:[]}],
    ]) {
      const fetcher=vi.fn().mockResolvedValueOnce(authenticated());for(const page of pages)fetcher.mockResolvedValueOnce(success(page));
      await expect(qingzhouClient({credentials,fetch:fetcher}).deliveryMonthDemands("2026-11","DSP")).rejects.toBeInstanceOf(QingzhouReadError);
    }
  });
  it("saves analysis using multipart dotted DTO fields and never retries ambiguous writes", async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(authenticated()).mockRejectedValueOnce(new Error("lost response private-token"));
    const client = qingzhouClient({ credentials, fetch: fetcher });
    await expect(client.saveAnalysis("1828643972046290945", {theme:"主题", "demandAnalysisDto.analysisResult":"<pre>分析</pre>"})).rejects.toMatchObject({code:"connection_unavailable"});
    expect(fetcher).toHaveBeenCalledTimes(2);
    const [url, request] = fetcher.mock.calls[1]!;
    expect(new URL(url).searchParams.get("uc")).toBe("UC_PROJ2_DEMAND_SPLIT_ANALYZE");
    expect(request.body).toBeInstanceOf(FormData);
    expect(request.body.get("urid")).toBe("1828643972046290945");
    expect(request.body.get("demandAnalysisDto.analysisResult")).toBe("<pre>分析</pre>");
    expect(request.headers["Content-Type"]).toBeUndefined();
    expect(request.redirect).toBe("error");
  });
  it("uses the existing login form contract and preserves 19-digit source identifiers", async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(authenticated()).mockResolvedValueOnce(new Response('{"success":true,"code":"0","total":1,"rows":[{"demandNo":"ATS3-00156","urid":1828643972046290945}]}'));
    const client = qingzhouClient({ credentials, fetch: fetcher });
    const result = await client.demand("ATS3-00156");
    expect(result.demandId).toBe("1828643972046290945");
    const login = fetcher.mock.calls[0]!;
    expect(login[0]).toBe("http://gateway.proj-prod.avatar.fingard.cn/api/auth/login");
    expect(JSON.parse(login[1].body.get("username"))).toEqual(await credentials());
    expect(login[1].body.get("password")).toBe("fixture-password");
    const query = fetcher.mock.calls[1]!;
    expect(query[1].body.get("demandNo")).toBe("ATS3-00156");
    expect(query[1].headers.Cookie).toBe("token=fixture-token; SESSION=fixture-token");
    expect(query[1].redirect).toBe("error");
    expect(JSON.stringify(result)).not.toContain("fixture-token");
  });
  it("coalesces concurrent authentication and puts schedule filters in the URL", async () => {
    const fetcher = vi.fn(async (url: string) => url.includes("/auth/login") ? authenticated() : success({ data: [] }));
    const client = qingzhouClient({ credentials, fetch: fetcher as typeof fetch });
    await Promise.all([client.schedule("123456", "ATS3-00156"), client.analysis("1828643972046290945")]);
    expect(fetcher.mock.calls.filter(([url]) => url.includes("/auth/login"))).toHaveLength(1);
    const schedule = fetcher.mock.calls.find(([url]) => url.includes("SCHEDULE_ISSUE_SEARCH"))!;
    const url = new URL(schedule[0]); expect(url.searchParams.get("manageId")).toBe("123456");
    expect(url.searchParams.get("number")).toBe("ATS3-00156");expect(url.searchParams.get("type")).toBe("1");
  });
  it("renews an expired token once and never retries indefinitely", async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(authenticated()).mockResolvedValueOnce(new Response("expired", { status: 401 }))
      .mockResolvedValueOnce(authenticated()).mockResolvedValueOnce(new Response("denied", { status: 403 }));
    await expect(qingzhouClient({ credentials, fetch: fetcher }).analysis("123")).rejects.toMatchObject({ code: "authentication_required" });
    expect(fetcher).toHaveBeenCalledTimes(4);
  });
  it("rejects truncated, unsuccessful, oversized or malformed source results", async () => {
    for (const response of [success({ total: 2, rows: [{ urid: "123", demandNo: "ATS3-00156" }] }),
      new Response('{"success":false,"code":"0"}'), new Response('<html>login</html>'),
      new Response("x".repeat(2_000_001))]) {
      const fetcher = vi.fn().mockResolvedValueOnce(authenticated()).mockResolvedValueOnce(response);
      await expect(qingzhouClient({ credentials, fetch: fetcher }).demand("ATS3-00156")).rejects.toBeInstanceOf(QingzhouReadError);
    }
  });
  it("keeps credential and upstream exception content out of errors", async () => {
    const fetcher = vi.fn().mockRejectedValue(new Error("secret-password token=private"));
    try { await qingzhouClient({ credentials, fetch: fetcher }).analysis("123"); throw new Error("Expected failure"); }
    catch (error) { expect(error).toMatchObject({ code: "connection_unavailable" });expect(String(error)).not.toMatch(/secret-password|private/); }
  });
  it("does not call the network for invalid source identifiers", async () => {
    const fetcher = vi.fn();const client = qingzhouClient({ credentials, fetch: fetcher });
    await expect(client.demand("../unsafe")).rejects.toBeInstanceOf(QingzhouReadError);
    expect(() => client.monthlyPlans("123", ["2026-13"])).toThrow(QingzhouReadError);
    expect(() => client.schedule("https://elsewhere", "ATS3-00156")).toThrow(QingzhouReadError);
    expect(fetcher).not.toHaveBeenCalled();
    expect(parseQingzhouJson('{"id":1828643972046290945}').id).toBe("1828643972046290945");
  });
  it("reads a full monthly tree above the single-item limit without enlarging other reads", async () => {
    const payload = { data: [{ urid: "200", demandNo: "ATS3-00156", children: null, theme: "月".repeat(750_000) }] };
    const fetcher = vi.fn(async (url: string) => url.includes("/auth/login") ? authenticated() : success(payload));
    const client = qingzhouClient({ credentials, fetch: fetcher as typeof fetch });
    const result = await client.monthlyEntries("123");
    expect(result.data.data).toHaveLength(1);
    expect(new TextEncoder().encode(result.raw).length).toBeGreaterThan(2_000_000);
    await expect(client.analysis("123")).rejects.toMatchObject({ code: "invalid_response" });
    await expect(client.schedule("123", "ATS3-00156")).rejects.toMatchObject({ code: "invalid_response" });
  });
  it.each([false, true])("bounds monthly responses and cancels their body (declared length: %s)", async (declared) => {
    const cancel = vi.fn();
    const response = new Response(new ReadableStream({
      start(controller) { controller.enqueue(new Uint8Array(8_000_001)); },
      cancel,
    }), { headers: declared ? { "content-length": "8000001" } : {} });
    const fetcher = vi.fn().mockResolvedValueOnce(authenticated()).mockResolvedValueOnce(response);
    await expect(qingzhouClient({ credentials, fetch: fetcher }).monthlyEntries("123")).rejects.toMatchObject({ code: "invalid_response" });
    expect(cancel).toHaveBeenCalledOnce();
  });

});
