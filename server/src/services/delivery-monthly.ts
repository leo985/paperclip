import type { DeliveryMonthlyEntries } from "@paperclipai/shared";
import { qingzhouClient, QingzhouReadError } from "./qingzhou-client.js";

// Keep slots busy when one upstream request is slow, without launching an
// unbounded request per entry. Stop taking new work after a failed read.
async function readConcurrent<T, R>(items: T[], limit: number, read: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = [];
  let next = 0, failed = false;
  const settled = await Promise.allSettled(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (!failed && next < items.length) {
      const index = next++;
      try { results[index] = await read(items[index]!); }
      catch (error) { failed = true; throw error; }
    }
  }));
  const rejection = settled.find(result => result.status === "rejected");
  if (rejection?.status === "rejected") throw rejection.reason;
  return results;
}

/** Read an entire month's schedule tree; never treat a failed/truncated read as empty. */
export async function readMonthlyDelivery(input: {
  organizationId: string; month: string; subProductAttribution?: string;
  credentials: () => Promise<{ username: string; password: string }>;
  client?: ReturnType<typeof qingzhouClient>;
  timings?: Record<string, number>;
}, fetcher: typeof fetch = fetch): Promise<DeliveryMonthlyEntries> {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(input.month)) throw new QingzhouReadError("invalid_response");
  const client = input.client ?? qingzhouClient({ credentials: input.credentials, fetch: fetcher });
  async function timed<T>(name: string, read: () => Promise<T>): Promise<T> {
    const start = performance.now();
    try { return await read(); }
    finally { if (input.timings) input.timings[name] = performance.now() - start; }
  }
  await timed("authentication", () => client.verifyAuthentication());
  // Both branches are independent. Drain both on failure before releasing the
  // coordinator's slot, so failed reads cannot leave unaccounted upstream work.
  const branches = await Promise.allSettled([
    timed("expected", () => input.subProductAttribution ? client.deliveryMonthDemands(input.month, input.subProductAttribution) : Promise.resolve([])),
    (async () => {
      const plans = await timed("plans", () => client.monthlyPlans(input.organizationId, [input.month, input.month]));
      if (!Array.isArray(plans.data.rows) || !Number.isSafeInteger(Number(plans.data.total)) || Number(plans.data.total) !== plans.data.rows.length) throw new QingzhouReadError("incomplete_response");
      const planIds = [...new Set(plans.data.rows.filter(r => String(r.organizationId) === input.organizationId).map(r => String(r.urid)))];
      if (planIds.length > 12 || planIds.some(id => !/^\d{1,30}$/.test(id))) throw new QingzhouReadError("invalid_response");
      return timed("trees", () => readConcurrent(planIds, 4, id => client.monthlyEntries(id)));
    })(),
  ]);
  const [dueResult, scheduleResult] = branches;
  if (dueResult.status === "rejected") throw dueResult.reason;
  if (scheduleResult.status === "rejected") throw scheduleResult.reason;
  const dueRows = dueResult.value, schedules = scheduleResult.value;
  const entries = new Map<string, DeliveryMonthlyEntries["items"][number]>();
  const identities = new Map<string, string>();
  const work = new Map<string, Set<string>>();
  const unresolvedOwners = new Set<string>();
  const unresolvedAnalysisOwners = new Set<string>();
  const unresolvedStatuses = new Set<string>();
  const text = (value: unknown) => typeof value === "string" ? value.slice(0, 500) : "";
  for (const response of schedules) {
    if (!Array.isArray(response.data.data)) throw new QingzhouReadError("invalid_response");
    for (const root of response.data.data) {
      if (!root || !/^[A-Z][A-Z0-9]*-\d+$/.test(root.demandNo) || !/^\d{1,30}$/.test(String(root.urid)) || (root.children !== null && !Array.isArray(root.children))) throw new QingzhouReadError("invalid_response");
      if (identities.has(root.demandNo) && identities.get(root.demandNo) !== String(root.urid)) throw new QingzhouReadError("invalid_response");
      identities.set(root.demandNo, String(root.urid));
      // Resolve omitted personnel and status fields in one exact demand lookup
      // per entry, preserving explicit empty owners.
      if (!entries.has(root.demandNo) && !Object.hasOwn(root, "splitter_show")) unresolvedOwners.add(root.demandNo);
      if (!entries.has(root.demandNo) && !Object.hasOwn(root, "requirementer_show")) unresolvedAnalysisOwners.add(root.demandNo);
      if (!text(root.demandState_show).trim()) unresolvedStatuses.add(root.demandNo);
      const item = entries.get(root.demandNo) ?? { demandNo: root.demandNo, title: text(root.theme || root.demandTheme || root.name), owner: text(root.splitter_show), analysisOwner: text(root.requirementer_show), sourceStatus: text(root.demandState_show), startDate: "", endDate: "", workCount: 0, snapshotId: null, admission: null };
      const keys = work.get(root.demandNo) ?? new Set<string>();
      let count = 0;
      function visit(rows: Record<string, any>[], depth: number) {
        if (depth > 5) throw new QingzhouReadError("invalid_response");
        for (const row of rows) {
          if (!row || typeof row !== "object" || ++count > 10000) throw new QingzhouReadError("invalid_response");
          if (typeof row.issueNo === "string" && /^[A-Z][A-Z0-9_]*-\d+$/.test(row.issueNo)) keys.add(row.issueNo);
          for (const [field, key] of [["preStartDate", "startDate"], ["preEndDate", "endDate"]] as const) {
            const value = text(row[field]).slice(0, 10);
            if (/^\d{4}-\d{2}-\d{2}$/.test(value) && (!item[key] || (key === "startDate" ? value < item[key] : value > item[key]))) item[key] = value;
          }
          if (row.children !== undefined && row.children !== null && !Array.isArray(row.children)) throw new QingzhouReadError("invalid_response");
          if (Array.isArray(row.children)) visit(row.children, depth + 1);
        }
      }
      visit(root.children ?? [], 0); work.set(root.demandNo, keys); item.workCount = keys.size; entries.set(root.demandNo, item);
      if (entries.size > 1000) throw new QingzhouReadError("incomplete_response");
    }
  }
  const dueByDemand = new Map(dueRows.map(row => [row.demandNo as string, row]));
  const demandLookups = [...new Set([...unresolvedOwners, ...unresolvedAnalysisOwners, ...unresolvedStatuses, ...(input.subProductAttribution ? entries.keys() : [])])];
  await timed("lookups", () => readConcurrent(demandLookups, 8, async demandNo => {
    const due = dueByDemand.get(demandNo);
    const row = due ?? (await client.demand(demandNo)).data.rows.find((row: Record<string, unknown>) => row.demandNo === demandNo);
    if (input.subProductAttribution && row.subProductAttribution !== input.subProductAttribution) { entries.delete(demandNo); return; }
    const item = entries.get(demandNo)!;
    // Only replace an omitted splitter, not an explicit blank source value.
    if (unresolvedOwners.has(demandNo)) item.owner = text(row.splitter_show);
    if (unresolvedAnalysisOwners.has(demandNo)) item.analysisOwner = text(row.requirementer_show);
    item.sourceStatus = text(row.demandState_show) || item.sourceStatus;
  }));
  for (const item of entries.values()) { item.inSchedule = true; item.inExpectedDeliveryMonth = false; }
  for (const row of dueRows) {
    const previous = entries.get(row.demandNo);
    if (identities.has(row.demandNo) && identities.get(row.demandNo) !== String(row.urid)) throw new QingzhouReadError("invalid_response");
    const item: DeliveryMonthlyEntries["items"][number] = previous ?? { demandNo: row.demandNo, title: text(row.theme), owner: text(row.splitter_show), analysisOwner: text(row.requirementer_show), sourceStatus: text(row.demandState_show), startDate: "", endDate: "", workCount: 0, workCountKnown: false, snapshotId: null, admission: null };
    item.expectedDeliveryDate = text(row.estimatedDeliveryDate);
    item.inSchedule = !!previous;
    item.inExpectedDeliveryMonth = true;
    entries.set(row.demandNo, item);
  }
  if (entries.size > 1000) throw new QingzhouReadError("incomplete_response");
  return { month: input.month, collectedAt: new Date().toISOString(), items: [...entries.values()].sort((a,b) => a.demandNo.localeCompare(b.demandNo)), executionAllowed: false };
}
