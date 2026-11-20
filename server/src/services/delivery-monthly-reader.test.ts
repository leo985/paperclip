import { afterEach, describe, expect, it, vi } from "vitest";
import { createMonthlyDeliveryReader as createReader } from "./delivery-monthly-reader.js";
import { readMonthlyDelivery } from "./delivery-monthly.js";

const createMonthlyDeliveryReader: typeof createReader = (reader, options = {}) => createReader(reader, { sourceTtlMs: 0, ...options });
const scope = { companyId: "company", projectId: "project", connectionId: "connection", revision: 1, credentialVersion: "v1" };
const input = { organizationId: "123", month: "2026-10", credentials: async () => ({ username: "fixture", password: "secret" }) };
const result = () => ({ month: input.month, collectedAt: "2026-11-13T00:00:00Z", executionAllowed: false as const, items: [{ demandNo: "DSP-1", title: "Title", owner: "", sourceStatus: "", startDate: "", endDate: "", workCount: 0, snapshotId: null, admission: null }] });
function gate() { let release!: () => void; const promise = new Promise<void>(resolve => { release = resolve; }); return { promise, release }; }
afterEach(() => vi.useRealTimers());

describe("bounded monthly source reader", () => {
  it("coalesces only in-flight source reads and gives annotations independent rows", async () => {
    const blocked = gate(), reader = vi.fn(async () => { await blocked.promise; return result(); });
    const read = createMonthlyDeliveryReader(reader);
    const first = read(scope, input), second = read(scope, input);
    await vi.waitFor(() => expect(reader).toHaveBeenCalledTimes(1));
    blocked.release();
    const [a, b] = await Promise.all([first, second]);
    expect(a.shared).toBe(false); expect(b.shared).toBe(true);
    a.result.items[0]!.snapshotId = "request-local";
    expect(b.result.items[0]!.snapshotId).toBeNull();
    await read(scope, input);
    expect(reader).toHaveBeenCalledTimes(2);
  });

  it("isolates company, project, connection, revision, credentials, month and source scope", async () => {
    const blocked = gate(), reader = vi.fn(async () => { await blocked.promise; return result(); });
    const read = createMonthlyDeliveryReader(reader, { maxActive: 12 });
    const calls = [read(scope, input),
      ...Object.entries({ companyId: "other", projectId: "other", connectionId: "other", revision: 2, credentialVersion: "v2" }).map(([key, value]) => read({ ...scope, [key]: value }, input)),
      read(scope, { ...input, month: "2026-11" }), read(scope, { ...input, organizationId: "456" }), read(scope, { ...input, subProductAttribution: "DSP" })];
    await vi.waitFor(() => expect(reader).toHaveBeenCalledTimes(9));
    blocked.release(); await Promise.all(calls);
  });

  it("bounds active work and queue, coalesces while queued, and recovers after failure", async () => {
    const blocked = gate(); let attempts = 0;
    const reader = vi.fn(async () => { if (++attempts === 1) { await blocked.promise; throw Error("upstream failed"); } return result(); });
    const read = createMonthlyDeliveryReader(reader, { maxActive: 1, maxQueued: 1 });
    const first = read(scope, input); const failure = expect(first).rejects.toThrow("upstream failed");
    const second = read(scope, { ...input, month: "2026-11" });
    const shared = read(scope, { ...input, month: "2026-11" });
    await expect(read(scope, { ...input, month: "2026-12" })).rejects.toMatchObject({ code: "connection_unavailable" });
    expect(reader).toHaveBeenCalledTimes(1);
    blocked.release(); await failure;
    await Promise.all([second, shared]);
    await read(scope, input);
    expect(reader).toHaveBeenCalledTimes(3);
  });

  it("reuses login across months and expires sessions without retaining completed source results", async () => {
    vi.useFakeTimers();
    let logins = 0;
    const fetcher = vi.fn(async (target: URL | string | Request) => {
      if (new URL(String(target)).pathname === "/api/auth/login") { logins++; return Response.json({ accessToken: "fixture-token" }); }
      return Response.json({ success: true, code: "0", total: 0, rows: [] });
    });
    const read = createMonthlyDeliveryReader(readMonthlyDelivery, { fetch: fetcher as typeof fetch, sessionTtlMs: 1000 });
    await read(scope, input); await read(scope, { ...input, month: "2026-11" });
    expect(logins).toBe(1);
    await read({ ...scope, credentialVersion: "v2" }, input);
    expect(logins).toBe(2);
    await vi.advanceTimersByTimeAsync(1001);
    await read(scope, input); expect(logins).toBe(3);
  });

  it("evicts least recently used sessions at the capacity bound", async () => {
    const clients: unknown[] = [];
    const read = createMonthlyDeliveryReader(async input => { clients.push(input.client); return result(); }, { maxSessions: 1 });
    await read(scope, input); await read(scope, input);
    await read({ ...scope, companyId: "other" }, input); await read(scope, input);
    expect(clients[0]).toBe(clients[1]); expect(clients[0]).not.toBe(clients[3]);
  });
});

it("caches only source rows with original collection time, expires, and returns independent copies", async () => {
  vi.useFakeTimers();
  const reader=vi.fn(async()=>result()),read=createReader(reader,{sourceTtlMs:1000});
  const first=await read(scope,input);first.result.items[0]!.snapshotId="annotation";
  const second=await read(scope,input);expect(second.cached).toBe(true);expect(second.result.items[0]!.snapshotId).toBeNull();
  expect(second.result.collectedAt).toBe(first.result.collectedAt);expect(reader).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(1001);expect((await read(scope,input)).cached).toBe(false);expect(reader).toHaveBeenCalledTimes(2);
});

it("manual refresh bypasses old in-flight work and prevents its late result replacing the new result", async () => {
  const old=gate(),fresh=gate();let calls=0;
  const read=createReader(async()=>{const call=++calls;await (call===1?old:fresh).promise;return {...result(),collectedAt:String(call)};});
  const a=read(scope,input);await vi.waitFor(()=>expect(calls).toBe(1));
  const b=read(scope,input,true);await vi.waitFor(()=>expect(calls).toBe(2));
  fresh.release();expect((await b).result.collectedAt).toBe("2");
  old.release();await a;
  expect((await read(scope,input)).result.collectedAt).toBe("2");expect(calls).toBe(2);
});

it("a failed refresh clears the previous result and remains retryable", async()=>{
  const reader=vi.fn(async()=>result()),read=createReader(reader);
  await read(scope,input);reader.mockRejectedValueOnce(Error("source failed"));
  await expect(read(scope,input,true)).rejects.toThrow("source failed");
  expect((await read(scope,input)).cached).toBe(false);expect(reader).toHaveBeenCalledTimes(3);
});

it("bounds source results by both count and serialized byte size",async()=>{
  const reader=vi.fn(async()=>result()),read=createReader(reader,{maxResults:1});
  await read(scope,input);await read(scope,{...input,month:"2026-11"});await read(scope,input);
  expect(reader).toHaveBeenCalledTimes(3);
  const oversized=createReader(reader,{maxResultBytes:1});
  await oversized(scope,input);expect((await oversized(scope,input)).cached).toBe(false);
});
