import { createHash } from "node:crypto";
import { readMonthlyDelivery } from "./delivery-monthly.js";
import { qingzhouClient, QingzhouReadError } from "./qingzhou-client.js";

type Input = Parameters<typeof readMonthlyDelivery>[0];
type Scope = { companyId: string; projectId: string; connectionId: string; revision: number; credentialVersion: string };
type ReadResult = { result: Awaited<ReturnType<typeof readMonthlyDelivery>>; timings: Record<string, number> };

/** Router-local, bounded source/auth state. Admission is always request-local. */
export function createMonthlyDeliveryReader(reader = readMonthlyDelivery, options: {
  fetch?: typeof fetch; sessionTtlMs?: number; maxSessions?: number; maxActive?: number; maxQueued?: number;
  sourceTtlMs?: number; maxResults?: number; maxResultBytes?: number;
} = {}) {
  const maxSessions = options.maxSessions ?? 32, maxActive = options.maxActive ?? 4, maxQueued = options.maxQueued ?? 12;
  const sessionTtlMs = options.sessionTtlMs ?? 10 * 60_000;
  const sourceTtlMs = options.sourceTtlMs ?? 30_000, maxResults = options.maxResults ?? 32, maxResultBytes = options.maxResultBytes ?? 8 * 1024 * 1024;
  if ([maxSessions, maxActive, sessionTtlMs, maxResults, maxResultBytes].some(value => !Number.isSafeInteger(value) || value < 1)
    || [maxQueued, sourceTtlMs].some(value => !Number.isSafeInteger(value) || value < 0)) throw new Error("Invalid monthly reader limits");
  type Cached = { json: string; bytes: number; expiresAt: number; timer: ReturnType<typeof setTimeout> };
  const results = new Map<string, Cached>();
  let resultBytes = 0;
  function removeResult(key: string) {
    const cached = results.get(key);
    if (cached) { resultBytes -= cached.bytes; clearTimeout(cached.timer); results.delete(key); }
  }
  function saveResult(key: string, result: ReadResult["result"]) {
    if (!sourceTtlMs) return;
    const json = JSON.stringify(result), bytes = Buffer.byteLength(json);
    if (bytes > maxResultBytes) return;
    removeResult(key);
    while (results.size >= maxResults || resultBytes + bytes > maxResultBytes) removeResult(results.keys().next().value!);
    const timer = setTimeout(() => removeResult(key), sourceTtlMs); timer.unref?.();
    results.set(key, { json, bytes, expiresAt: Date.now() + sourceTtlMs, timer }); resultBytes += bytes;
  }
  type Session = { client: ReturnType<typeof qingzhouClient>; expiresAt: number; timer: ReturnType<typeof setTimeout> };
  const sessions = new Map<string, Session>();
  const pending = new Map<string, Promise<ReadResult>>();
  const queue: Array<() => void> = [];
  let active = 0;

  function removeSession(key: string) {
    const session = sessions.get(key);
    if (session) clearTimeout(session.timer);
    sessions.delete(key);
  }
  function sessionFor(key: string, credentials: Input["credentials"]) {
    let session = sessions.get(key);
    if (session && session.expiresAt <= Date.now()) { removeSession(key); session = undefined; }
    if (session) {
      sessions.delete(key); sessions.set(key, session);
      return session;
    }
    while (sessions.size >= maxSessions) removeSession(sessions.keys().next().value!);
    const timer = setTimeout(() => removeSession(key), sessionTtlMs);
    timer.unref?.();
    session = { client: qingzhouClient({ credentials, fetch: options.fetch }), expiresAt: Date.now() + sessionTtlMs, timer };
    sessions.set(key, session);
    return session;
  }
  async function acquire() {
    if (active < maxActive) { active++; return; }
    if (queue.length >= maxQueued) throw new QingzhouReadError("connection_unavailable");
    await new Promise<void>(resolve => queue.push(resolve));
  }
  function release() {
    const next = queue.shift();
    if (next) next(); else active--;
  }

  return async (scope: Scope, input: Input, forceRefresh = false) => {
    // Fingerprints contain no plaintext credentials and never leave this module.
    const sessionKey = createHash("sha256").update(JSON.stringify(scope)).digest("hex");
    const requestKey = JSON.stringify([sessionKey, input.organizationId, input.subProductAttribution ?? null, input.month]);
    if (forceRefresh) removeResult(requestKey);
    const cached = results.get(requestKey);
    if (cached && cached.expiresAt > Date.now()) {
      results.delete(requestKey); results.set(requestKey, cached);
      return { result: JSON.parse(cached.json) as ReadResult["result"], timings: {} as Record<string, number>, shared: false, cached: true };
    }
    removeResult(requestKey);
    let work = forceRefresh ? undefined : pending.get(requestKey);
    const shared = !!work;
    if (!work) {
      work = (async () => {
        const timings: Record<string, number> = {}, started = performance.now();
        await acquire();
        timings.queue = performance.now() - started;
        let session: Session | undefined;
        try {
          session = sessionFor(sessionKey, input.credentials);
          const sourceStart = performance.now();
          const result = await reader({ ...input, client: session.client, timings });
          timings.source = performance.now() - sourceStart;
          return { result, timings };
        } catch (error) {
          if (session && sessions.get(sessionKey) === session) removeSession(sessionKey);
          throw error;
        } finally { release(); }
      })();
      pending.set(requestKey, work);
      // Both handlers clean up; avoid a rejected, unobserved finally promise.
      void work.then(value => {
        if (pending.get(requestKey) !== work) return;
        saveResult(requestKey, value.result); pending.delete(requestKey);
      }, () => { if (pending.get(requestKey) === work) pending.delete(requestKey); });
    }
    const value = await work;
    // Annotation mutates rows; each caller must own an independent source copy.
    return { result: structuredClone(value.result), timings: { ...value.timings }, shared, cached: false };
  };
}
