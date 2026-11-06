import { describe, expect, it } from "vitest";
import { readJiraRequirementMetadata } from "@paperclipai/shared";
import { normalizeRequirement, requirementMarker } from "./jira-requirement-plan.js";
const person = (name: string) => ({ name, displayName: name });
const child = (key: string, type: string, parent = "ATSES-1") => ({ key, fields: { parent: { key: parent }, summary: type, issuetype: { name: type, subtask: true }, status: { name: "待受理", statusCategory: { key: "new" } }, assignee: person("developer") } });
const parent = { key: "ATSES-1", fields: { summary: "需求", issuetype: { subtask: false }, assignee: person("wrong-owner"), customfield_14702: person("rd-owner"), subtasks: [{ key: "ATSES-2" }, { key: "ATSES-3" }, { key: "ATSES-4" }] } };
const children = [child("ATSES-2", "编码"), child("ATSES-3", "代码评审"), child("ATSES-4", "功能测试")];
describe("Jira real requirement identities", () => {
  it("uses the R&D owner and preserves separate coding/review/QA identities", () => {
    const plan = normalizeRequirement(parent, children);
    expect(plan.owner?.login).toBe("rd-owner");
    expect(plan.children.map(item => [item.key, item.mode, item.skill])).toEqual([["ATSES-2", "development", "jira-feature-dev"], ["ATSES-3", "harness-linked", null], ["ATSES-4", "qa", "jira-testcase-execution"]]);
    expect(plan.children).toHaveLength(3); // Never invent a testcase-writing ticket.
  });
  it("never falls back to the parent assignee for missing/ambiguous R&D owner", () => {
    for (const value of [null, [], [person("one"), person("two")]]) expect(normalizeRequirement({ ...parent, fields: { ...parent.fields, customfield_14702: value } }, children).owner).toBeNull();
  });
  it("rejects partial lists, duplicates and changed parent identities", () => {
    expect(() => normalizeRequirement(parent, children.slice(1))).toThrow();
    expect(() => normalizeRequirement(parent, [children[0], children[0], children[2]])).toThrow();
    expect(() => normalizeRequirement(parent, [child("ATSES-2", "编码", "ATSES-99"), ...children.slice(1)])).toThrow();
    expect(() => normalizeRequirement({ ...parent, fields: { ...parent.fields, subtasks: [{key:"ATSES-2"},{key:"ATSES-2"}] } }, [children[0]])).toThrow();
  });
  it("detects Jira changes independent of child ordering", () => {
    const plan = normalizeRequirement(parent, children);
    expect(normalizeRequirement(parent, [...children].reverse()).fingerprint).toBe(plan.fingerprint);
    expect(normalizeRequirement(parent, [child("ATSES-2", "设计评审"), ...children.slice(1)]).fingerprint).not.toBe(plan.fingerprint);
  });
  it("tracks unknown types without inherited object keys becoming routing rules", () => {
    expect(normalizeRequirement(parent, [child("ATSES-2", "__proto__"), ...children.slice(1)]).children[0].mode).toBe("unmapped");
  });
});
const metadata = { version: 1, key: "ATSES-1", summary: "<script> -->", owner: {login:"rd",name:"研发",email:null}, ownerUserId: "rd", connectionSeatId: "seat", jiraBaseUrl: "http://jira.example.com", children: [] };
describe("editable requirement metadata", () => {
  it("round trips escaped text", () => expect(readJiraRequirementMetadata(requirementMarker(metadata))).toEqual(metadata));
  it("rejects malformed content, unsafe URLs and ambiguous multiple markers", () => {
    for (const value of [{...metadata, children: {}}, {...metadata, jiraBaseUrl:"javascript:alert(1)"}, {...metadata, jiraBaseUrl:"http://user:password@jira.example.com"}, {...metadata, children:[{mode:"injected"}]}]) expect(readJiraRequirementMetadata(requirementMarker(value))).toBeNull();
    expect(readJiraRequirementMetadata(requirementMarker(metadata) + requirementMarker(metadata))).toBeNull();
  });
});
