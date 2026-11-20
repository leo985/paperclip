/** Source contract verified against qingzhou-ops and qingzhou-ai.
 * Credentials are resolved by the caller's secret store;
 * access tokens are memory-only and are never returned in source snapshots. */
export const QINGZHOU_ORIGIN = "https://proj.fingard.com:1888";
// Full-month schedule trees include all demand/work-item fields; single-item reads stay small.
const DEFAULT_RESPONSE_BYTES = 2_000_000;
const MONTHLY_RESPONSE_BYTES = 8_000_000;
const LOGIN_URL = "http://gateway.proj-prod.avatar.fingard.cn/api/auth/login";
const OPERATIONS = {
  demand: "UC_PROJ2_DEMAND_ITEM_ALL_SEARCH",
  detail: "UC_PROJ2_DEMAND_DETAIL",
  analysis: "UC_PROJ2_DEMAND_GET_DEMAND_ANALYSIS",
  monthlyPlans: "UC_PROJ2_SCHEDULE_ALLOT_SEARCH",
  schedule: "UC_PROJ2_SCHEDULE_ISSUE_SEARCH",
  organizations: "UC_PROJ2_ALLOT_ORG_SEARCH",
  saveAnalysis: "UC_PROJ2_DEMAND_SPLIT_ANALYZE",
  applyReview: "UC_PROJ2_DEMAND_APPLY_REVIEW",
} as const;

