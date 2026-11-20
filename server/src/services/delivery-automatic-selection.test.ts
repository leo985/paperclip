import { describe, expect, it } from "vitest";
import {
  DEFAULT_DELIVERY_TEMPLATE,
  type DeliveryAutomaticPlanInput,
} from "@paperclipai/shared";
import {
  selectAutomaticDeliveryWork,
  type AutomaticSourceItem,
} from "./delivery-automatic-selection.js";
const item = (
  key: string,
  type: string,
  extra: Partial<AutomaticSourceItem> = {},
): AutomaticSourceItem => ({
  key,
  type,
  parentKey: "MAIN-1",
  title: key,
  status: "待受理",
  assignee: "张三",
  account: "user",
  updated: "v1",
  scheduled: true,
  reviewLinks: [],
  ...extra,
});
const input: DeliveryAutomaticPlanInput = {
  snapshotId: "snapshot",
  environmentReference: "",
};
function definition() {
  const d = structuredClone(DEFAULT_DELIVERY_TEMPLATE);
  for (const [k, s] of Object.entries(d.stages)) s.enabled = k === "coding";
  return d;
}
function select(
  items: AutomaticSourceItem[],
  options = input,
  parents = ["MAIN-1"],
) {
  return selectAutomaticDeliveryWork(items, parents, definition(), options);
}
describe("automatic delivery work selection", () => {
  it("pairs a unique review and work item without a manual selection", () => {
    const d = definition(),
      before = structuredClone(d);
    const p = selectAutomaticDeliveryWork(
      [item("DEV-1", "编码"), item("REV-1", "代码评审")],
      ["MAIN-1"],
      d,
      input,
    );
    expect(p.blockers).toEqual([]);
    expect(p.config.workTasks?.map((t) => t.jiraKey)).toEqual(["DEV-1"]);
    expect(p.config.reviewTasks?.[0].workKeys).toEqual(["DEV-1"]);
    expect(d).toEqual(before);
  });
  it("includes every work item and uses explicit Jira review relations", () => {
    const p = select([
      item("DEV-1", "前端编码"),
      item("DEV-2", "编码"),
      item("REV-1", "代码评审", { reviewLinks: ["DEV-1", "DEV-2"] }),
    ]);
    expect(p.config.workTasks).toHaveLength(2);
    expect(p.config.reviewTasks?.[0].workKeys).toEqual(["DEV-1", "DEV-2"]);
    expect(p.blockers).toEqual([]);
  });
  it("covers all same-stage work for every review regardless of titles or links", () => {
    const p = select([
      item("DEV-1", "编码", {status:"已完成"}), item("DEV-2", "编码"),
      item("REV-1", "代码评审", {reviewLinks:["DEV-1"]}), item("REV-2", "代码评审"),
    ]);
    expect(p.blockers).toEqual([]);
    expect(p.config.reviewTasks?.map(r=>r.workKeys)).toEqual([["DEV-1","DEV-2"],["DEV-1","DEV-2"]]);
  });
  it("reports missing review tickets without offering binding configuration", () => {
    const p=select([item("DEV-1", "编码")]);
    expect(p.blockers.map(b=>b.code)).toEqual(["missing_review"]);
  });
  it("ignores obsolete manual review coverage overrides", () => {
    const p=select([item("DEV-1","编码"),item("DEV-2","编码"),item("REV-1","代码评审")], {...input,reviewTasks:[{stage:"coding",jiraKey:"REV-1",workKeys:["FOREIGN-1"]}]});
    expect(p.blockers).toEqual([]);
    expect(p.config.reviewTasks?.[0].workKeys).toEqual(["DEV-1","DEV-2"]);
  });
  it("requires a main scope for multiple mains and never mixes child identities", () => {
    const rows = [
      item("DEV-1", "编码"),
      item("REV-1", "代码评审"),
      item("DEV-2", "编码", { parentKey: "MAIN-2" }),
    ];
    expect(
      select(rows, input, ["MAIN-1", "MAIN-2"]).blockers.map((b) => b.code),
    ).toContain("parent");
    const p = select(rows, { ...input, parentKey: "MAIN-1" }, [
      "MAIN-1",
      "MAIN-2",
    ]);
    expect(p.blockers).toEqual([]);
    expect(p.excluded).toContainEqual({
      jiraKey: "DEV-2",
      reason: "不属于本次主工单",
    });
  });
  it("excludes cancelled work, preserves completed nodes and honors disabled template stages", () => {
    const p = select([
      item("DEV-1", "编码", { status: "已完成" }),
      item("DEV-2", "编码", { status: "已作废" }),
      item("REV-1", "代码评审"),
      item("DES-1", "系统设计"),
    ]);
    expect(p.config.workTasks?.map((t) => t.jiraKey)).toEqual(["DEV-1"]);
    expect(p.excluded).toHaveLength(2);
    expect(p.blockers).toEqual([]);
  });
  it("does not silently ignore exceptions outside the selected plan", () => {
    const p = select([item("DEV-1", "编码"), item("REV-1", "代码评审")], {
      ...input,
      workSeats: [{ jiraKey: "OTHER-1", seatId: "" }],
    });
    expect(p.blockers.map((b) => b.code)).toContain("invalid_override");
  });
});

it("uses type and parent conventions for both design and test-case reviews",()=>{
 const d=definition();d.stages.coding.enabled=false;d.stages.design.enabled=true;d.stages['test-cases'].enabled=true;
 const p=selectAutomaticDeliveryWork([item('DES-1','系统设计'),item('DES-2','系统设计'),item('DR-1','设计评审'),item('CASE-1','测试用例设计'),item('CASE-2','测试用例设计'),item('CR-1','测试用例评审')],['MAIN-1'],d,input);
 expect(p.blockers).toEqual([]);
 expect(p.config.reviewTasks).toEqual([{stage:'design',jiraKey:'DR-1',workKeys:['DES-1','DES-2']},{stage:'test-cases',jiraKey:'CR-1',workKeys:['CASE-1','CASE-2']}]);
});
