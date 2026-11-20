// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AnalysisReportFile, analysisReportName } from "./AnalysisReportFile";
vi.mock("@/components/MarkdownBody",()=>({MarkdownBody:({children}:{children:React.ReactNode})=><div>{children}</div>}));
Object.assign(globalThis,{IS_REACT_ACT_ENVIRONMENT:true});
const create=vi.fn((_blob: Blob)=>"blob:report"),revoke=vi.fn();Object.assign(URL,{createObjectURL:create,revokeObjectURL:revoke});
afterEach(()=>{vi.clearAllMocks();document.body.innerHTML="";});
describe("analysis report file",()=>{
  it("names report files safely with a fallback for tasks without demand numbers",()=>{
    expect(analysisReportName("TWGF-00919","id")).toBe("TWGF-00919-需求分析.md");
    expect(analysisReportName(null,"task-id")).toBe("task-id-需求分析.md");
    expect(analysisReportName("../path/name","id")).not.toContain("/");
  });
  it("previews the uploaded Markdown, downloads the original bytes, and closes old preview on version change",async()=>{
    const node=document.createElement("div");document.body.append(node);const root=createRoot(node);
    const content="# 德国付款\r\n| 项目 | 范围 |\r\n| --- | --- |\r\n| 工资 | 不包含 |";
    const render=(text:string,digest:string)=>act(async()=>root.render(<AnalysisReportFile name="TWGF-00919-需求分析.md" content={text} inputDigest={digest}/>));
    await render(content,"a");
    expect(node.querySelector("a")?.getAttribute("download")).toBe("TWGF-00919-需求分析.md");
    const blob=create.mock.calls[0]![0] as Blob;
    const text=await new Promise<string>(resolve=>{const reader=new FileReader();reader.onload=()=>resolve(String(reader.result));reader.readAsText(blob);});expect(text).toBe(content);
    await act(async()=>node.querySelector("button")!.click());
    expect(document.querySelector('[role="dialog"]')?.textContent).toContain("德国付款");
    await render("新版内容","b");expect(document.querySelector('[role="dialog"]')).toBeNull();expect(revoke).toHaveBeenCalled();
    await act(async()=>root.unmount());expect(revoke).toHaveBeenCalledTimes(2);
  });
});
