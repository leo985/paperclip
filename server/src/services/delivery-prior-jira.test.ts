import {afterEach, expect, it, vi} from "vitest";
import {createHash} from "node:crypto";
import {readJiraPriorCompletion, UnconfirmedJiraReviewResult} from "./delivery-prior-jira.js";
vi.mock("./delivery-seat-assignment.js",()=>({deliveryJiraCredentials:async()=>({origin:"https://jira.example",token:"private"})}));
afterEach(()=>vi.unstubAllGlobals());
const prior={stage:"coding" as const,jiraKey:"DEV-1",source:"jira" as const,version:"",artifactReferences:[],reviewReference:""};
function setup(patch: Record<string,unknown>={}) {
 const fields={updated:"2026-11-16",status:{name:"已完成"},parent:{key:"MAIN-1"},issuetype:{name:"编码"},attachment:[{id:"123",filename:"../产物.zip",size:5,content:"https://jira.example/secure/attachment/123/result.zip"}],comment:{total:0,comments:[]},...patch};
 const fetcher=vi.fn(async (url:URL)=>new Response(url.pathname.startsWith('/secure/')?'hello':JSON.stringify({key:"DEV-1",fields})));
 vi.stubGlobal('fetch',fetcher);return fetcher;
}
it('pins real attachment bytes and Jira revision without a seat receipt',async()=>{
 const fetcher=setup();const result=await readJiraPriorCompletion({} as any,'company','project',prior,'MAIN-1',false);
 expect(result.jiraEvidence.artifacts[0].sha256).toBe(createHash('sha256').update('hello').digest('hex'));
 expect(result.version).toMatch(/^jira:DEV-1:/);expect(result.reviewReference).toBe('https://jira.example/browse/DEV-1');
 expect(fetcher).toHaveBeenCalledTimes(3);
});
it.each([{status:{name:'待受理'}},{parent:{key:'OTHER-1'}},{attachment:[]},{attachment:[{id:'123',filename:'x',size:5,content:'https://evil.example/secure/attachment/123/x'}]},{comment:{total:2,comments:[]}}])('rejects stale, missing, foreign or incomplete evidence %j',async patch=>{
 setup(patch);await expect(readJiraPriorCompletion({} as any,'c','p',prior,'MAIN-1',false)).rejects.toThrow();
});
it('imports attachment-free review comments as historical evidence',async()=>{
 setup({issuetype:{name:'代码评审'},attachment:[],comment:{total:1,comments:[{id:'1',body:'评审记录',updated:'today'}]}});
 const result=await readJiraPriorCompletion({} as any,'c','p',prior,'MAIN-1',true);
 expect(result.jiraEvidence.comments[0].body).toBe('评审记录');expect(result.jiraEvidence.artifacts).toEqual([]);
});
it('rejects a source edited during download',async()=>{
 const fields={updated:'old',status:{name:'已完成'},parent:{key:'MAIN-1'},issuetype:{name:'代码评审'},attachment:[],comment:{total:1,comments:[{id:'1',body:'x',updated:'old'}]}};
 const fetcher=vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({key:'DEV-1',fields}))).mockResolvedValueOnce(new Response(JSON.stringify({key:'DEV-1',fields:{...fields,updated:'new'}})));
 vi.stubGlobal('fetch',fetcher);
 await expect(readJiraPriorCompletion({} as any,'c','p',prior,'MAIN-1',true)).rejects.toThrow(/读取期间/);
});

function formalReview(result: string, comment = false, fieldName = "结果描述", issueType = "设计评审") {
  const fields = {
    updated: "2026-11-16", status: { name: "已完成" }, parent: { key: "MAIN-1" },
    issuetype: { name: issueType }, attachment: [], customfield_14608: result,
    comment: comment ? { total: 1, comments: [{ id: "1", body: "评审记录", updated: "today" }] } : { total: 0, comments: [] },
  };
  const row = { key: prior.jiraKey, names: { customfield_14608: fieldName }, fields };
  const fetcher = vi.fn(async (_url: URL) => new Response(JSON.stringify(row)));
  vi.stubGlobal("fetch", fetcher);
  return { row, fetcher };
}

it("reuses the named Jira result field as formal evidence without attachments or comments", async () => {
  const resultText = "设计方案清晰，通过";
  const { fetcher } = formalReview(resultText);
  const result = await readJiraPriorCompletion({} as any, "c", "p", { ...prior, stage: "design" }, "MAIN-1", true);
  expect(result.jiraEvidence).toMatchObject({ reviewResult: resultText, artifacts: [], comments: [] });
  expect(result.artifactReferences).toEqual(["https://jira.example/browse/DEV-1"]);
  expect(fetcher.mock.calls[0][0].searchParams.get("expand")).toBe("names");
  expect(fetcher.mock.calls[0][0].searchParams.get("fields")).toContain("customfield_14608");
  expect(fetcher).toHaveBeenCalledTimes(2);
});

it.each(["有安全泄漏风险", "未通过", "不建议通过", "有条件通过", "尚未通过；备注：通过", "整改后，通过"] satisfies string[])(
  "does not reuse an inconclusive Jira result even if comments exist: %s", async text => {
    formalReview(text, true);
    await expect(readJiraPriorCompletion({} as any, "c", "p", { ...prior, stage: "design" }, "MAIN-1", true))
      .rejects.toBeInstanceOf(UnconfirmedJiraReviewResult);
  },
);

it("does not treat the same custom field ID with a different Jira name as a review result", async () => {
  formalReview("通过", false, "其他说明");
  await expect(readJiraPriorCompletion({} as any, "c", "p", { ...prior, stage: "design" }, "MAIN-1", true))
    .rejects.toThrow(/请先补充 Jira 材料/);
});

it("reuses a completed human test's named Jira result without inventing build or case totals", async () => {
  formalReview("测试通过", false, "结果描述", "功能测试");
  const result = await readJiraPriorCompletion({} as any, "c", "p", { ...prior, stage: "functional-test" }, "MAIN-1", false);
  expect(result.jiraEvidence).toMatchObject({ testResult: "测试通过", artifacts: [], comments: [] });
  expect(result.artifactReferences).toEqual(["https://jira.example/browse/DEV-1"]);
  expect(result.passedTests).toBeUndefined();
});

it.each(["测试未通过", "部分测试通过", "测试通过，仍有用例跳过", "已完成", ""])(
  "does not reuse an incomplete or missing Jira test conclusion: %s", async text => {
    formalReview(text, false, "结果描述", "功能测试");
    await expect(readJiraPriorCompletion({} as any, "c", "p", { ...prior, stage: "functional-test" }, "MAIN-1", false))
      .rejects.toThrow(/通过/);
  },
);
