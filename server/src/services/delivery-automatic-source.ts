import type { Db } from "@paperclipai/db";
import type { DeliveryPlan } from "@paperclipai/shared";
import { conflict } from "../errors.js";
import { deliveryJiraCredentials } from "./delivery-seat-assignment.js";
import type { AutomaticSourceItem } from "./delivery-automatic-selection.js";
/** Read the entire current child set, so a newly added child cannot silently disappear from a plan. */
export async function readAutomaticDeliverySource(
  db: Db,
  companyId: string,
  projectId: string,
  plan: DeliveryPlan,
) {
  const parents = [...new Set(plan.mains.map((m) => m.key))].sort();
  if (
    !parents.length ||
    parents.length > 20 ||
    parents.some((k) => !/^[A-Z][A-Z0-9_]*-\d+$/.test(k))
  )
    throw conflict("来源缺少有效主工单或超出自动读取范围");
  const { origin, token } = await deliveryJiraCredentials(
    db,
    companyId,
    projectId,
  );
  const items: AutomaticSourceItem[] = [];
  for (let startAt = 0; startAt < 1000; startAt += 100) {
    const url = new URL("/rest/api/2/search", origin);
    url.search = new URLSearchParams({
      jql: `parent in (${parents.join(",")}) ORDER BY key ASC`,
      fields: "summary,parent,issuetype,status,assignee,updated,issuelinks",
      startAt: String(startAt),
      maxResults: "100",
    }).toString();
    const response = await fetch(url, {
      headers: { Authorization: "Bearer " + token, Accept: "application/json" },
      redirect: "error",
      signal: AbortSignal.timeout(15000),
    }).catch(() => {
      throw conflict("无法读取 Jira 最新工单，请稍后重试");
    });
    if (!response.ok)
      throw conflict("读取 Jira 最新工单失败，请核对项目连接与权限");
    // Limit JSON response size as Jira descriptions or links may be unexpectedly large.
    if (!response.body) throw conflict("Jira 返回为空");
    const reader = response.body.getReader();
    let size = 0;
    const chunks: Uint8Array[] = [];
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.length;
        if (size > 4 * 1024 * 1024)
          throw conflict("Jira 工单数据过大，请缩小范围");
        chunks.push(value);
      }
    } finally {
      await reader.cancel();
    }
    const page = JSON.parse(Buffer.concat(chunks).toString());
    if (
      !Number.isInteger(page.total) ||
      page.total > 1000 ||
      page.startAt !== startAt ||
      !Array.isArray(page.issues) ||
      page.issues.length !== Math.min(100, page.total - startAt)
    )
      throw conflict("Jira 子单未完整返回，请刷新来源");
    for (const row of page.issues) {
      const f = row.fields;
      if (
        !/^[A-Z][A-Z0-9_]*-\d+$/.test(row.key) ||
        !parents.includes(f?.parent?.key) ||
        typeof f?.updated !== "string" ||
        typeof f?.status?.name !== "string" ||
        typeof f?.issuetype?.name !== "string"
      )
        throw conflict("Jira 工单身份或字段无效");
      const reviewLinks: string[] = (f.issuelinks ?? [])
        .filter((l: { type?: { name: string } }) =>
          ["Review", "评审"].includes(l.type?.name ?? ""),
        )
        .flatMap(
          (l: {
            inwardIssue?: { key: string };
            outwardIssue?: { key: string };
          }) =>
            [l.inwardIssue?.key, l.outwardIssue?.key].filter(
              (k): k is string => !!k,
            ),
        );
      items.push({
        key: row.key,
        parentKey: f.parent.key,
        title: f.summary ?? row.key,
        type: f.issuetype.name,
        status: f.status.name,
        assignee: f.assignee?.displayName ?? "",
        account: f.assignee?.name ?? f.assignee?.accountId ?? "",
        updated: f.updated,
        reviewLinks: reviewLinks.sort(),
        scheduled:
          plan.items.find((i) => i.key === row.key)?.scheduled ?? false,
      });
    }
    if (items.length === page.total) break;
  }
  if (new Set(items.map((i) => i.key)).size !== items.length)
    throw conflict("Jira 分页期间来源变化，请重试");
  return {
    items: items.sort((a, b) => a.key.localeCompare(b.key)),
    parents,
    origin,
  };
}
