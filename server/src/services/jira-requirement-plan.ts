import { createHash } from "node:crypto";

export type RequirementMode = "development" | "human-review" | "harness-linked" | "qa" | "unmapped";
export interface RequirementItem {
  key: string; summary: string; issueType: string; status: string; done: boolean;
  assignee: { login: string; name: string; email: string | null } | null;
  mode: RequirementMode; skill: string | null; note: string;
}
export const requirementRoutes: Record<string, { mode: RequirementMode; skill: string | null; note: string }> = {
  "系统设计": { mode: "development", skill: "jira-design-doc", note: "研发 Harness 执行系统设计" },
  "系统设计补充": { mode: "development", skill: "jira-design-doc", note: "研发 Harness 执行系统设计" },
  "编码": { mode: "development", skill: "jira-feature-dev", note: "研发 Harness 编码流程包含关联代码评审，不重复派发评审" },
  "前端编码": { mode: "development", skill: "jira-feature-dev", note: "研发 Harness 编码流程包含关联代码评审，不重复派发评审" },
  "设计评审": { mode: "human-review", skill: null, note: "研发席位负责人本人评审；通过 Jira 正式流程记录结论" },
  "代码评审": { mode: "harness-linked", skill: null, note: "由研发 Harness 核验编码范围、版本、评审证据并独立上报；平台不再启动一轮" },
  "编码评审": { mode: "harness-linked", skill: null, note: "由研发 Harness 核验实际关联，不按同父关系自动完成" },
  "详细测试用例编写": { mode: "qa", skill: "jira-testcase-writing", note: "测试 Harness 的独立用例子单；不能用功能测试号代替" },
  "功能测试": { mode: "qa", skill: "jira-testcase-execution", note: "测试席位 Agent 使用测试 Harness，须有构建、环境和用例评审证据" },
  "测试用例评审": { mode: "human-review", skill: null, note: "指定人员评审明确版本的测试用例" },
};
export function jiraPerson(value: any): RequirementItem["assignee"] {
  const login = value?.name ?? value?.accountId;
  return typeof login === "string" && login ? { login, name: String(value.displayName ?? login), email: typeof value.emailAddress === "string" ? value.emailAddress : null } : null;
}
export function normalizeRequirement(parent: any, children: any[], ownerField = "customfield_14702") {
  if (!parent?.key || parent.fields?.issuetype?.subtask !== false || !Array.isArray(parent.fields?.subtasks) || !parent.fields.subtasks.length) throw new Error("请选择具有真实子任务的 Jira 主需求");
  const keys = new Set(parent.fields.subtasks.map((item: any) => item.key));
  if (keys.size !== parent.fields.subtasks.length || keys.size !== children.length || new Set(children.map(child => child.key)).size !== children.length) throw new Error("子工单查询不完整或重复，请重新读取");
  const items: RequirementItem[] = children.map(child => {
    const fields = child.fields;
    if (!keys.has(child.key) || fields?.parent?.key !== parent.key || fields?.issuetype?.subtask !== true) throw new Error("子工单身份或父子关系核验失败");
    const route = (Object.hasOwn(requirementRoutes, fields.issuetype.name) ? requirementRoutes[fields.issuetype.name] : undefined) ?? { mode: "unmapped" as const, skill: null, note: "未配置执行映射，只纳管，不自动执行" };
    return { key: child.key, summary: String(fields.summary ?? ""), issueType: fields.issuetype.name, status: String(fields.status?.name ?? "未知"), done: fields.status?.statusCategory?.key === "done", assignee: jiraPerson(fields.assignee), ...route };
  }).sort((a, b) => a.key.localeCompare(b.key, undefined, { numeric: true }));
  const owners = Array.isArray(parent.fields[ownerField]) ? parent.fields[ownerField] : [parent.fields[ownerField]];
  const owner = owners.length === 1 ? jiraPerson(owners[0]) : null;
  const snapshot = { key: parent.key as string, summary: String(parent.fields.summary ?? ""), status: String(parent.fields.status?.name ?? "未知"), done: parent.fields.status?.statusCategory?.key === "done", owner, ownerField, children: items };
  return { ...snapshot, fingerprint: createHash("sha256").update(JSON.stringify(snapshot)).digest("hex") };
}
export function requirementMarker(value: unknown) {
  return `<!-- DSP7-REQUIREMENT ${JSON.stringify(value).replace(/</g, "\\u003c").replace(/>/g, "\\u003e")} -->`;
}
