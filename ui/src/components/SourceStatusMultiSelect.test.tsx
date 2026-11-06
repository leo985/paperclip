// @vitest-environment jsdom
import { useState } from "react";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import { SourceStatusMultiSelect } from "./SourceStatusMultiSelect";
let cleanup:(()=>void)|undefined;
afterEach(()=>{cleanup?.();cleanup=undefined;});
function mount(initial:string[]=[]) {
 const node=document.createElement("div");document.body.append(node);const root=createRoot(node);
 function View(){const [values,setValues]=useState(initial);return <><SourceStatusMultiSelect label="测试来源状态" options={[{value:'"研发中"',label:"研发中"},{value:'"已完成"',label:"已完成"}]} values={values} onChange={setValues}/><output>{JSON.stringify(values)}</output></>;}
 flushSync(()=>root.render(<View/>));cleanup=()=>{flushSync(()=>root.unmount());node.remove();};
 flushSync(()=>node.querySelector<HTMLButtonElement>("button")!.click());
 return {node,toggle:(label:string)=>flushSync(()=>document.querySelector<HTMLInputElement>(`input[aria-label="测试来源状态：${label}"]`)!.click())};
}
describe("source status checkbox filter",()=>{
 it("keeps the menu open for multiple choices, allows deselection, and clears back to all",()=>{
  const {node,toggle}=mount();toggle("研发中");toggle("已完成");
  expect(node.querySelector("output")?.textContent).toBe(JSON.stringify(['"研发中"','"已完成"']));
  expect(node.querySelector("button")?.textContent).toContain("已选 2 个状态");
  toggle("研发中");expect(node.querySelector("button")?.textContent).toContain("已完成");
  flushSync(()=>[...document.querySelectorAll<HTMLButtonElement>('div[aria-label="测试来源状态选项"] button')].find(b=>b.textContent==="全部状态")!.click());
  expect(node.querySelector("output")?.textContent).toBe("[]");expect(node.querySelector("button")?.textContent).toContain("全部状态");
 });
 it("retains unavailable selections so switching month does not silently drop a filter",()=>{
  const {node,toggle}=mount(['"待受理"']);expect(document.body.textContent).toContain("待受理（本次未返回）");
  toggle("待受理（本次未返回）");expect(node.querySelector("output")?.textContent).toBe("[]");
 });
});
