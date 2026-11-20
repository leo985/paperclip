import { issues } from "@paperclipai/db";
import { sql } from "drizzle-orm";
import { createHash } from "node:crypto";
import { DELIVERY_STAGES, matchesDeliveryWorkType, type DeliveryPlan, type DeliveryStageRecord, type DeliveryTemplateSnapshot, type DeliveryWorkItem, type DeliveryWorkflowConfig } from "@paperclipai/shared";
import { cancelledDeliverySource } from "./delivery-automatic-selection.js";

export const isDeliveryTestCase = (item: Pick<DeliveryWorkItem, "type">) =>
  !matchesDeliveryWorkType("functional-test", false, item.type) &&
  (matchesDeliveryWorkType("test-cases", false, item.type) || matchesDeliveryWorkType("test-cases", true, item.type));

export function canSkipDeliveryTestCases(template: DeliveryTemplateSnapshot) {
  const { stages } = template.definition;
  return stages["test-cases"].enabled && DELIVERY_STAGES.some(stage => stage !== "test-cases" && stages[stage].enabled);
}

export function deliveryBranchTemplate(template: DeliveryTemplateSnapshot, skipTestCases?: true): DeliveryTemplateSnapshot {
  if (!skipTestCases) return template;
  const policies = template.definition.stages;
  const stages = { ...policies, "test-cases": { ...policies["test-cases"], enabled: false } };
  if (DELIVERY_STAGES.find(stage => policies[stage].enabled) === "test-cases") {
    const first = DELIVERY_STAGES.find(stage => stages[stage].enabled);
    if (first) stages[first] = { ...stages[first], entryChecks: policies["test-cases"].entryChecks };
  }
  return { ...template, definition: { ...template.definition, stages } };
}

export function deliveryBranchDigest(items: DeliveryWorkItem[], parentKey: string, skipTestCases?: true) {
  const children = [...deliveryBranchChildIdentities(items, parentKey, skipTestCases)].sort(([a], [b]) => a.localeCompare(b));
  return createHash("sha256").update(JSON.stringify(children)).digest("hex");
}

export function deliveryEntryInput(plan: DeliveryPlan) {
  return JSON.stringify([plan.demandId, plan.demandNo, plan.title]);
}

export function deliveryBranchMatches(plan: DeliveryPlan, config: DeliveryWorkflowConfig, parentKey: string) {
  const branch = config.entryScope?.branches[parentKey];
  return plan.mains.some(main => main.key === parentKey) &&
    branch?.digest === deliveryBranchDigest(plan.items, parentKey, branch?.skipTestCases);
}

export function deliveryEntryScopeComplete(plan: DeliveryPlan, config: DeliveryWorkflowConfig) {
  const included = Object.keys(config.entryScope?.branches ?? {});
  const ignored = new Set(config.entryScope?.ignoredParentKeys);
  return included.length > 0 && included.every(key => deliveryBranchMatches(plan, config, key)) &&
    plan.mains.every(main => ignored.has(main.key) || !!config.entryScope?.branches[main.key]);
}

export function deliveryRepairCandidates(stages: DeliveryStageRecord[], branched: boolean) {
  return branched
    ? stages.filter(stage => stage.branchBlocked && stage.stage === "functional-test" && stage.receipt?.testResults?.failed)
    : [stages.find(stage => stage.state !== "done")].filter((stage): stage is DeliveryStageRecord => !!stage);
}

export function deliveryActiveIssueIdentity(key: string) {
  return sql`(position(${'"jira_key":"' + key + '"'} in coalesce(${issues.description},'')) > 0 or right(${issues.originId}, ${key.length + 1}) = ${":" + key})`;
}

export function deliveryBranchChildIdentities(items: DeliveryWorkItem[], parentKey: string, skipTestCases?: true) {
  return new Map(items.filter(item => item.parentKey === parentKey && !cancelledDeliverySource(item.status) &&
    (!skipTestCases || !isDeliveryTestCase(item)))
    .map(item => [item.key, item.type]));
}


export function deliveryBranchPlan(plan: DeliveryPlan, parentKey: string, skipTestCases?: true): DeliveryPlan {
  const items = plan.items.filter(item =>
    (item.parentKey === parentKey && (!skipTestCases || !isDeliveryTestCase(item))) || item.key === parentKey);
  const branchKeys = new Set(items.map(item => item.key));
  const otherKeys = new Set(plan.items.filter(item => !branchKeys.has(item.key)).map(item => item.key));
  return {
    ...plan,
    mains: plan.mains.filter(main => main.key === parentKey),
    items,
    differences: plan.differences.filter(difference => !otherKeys.has(difference.key)),
  };
}

export function legacyDeliveryEntryScope(plan: DeliveryPlan, snapshotId: string, config: DeliveryWorkflowConfig, stages: DeliveryStageRecord[], jiraOrigin: string): DeliveryWorkflowConfig["entryScope"] {
  if (!config.template || (plan.monthlyChildIssues?.jiraOrigin && plan.monthlyChildIssues.jiraOrigin !== jiraOrigin)) return;
  const jiraStages = stages.filter(stage => stage.jiraKey);
  const parents = new Set(jiraStages.map(stage => stage.parentKey));
  const [parentKey] = parents;
  if (parents.size !== 1 || !parentKey || !plan.mains.some(main => main.key === parentKey) ||
    jiraStages.some(stage => !stage.dependsOn || !plan.items.some(item => item.key === stage.jiraKey && item.parentKey === parentKey)))
    return;
  const matchingItems = plan.items.filter(item => item.parentKey === parentKey && !cancelledDeliverySource(item.status) &&
    DELIVERY_STAGES.some(stage => {
      const policy = config.template!.definition.stages[stage];
      return policy.enabled && (matchesDeliveryWorkType(stage, false, item.type) ||
        (policy.taskSequence === "work_then_review" && matchesDeliveryWorkType(stage, true, item.type)));
    }));
  if (matchingItems.length !== jiraStages.length || matchingItems.some(item => !jiraStages.some(stage => stage.jiraKey === item.key))) return;
  return { jiraOrigin, branches: { [parentKey]: { snapshotId, digest: deliveryBranchDigest(plan.items, parentKey) } }, requests: {} };
}

export function deliveryDependentBranches(scope: NonNullable<DeliveryWorkflowConfig["entryScope"]>, parentKey: string) {
  const result = new Set<string>();
  function visit(key: string) {
    for (const [candidate, branch] of Object.entries(scope.branches)) {
      if (branch.afterParentKey !== key || result.has(candidate)) continue;
      result.add(candidate);
      visit(candidate);
    }
  }
  visit(parentKey);
  return result;
}

export function deliveryBranchVerified(plan: DeliveryPlan, config: DeliveryWorkflowConfig, stages: DeliveryStageRecord[], parentKey: string) {
  if (stages.some(stage => stage.stage === "analysis" && stage.state !== "done")) return false;
  const visited = new Set<string>();
  let key: string | undefined = parentKey;
  while (key) {
    if (visited.has(key) || !deliveryBranchMatches(plan, config, key) ||
      stages.some(stage => stage.parentKey === key && stage.state !== "done")) return false;
    visited.add(key);
    key = config.entryScope?.branches[key]?.afterParentKey;
  }
  return true;
}


export function canExtendDeliveryEntry(state: string, message: string | null, scoped: boolean) {
  return state === "active" || state === "acceptance" || (state === "completed" && !scoped) ||
    (!scoped && state === "blocked" && !!message?.startsWith("来源输入已变化"));
}
