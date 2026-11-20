// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "@/api/client";
import { DeliveryMonthlyBulkSync } from "./DeliveryMonthlyBulkSync";
Object.assign(globalThis,{IS_REACT_ACT_ENVIRONMENT:true});
let cleanup:(()=>Promise<void>)|undefined;
afterEach(async()=>{await cleanup?.();cleanup=undefined;});
async function mount(props:Partial<Parameters<typeof DeliveryMonthlyBulkSync>[0]>={}) {
 const node=document.createElement("div");document.body.append(node);const root=createRoot(node);
 const readMonth=vi.fn(async()=>["ATS3-1"]),syncEntry=vi.fn(async(_key:string)=>({existing:false})),onBusyChange=vi.fn();
 await act(async()=>root.render(<DeliveryMonthlyBulkSync month="2026-10" disabled={false} readMonth={readMonth} syncEntry={syncEntry} onBusyChange={onBusyChange} {...props}/>));
 cleanup=async()=>{await act(async()=>root.unmount());node.remove();};
 return {node,readMonth,syncEntry,onBusyChange,click:async(text:string)=>{const b=[...node.querySelectorAll("button")].find(b=>b.textContent?.startsWith(text));expect(b).toBeDefined();await act(async()=>b!.click());}};
}
describe("sync the full current month",()=>{
 it("counts new source versions and unchanged entries across retries and resets for a new run",async()=>{
  let fail=true;
  const syncEntry=vi.fn(async(key:string)=>{if(key==="ATS3-3"&&fail)throw new Error("来源暂不可达");return {existing:key==="ATS3-2"};});
  const {node,click}=await mount({readMonth:async()=>["ATS3-1","ATS3-2","ATS3-3"],syncEntry});
  await click("一键同步本月全部");
  expect(node.textContent).toContain("新增来源版本 1 · 来源未变化 1");
  fail=false;await click("重试失败及未完成");
  expect(node.textContent).toContain("新增来源版本 2 · 来源未变化 1");
  syncEntry.mockImplementation(async()=>({existing:true}));
  await click("一键同步本月全部");
  expect(node.textContent).toContain("新增来源版本 0 · 来源未变化 3");
 });
 it("rereads and syncs the entire distinct month including more than 20 entries",async()=>{
  const keys=Array.from({length:25},(_,i)=>`ATS3-${i+1}`);const syncEntry=vi.fn(async(_key:string)=>({existing:true}));
  const readMonth=vi.fn(async()=>[...keys,keys[0]!]);const {node,click}=await mount({readMonth,syncEntry});
  await click("一键同步本月全部");expect(syncEntry.mock.calls.map(([key])=>key)).toEqual(keys);expect(readMonth).toHaveBeenCalledTimes(1);expect(node.textContent).toContain("已处理 25/25 · 成功 25 · 失败 0");expect(node.textContent).toContain("来源无变化，保留已有版本");
 });
 it("keeps successful results and retries only failed or unfinished entries",async()=>{
  let fail=true;const syncEntry=vi.fn(async(key:string)=>{if(key==="ATS3-2"&&fail)throw new Error("来源暂不可达");return {existing:false};});
  const readMonth=vi.fn(async()=>["ATS3-1","ATS3-2","ATS3-3"]);const {node,click}=await mount({readMonth,syncEntry});
  await click("一键同步本月全部");expect(node.textContent).toContain("成功 2 · 失败 1");fail=false;await click("重试失败及未完成");expect(syncEntry.mock.calls.map(([key])=>key)).toEqual(["ATS3-1","ATS3-2","ATS3-3","ATS3-2"]);expect(readMonth).toHaveBeenCalledTimes(1);expect(node.textContent).toContain("成功 3 · 失败 0");
 });
 it("stops after the in-flight save finishes, then continues only remaining entries",async()=>{
  let finish!:(value:{existing:boolean})=>void;const pending=new Promise<{existing:boolean}>(resolve=>{finish=resolve;});
  const syncEntry=vi.fn(async(key:string)=>key==="ATS3-1"?pending:{existing:false});const {node,click}=await mount({readMonth:async()=>["ATS3-1","ATS3-2"],syncEntry});
  await click("一键同步本月全部");await click("停止后续同步");await act(async()=>finish({existing:false}));expect(syncEntry).toHaveBeenCalledTimes(1);expect(node.textContent).toContain("已停止后续同步");await click("重试失败及未完成");expect(syncEntry.mock.calls.map(([key])=>key)).toEqual(["ATS3-1","ATS3-2"]);
 });
 it("never falls back to a stale list when the full-month read fails",async()=>{
  const {node,click,syncEntry,onBusyChange}=await mount({readMonth:async()=>{throw new Error("完整清单读取失败");}});await click("一键同步本月全部");expect(syncEntry).not.toHaveBeenCalled();expect(node.textContent).toContain("完整清单读取失败");expect(onBusyChange).toHaveBeenLastCalledWith(false);
 });
 it("stops the queue when source revision or account authorization changes",async()=>{
  const syncEntry=vi.fn(async(_key:string):Promise<{existing:boolean}>=>{throw new ApiError("配置变化",409,null);});const {node,click}=await mount({readMonth:async()=>["ATS3-1","ATS3-2"],syncEntry});await click("一键同步本月全部");expect(syncEntry).toHaveBeenCalledTimes(1);expect(node.textContent).toContain("账号权限或来源配置已变化");
 });
 it("does not send more entries after leaving the page",async()=>{
  let finish!:(value:{existing:boolean})=>void;const pending=new Promise<{existing:boolean}>(resolve=>{finish=resolve;});const syncEntry=vi.fn(async(_key:string)=>pending);
  const {click}=await mount({readMonth:async()=>["ATS3-1","ATS3-2"],syncEntry});await click("一键同步本月全部");await cleanup!();cleanup=undefined;await act(async()=>finish({existing:false}));expect(syncEntry).toHaveBeenCalledTimes(1);
 });
 it("handles an empty month without source sync requests",async()=>{
  const {node,click,syncEntry}=await mount({readMonth:async()=>[]});await click("一键同步本月全部");expect(syncEntry).not.toHaveBeenCalled();expect(node.textContent).toContain("本月没有条目，无需同步");
 });
});
