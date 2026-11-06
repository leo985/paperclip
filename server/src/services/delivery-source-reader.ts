import type { DeliverySnapshotInput } from "@paperclipai/shared";
import { qingzhouClient, QingzhouReadError, QINGZHOU_ORIGIN, parseQingzhouJson } from "./qingzhou-client.js";
import { normalizeDeliverySnapshot } from "./delivery-intake.js";

export async function readOnlineDelivery(input: {
  projectId: string; demandNo: string; months: string[]; organizationId: string;
  credentials: () => Promise<{ username: string; password: string }>;
  jira: { baseUrl: string; token: string };
}, fetcher: typeof fetch = fetch) {
  const client = qingzhouClient({ credentials: input.credentials, fetch: fetcher });
  const demand = await client.demand(input.demandNo), analysis = await client.analysis(demand.demandId);
  const detail = await client.detail(demand.demandId);
  const mains = analysis.data.data?.demandIssuePoList;
  if (!Array.isArray(mains)) throw new QingzhouReadError("invalid_response");
  const mainKeys = mains.filter(row => row.del === 0).map(row => row.itemNo);
  if (mainKeys.some(key => typeof key !== "string" || !/^[A-Z][A-Z0-9_]*-\d+$/.test(key)) || mainKeys.length > 100) throw new QingzhouReadError("invalid_response");
  const manageIds = new Set<string>();
  for (const month of [...new Set(input.months)].sort()) {
    const plans = await client.monthlyPlans(input.organizationId, [month, month]);
    const rows = plans.data.rows;
    if (!Array.isArray(rows) || !Number.isSafeInteger(Number(plans.data.total)) || Number(plans.data.total) !== rows.length) throw new QingzhouReadError("incomplete_response");
    const matching = rows.filter(row => String(row.organizationId) === input.organizationId);
    if (!matching.length) throw new QingzhouReadError("incomplete_response");
    for (const plan of matching) {
      const id = String(plan.urid);
      if (!/^\d{1,30}$/.test(id)) throw new QingzhouReadError("invalid_response");
      manageIds.add(id);
    }
    if (manageIds.size > 12) throw new QingzhouReadError("incomplete_response");
  }
  if (!manageIds.size) throw new QingzhouReadError("incomplete_response");
  const schedules: string[] = [];
  for (const id of manageIds) {
    const response = await client.schedule(id, input.demandNo);
    if (!Array.isArray(response.data.data)) throw new QingzhouReadError("invalid_response");
    if (response.data.data.some(row => row.demandNo === input.demandNo)) schedules.push(response.raw);
  }
  if (!schedules.length) throw new QingzhouReadError("incomplete_response");
  const jiraUrl = new URL(input.jira.baseUrl);
  const origins = (process.env.PAPERCLIP_JIRA_ALLOWED_ORIGINS ?? "http://jira.fingard.com:6001").split(",").map(value => value.trim());
  if (!origins.includes(jiraUrl.origin) || jiraUrl.username || jiraUrl.password || jiraUrl.search || jiraUrl.hash || jiraUrl.pathname !== "/") throw new QingzhouReadError("source_rejected");
  const rows: unknown[] = [];let total: number | null = null;
  if (mainKeys.length) {
    for (let start = 0; ; ) {
      const keys = mainKeys.map(key => `"${key}"`).join(",");
      const url = new URL("/rest/api/2/search", jiraUrl);
      url.search = new URLSearchParams({ jql: `key in (${keys}) OR parent in (${keys}) ORDER BY key ASC`, fields: "summary,status,issuetype,assignee,parent,subtasks", startAt: String(start), maxResults: "100" }).toString();
      let response: Response;
      try { response = await fetcher(url, { headers: { Authorization: "Bearer " + input.jira.token, Accept: "application/json" }, redirect: "error", signal: AbortSignal.timeout(15_000) }); }
      catch { throw new QingzhouReadError("connection_unavailable"); }
      if (!response.ok) throw new QingzhouReadError("source_rejected");
      // Jira pages are bounded by count and byte size; never silently truncate.
      const reader = response.body?.getReader();if (!reader) throw new QingzhouReadError("invalid_response");
      let raw = "", bytes = 0;const decoder = new TextDecoder();
      try {
        for (;;) { const item = await reader.read();if (item.done) break;bytes += item.value.byteLength;if (bytes > 2_000_000) { await reader.cancel();throw new QingzhouReadError("incomplete_response"); }raw += decoder.decode(item.value, { stream: true }); }
      } catch (error) { if (error instanceof QingzhouReadError) throw error;throw new QingzhouReadError("connection_unavailable"); }
      finally { reader.releaseLock(); }
      const page = parseQingzhouJson(raw + decoder.decode());
      if (!Array.isArray(page.issues) || !Number.isSafeInteger(page.total) || page.total < 0 || page.total > 1000 || page.startAt !== start || total !== null && page.total !== total) throw new QingzhouReadError("incomplete_response");
      const pageTotal = page.total as number;total = pageTotal;rows.push(...page.issues);start += page.issues.length;
      if (start === pageTotal) break;
      if (start > pageTotal || !page.issues.length) throw new QingzhouReadError("incomplete_response");
    }
  }
  const collectedAt = new Date().toISOString();
  const snapshot: DeliverySnapshotInput = { projectId: input.projectId, sourceOrigin: QINGZHOU_ORIGIN, demandNo: input.demandNo, collectedAt,
    demandJson: demand.raw, detailJson: detail.raw, analysisJson: analysis.raw, scheduleJsons: schedules, jiraJson: JSON.stringify({ startAt: 0, total: rows.length, issues: rows }) };
  return { plan: normalizeDeliverySnapshot(snapshot, "online_readonly"), collectedAt };
}
