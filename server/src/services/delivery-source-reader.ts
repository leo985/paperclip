import type { DeliverySnapshotInput } from "@paperclipai/shared";
import { qingzhouClient, QingzhouReadError, QINGZHOU_ORIGIN, parseQingzhouJson } from "./qingzhou-client.js";
import { normalizeDeliverySnapshot } from "./delivery-intake.js";
import { jiraRequirementOwner, jiraRequirementOwnerField } from "./jira-requirement-plan.js";

export async function readOnlineDelivery(input: {
  projectId: string; demandNo: string; months: string[]; organizationId: string;
  subProductAttribution?: string;
  credentials: () => Promise<{ username: string; password: string }>;
  jira: { baseUrl: string; token: string };
}, fetcher: typeof fetch = fetch) {
  const client = qingzhouClient({ credentials: input.credentials, fetch: fetcher });
  const demand = await client.demand(input.demandNo), analysis = await client.analysis(demand.demandId);
  const demandRow = demand.data.rows.find((row: Record<string, unknown>) => row.demandNo === input.demandNo)!;
  if (input.subProductAttribution && demandRow.subProductAttribution !== input.subProductAttribution) throw new QingzhouReadError("source_rejected");
  const detail = await client.detail(demand.demandId);
  const mains = analysis.data.data?.demandIssuePoList;
  if (!Array.isArray(mains)) throw new QingzhouReadError("invalid_response");
  const mainKeys = mains.filter(row => row.del === 0).map(row => row.itemNo);
  if (mainKeys.some(key => typeof key !== "string" || !/^[A-Z][A-Z0-9_]*-\d+$/.test(key)) || mainKeys.length > 100) throw new QingzhouReadError("invalid_response");
  const manageIds = new Set<string>();
  const projectPlanMonths = new Map<string, Set<string>>();
  const reportMonths = new Set<string>();
  // Delivery-month intake must collect each demand's own organizations, rather
  // than requiring membership of the project's original single schedule group.
  const organizations = input.subProductAttribution
    ? [...new Set([input.organizationId, demandRow.projectGroup, demandRow.projectTestGroup, demandRow.splitterGroup].filter((value): value is string => typeof value === "string" && /^\d{1,30}$/.test(value)))]
    : [input.organizationId];
  for (const month of [...new Set(input.months)].sort()) {
    for (const organizationId of organizations) {
      const plans = await client.monthlyPlans(organizationId, [month, month]);
      const rows = plans.data.rows;
      if (!Array.isArray(rows) || !Number.isSafeInteger(Number(plans.data.total)) || Number(plans.data.total) !== rows.length) throw new QingzhouReadError("incomplete_response");
      const matching = rows.filter(row => String(row.organizationId) === organizationId);
      if (!matching.length && !input.subProductAttribution) throw new QingzhouReadError("incomplete_response");
      for (const plan of matching) {
        const id = String(plan.urid);
        if (!/^\d{1,30}$/.test(id)) throw new QingzhouReadError("invalid_response");
        manageIds.add(id);
        if (organizationId === input.organizationId) {
          const months = projectPlanMonths.get(id) ?? new Set<string>();
          months.add(month);
          projectPlanMonths.set(id, months);
        }
      }
      if (manageIds.size > (input.subProductAttribution ? 48 : 12)) throw new QingzhouReadError("incomplete_response");
    }
  }
  if (!manageIds.size && !input.subProductAttribution) throw new QingzhouReadError("incomplete_response");
  const schedules: string[] = [];
  for (const id of manageIds) {
    const response = await client.schedule(id, input.demandNo);
    if (!Array.isArray(response.data.data)) throw new QingzhouReadError("invalid_response");
    if (response.data.data.some(row => row.demandNo === input.demandNo)) {
      schedules.push(response.raw);
      for (const month of projectPlanMonths.get(id) ?? []) reportMonths.add(month);
    }
  }
  if (!schedules.length && !input.subProductAttribution) throw new QingzhouReadError("incomplete_response");
  const jiraUrl = new URL(input.jira.baseUrl);
  const origins = (process.env.PAPERCLIP_JIRA_ALLOWED_ORIGINS ?? "http://jira.fingard.com:6001").split(",").map(value => value.trim());
  if (!origins.includes(jiraUrl.origin) || jiraUrl.username || jiraUrl.password || jiraUrl.search || jiraUrl.hash || jiraUrl.pathname !== "/") throw new QingzhouReadError("source_rejected");
  const ownerField = jiraRequirementOwnerField();
  if (!/^customfield_\d+$/.test(ownerField)) throw new QingzhouReadError("invalid_response");
  const owners = new Map<string, string | null>();
  const rows: unknown[] = [];let total: number | null = null;
  if (mainKeys.length) {
    for (let start = 0; ; ) {
      const keys = mainKeys.map(key => `"${key}"`).join(",");
      const url = new URL("/rest/api/2/search", jiraUrl);
      url.search = new URLSearchParams({ jql: `key in (${keys}) OR parent in (${keys}) ORDER BY key ASC`, fields: `summary,status,issuetype,assignee,parent,subtasks,${ownerField}`, startAt: String(start), maxResults: "100" }).toString();
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
      const pageTotal = page.total as number;
      total = pageTotal;
      for (const row of page.issues) {
        if (row?.fields?.issuetype?.subtask === true) owners.set(row.key, jiraRequirementOwner(row.fields[ownerField])?.login ?? null);
        if (row?.fields && Object.hasOwn(row.fields, ownerField)) {
          // Keep reporting-only fields out of the execution source fingerprint.
          delete row.fields[ownerField];
        }
        rows.push(row);
      }
      start += page.issues.length;
      if (start === pageTotal) break;
      if (start > pageTotal || !page.issues.length) throw new QingzhouReadError("incomplete_response");
    }
  }
  const collectedAt = new Date().toISOString();
  const snapshot: DeliverySnapshotInput = { projectId: input.projectId, sourceOrigin: QINGZHOU_ORIGIN, demandNo: input.demandNo, collectedAt,
    demandJson: demand.raw, detailJson: detail.raw, analysisJson: analysis.raw, scheduleJsons: schedules, jiraJson: JSON.stringify({ startAt: 0, total: rows.length, issues: rows }) };
  const plan = normalizeDeliverySnapshot(snapshot, "online_readonly");
  const expectedDate = demandRow.estimatedDeliveryDate;
  if (input.subProductAttribution && typeof expectedDate === "string" && /^\d{4}-(0[1-9]|1[0-2])(?:-|$)/.test(expectedDate)) {
    reportMonths.add(expectedDate.slice(0, 7));
  }
  plan.reportMonths = [...reportMonths].sort();
  if (plan.monthlyChildIssues) {
    plan.monthlyChildIssues.jiraOrigin = jiraUrl.origin;
    for (const [key, fact] of Object.entries(plan.monthlyChildIssues.issues)) {
      fact.ownerAccount = owners.get(key) ?? null;
    }
  }
  return { plan, collectedAt };
}