export class QingzhouReadError extends Error {
  constructor(public readonly code: "authentication_required" | "connection_unavailable" | "source_rejected" | "invalid_response" | "incomplete_response") {
    super({ authentication_required: "轻舟认证未就绪，请检查服务账号配置", connection_unavailable: "无法连接轻舟，请核对公司内网与服务地址",
      source_rejected: "轻舟拒绝只读查询，请核对账号权限及查询范围", invalid_response: "轻舟返回内容不符合只读接口合同",
      incomplete_response: "轻舟结果不完整，不能作为在线完整快照" }[code]);
    this.name = "QingzhouReadError";
  }
}
export function parseQingzhouJson(text: string): Record<string, any> {
  try {
    const value = JSON.parse(text, ((_key: string, value: unknown, context?: { source?: string }) => {
      if (typeof value === "number" && Number.isInteger(value) && !Number.isSafeInteger(value)) {
        if (!context?.source) throw Error();
        return context.source;
      }
      return value;
    }) as Parameters<typeof JSON.parse>[1]);
    if (!value || typeof value !== "object" || Array.isArray(value)) throw Error();
    return value;
  } catch { throw new QingzhouReadError("invalid_response"); }
}
function requireId(value: unknown): string {
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) value = String(value);
  if (typeof value !== "string" || !/^\d{1,30}$/.test(value)) throw new QingzhouReadError("invalid_response");
  return value as string;
}
function requireDemandNo(value: string) {
  if (!/^[A-Z][A-Z0-9]*-\d+$/.test(value)) throw new QingzhouReadError("invalid_response");
  return value;
}
export function qingzhouClient(options: {
  credentials: () => Promise<{ username: string; password: string }>;
  fetch?: typeof globalThis.fetch;
  now?: () => number;
}) {
  const fetcher = options.fetch ?? globalThis.fetch, now = options.now ?? Date.now;
  let cached: { value: string; until: number } | null = null;
  let pendingLogin: Promise<string> | null = null;
  async function request(url: string, init: RequestInit, maxBytes = DEFAULT_RESPONSE_BYTES) {
    try {
      const response = await fetcher(url, { ...init, redirect: "error", signal: AbortSignal.timeout(15_000) });
      const length = Number(response.headers.get("content-length"));
      if (length > maxBytes) { await response.body?.cancel(); throw new QingzhouReadError("invalid_response"); }
      return response;
    } catch (error) {
      if (error instanceof QingzhouReadError) throw error;
      throw new QingzhouReadError("connection_unavailable");
    }
  }
  async function body(response: Response, maxBytes = DEFAULT_RESPONSE_BYTES) {
    // Stream with a hard cap even when content-length is absent or compressed.
    if (!response.body) throw new QingzhouReadError("invalid_response");
    const reader = response.body.getReader(), decoder = new TextDecoder();
    let text = "", bytes = 0;
    try {
      for (;;) {
        const item = await reader.read(); if (item.done) break;
        bytes += item.value.byteLength;
        if (bytes > maxBytes) { await reader.cancel(); throw new QingzhouReadError("invalid_response"); }
        text += decoder.decode(item.value, { stream: true });
      }
      return text + decoder.decode();
    } catch (error) {
      if (error instanceof QingzhouReadError) throw error;
      throw new QingzhouReadError("connection_unavailable");
    } finally { reader.releaseLock(); }
  }
  async function login() {
    let credentials;
    try { credentials = await options.credentials(); } catch { throw new QingzhouReadError("authentication_required"); }
    if (!credentials.username || !credentials.password) throw new QingzhouReadError("authentication_required");
    const response = await request(LOGIN_URL, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8" },
      body: new URLSearchParams({ username: JSON.stringify({ username: credentials.username, password: credentials.password }), password: credentials.password }) });
    if (!response.ok) throw new QingzhouReadError("authentication_required");
    const token = parseQingzhouJson(await body(response)).accessToken;
    if (typeof token !== "string" || !/^[A-Za-z0-9._~+\/=-]{1,8192}$/.test(token)) throw new QingzhouReadError("authentication_required");
    cached = { value: token, until: now() + 10 * 60_000 };
    return token;
  }
  async function token() {
    if (cached && cached.until > now()) return cached.value;
    if (!pendingLogin) pendingLogin = login().finally(() => { pendingLogin = null; });
    return pendingLogin;
  }
  async function read(operation: keyof typeof OPERATIONS, query: Record<string, string>, form: Record<string, string>, maxBytes = DEFAULT_RESPONSE_BYTES, multipart = false) {
    let auth = await token();
    for (let attempt = 0; attempt < 2; attempt++) {
      const url = new URL("/api", QINGZHOU_ORIGIN); url.search = new URLSearchParams({ uc: OPERATIONS[operation], ...query }).toString();
      const fields = new FormData();
      if (multipart) for (const [key, value] of Object.entries(form)) fields.set(key, value);
      const response = await request(url.href, { method: "POST", headers: { ...(!multipart ? { "Content-Type": "application/x-www-form-urlencoded" } : {}), Cookie: `token=${auth}; SESSION=${auth}` }, body: multipart ? fields : new URLSearchParams(form) }, maxBytes);
      if (response.status === 401 || response.status === 403) {
        await response.body?.cancel();
        // A concurrent reader may already have renewed the rejected token.
        if (cached?.value === auth) cached = null;
        if (attempt === 0) { auth = await token(); continue; }
        throw new QingzhouReadError("authentication_required");
      }
      if (!response.ok) throw new QingzhouReadError("source_rejected");
      const raw = await body(response, maxBytes), data = parseQingzhouJson(raw);
      if (data.success !== true || String(data.code) !== "0") throw new QingzhouReadError("source_rejected");
      return { raw, data, collectedAt: new Date(now()).toISOString() };
    }
    throw new QingzhouReadError("authentication_required");
  }
  return {
    verifyAuthentication: async () => { await token(); },
    async deliveryMonthDemands(month: string, subProductAttribution: string) {
      if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month) || !/^[A-Za-z0-9_.-]{1,100}$/.test(subProductAttribution)) throw new QingzhouReadError("invalid_response");
      const [year, monthNumber] = month.split("-").map(Number);
      const lastDay = new Date(Date.UTC(year!, monthNumber!, 0)).getUTCDate();
      const rows: Record<string, any>[] = [], identities = new Set<string>();
      let total: number | null = null;
      for (let page = 1; ; page++) {
        const response = await read("demand", {}, { estimatedDeliveryDate: `${month}-01,${month}-${lastDay}`, subProductAttribution, pageNum: String(page), pageSize: "100", sortName: "urid", sortType: "asc" });
        const data = response.data;
        const pageTotal = Number(data.total);
        if (!Array.isArray(data.rows) || !Number.isSafeInteger(pageTotal) || pageTotal < 0 || pageTotal > 1000 || total !== null && total !== pageTotal || data.rows.length > 100) throw new QingzhouReadError("incomplete_response");
        total = pageTotal;
        for (const row of data.rows) {
          if (!row || typeof row !== "object" || typeof row.demandNo !== "string") throw new QingzhouReadError("invalid_response");
          const id = requireId(row.urid);
          requireDemandNo(row.demandNo);
          if (identities.has(id) || rows.some(previous => previous.demandNo === row.demandNo)) throw new QingzhouReadError("incomplete_response");
          // Do not silently accept an upstream service ignoring either filter.
          if (row.subProductAttribution !== subProductAttribution || typeof row.estimatedDeliveryDate !== "string" || row.estimatedDeliveryDate.slice(0, 7) !== month) throw new QingzhouReadError("invalid_response");
          identities.add(id); rows.push(row);
        }
        if (rows.length === total) return rows;
        if (rows.length > total || !data.rows.length) throw new QingzhouReadError("incomplete_response");
      }
    },
    async demand(demandNo: string) {
      requireDemandNo(demandNo);
      const response = await read("demand", {}, { demandNo, pageNum: "1", pageSize: "100" });
      const { rows, total } = response.data;
      if (!Array.isArray(rows) || !Number.isSafeInteger(Number(total)) || Number(total) !== rows.length) throw new QingzhouReadError("incomplete_response");
      const matches = rows.filter(row => row.demandNo === demandNo);
      if (matches.length !== 1) throw new QingzhouReadError("invalid_response");
      const demandId = requireId(matches[0].urid);
      return { ...response, demandId };
    },
    detail: (demandId: string) => read("detail", {}, { demandId: requireId(demandId) }),
    analysis: (demandId: string) => read("analysis", {}, { urid: requireId(demandId) }),
    saveAnalysis: (demandId: string, fields: Record<string, string>) => read("saveAnalysis", {}, { ...fields, urid: requireId(demandId) }, DEFAULT_RESPONSE_BYTES, true),
    applyReview: (demandId: string, reviewerId: string) => read("applyReview", {}, { urid: requireId(demandId), reviewer: requireId(reviewerId) }),
    monthlyPlans: (organizationId: string, months: string[]) => {
      if (!months.length || months.length > 12 || months.some(m => !/^\d{4}-(0[1-9]|1[0-2])$/.test(m))) throw new QingzhouReadError("invalid_response");
      return read("monthlyPlans", { organizationId: requireId(organizationId), targetDate: months.join(",") }, { pageNum: "1", pageSize: "100" });
    },
    schedule: (manageId: string, demandNo: string) => read("schedule", { manageId: requireId(manageId), type: "1", number: requireDemandNo(demandNo) }, {}),
    organizations: (kind: "researchGroup" | "testGroup") => read("organizations", {}, { code: kind }),
    monthlyEntries: (manageId: string) => read("schedule", { manageId: requireId(manageId), type: "1", number: "" }, {}, MONTHLY_RESPONSE_BYTES),
    clearAuthentication: () => { cached = null; },
  };
}
