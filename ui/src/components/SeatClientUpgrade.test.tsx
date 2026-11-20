// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { SeatClientUpgrade } from "./SeatClientUpgrade";
const mocks=vi.hoisted(()=>({admin:true,status:vi.fn(),request:vi.fn(),cancel:vi.fn()}));
vi.mock("@/hooks/useManagementAccess",()=>({useManagementAccess:()=>({canManage:mocks.admin})}));
vi.mock("@/api/dsp7-seats",()=>({dsp7SeatsApi:{upgradeStatus:mocks.status,requestUpgrade:mocks.request,cancelUpgrade:mocks.cancel}}));
(globalThis as any).IS_REACT_ACT_ENVIRONMENT=true;
const seat:any={agentId:"seat",name:"test",canConfigure:true,online:true,presence:{bridgeVersion:"a".repeat(64),capabilities:["seat-admin-upgrade-v1"],checks:[]}};
let root:Root,container:HTMLDivElement,cache:QueryClient;
async function show(value=seat){container=document.createElement("div");document.body.append(container);root=createRoot(container);cache=new QueryClient({defaultOptions:{queries:{retry:false}}});await act(async()=>{root.render(<QueryClientProvider client={cache}><SeatClientUpgrade companyId="company" seat={value}/></QueryClientProvider>);});await act(async()=>{await new Promise(resolve=>setTimeout(resolve,20));});}
const button=(label:string)=>[...container.querySelectorAll("button")].find(item=>item.textContent===label);
beforeEach(()=>{vi.clearAllMocks();localStorage.clear();mocks.admin=true;mocks.status.mockResolvedValue(null);mocks.request.mockResolvedValue({});vi.stubGlobal("fetch",vi.fn().mockResolvedValue({ok:true,json:async()=>({sha256:"b".repeat(64)})}));});
afterEach(async()=>{await act(async()=>root?.unmount());container?.remove();cache?.clear();vi.restoreAllMocks();vi.unstubAllGlobals();});
it("only explicit admin action dispatches a target version",async()=>{await show();expect(button("下发客户端升级")?.disabled).toBe(false);expect(mocks.request).not.toHaveBeenCalled();await act(async()=>button("下发客户端升级")!.click());expect(mocks.request).toHaveBeenCalledWith("company","seat","b".repeat(64));});
it("ordinary seat owners cannot dispatch upgrades",async()=>{mocks.admin=false;await show();expect(button("下发客户端升级")).toBeUndefined();expect(mocks.request).not.toHaveBeenCalled();});
it("unsupported clients require bootstrap and cannot dispatch",async()=>{await show({...seat,presence:{...seat.presence,capabilities:[]}});expect(button("下发客户端升级")?.disabled).toBe(true);expect(container.textContent).toContain("请先在原电脑按下方步骤更新一次");});
it("queued requests expose explicit cancellation",async()=>{mocks.status.mockResolvedValue({requestId:"request",targetSha256:"b".repeat(64),status:"queued",message:"等待"});await show();await act(async()=>button("取消升级请求")!.click());expect(mocks.cancel).toHaveBeenCalledWith("company","seat","request","b".repeat(64));});

async function expand() {
  await act(async () => button("更新客户端")!.click());
  return container.querySelector("select")!;
}

async function choosePlatform(value: string) {
  const select = container.querySelector("select")!;
  await act(async () => {
    select.value = value;
    select.dispatchEvent(new Event("change", { bubbles: true }));
  });
}

async function renderSeat(value = seat, companyId = "company") {
  await act(async () => root.render(<QueryClientProvider client={cache}><SeatClientUpgrade companyId={companyId} seat={value}/></QueryClientProvider>));
}

it.each(["C:\\Users\\光贝\\harness", "D:/work/harness", "\\\\server\\share\\harness"])("uses Windows commands for a registered Windows path: %s", async harnessRoot => {
  await show({ ...seat, runtime: { harnessRoot } });
  expect((await expand()).value).toBe("windows");
  expect(container.querySelector("code")?.textContent).toContain("powershell.exe");
  expect(container.querySelector("code")?.textContent).toContain("-AgentId 'seat'");
});

it("restores the chosen system after reopening the component", async () => {
  await show();
  await expand();
  await choosePlatform("windows");
  await act(async () => root.unmount());
  container.remove(); cache.clear();
  await show();
  expect((await expand()).value).toBe("windows");
  expect(container.querySelector("code")?.textContent).toContain("powershell.exe");
});

it("keeps choices separate when switching seats and companies without remounting", async () => {
  await show(); await expand(); await choosePlatform("windows");
  await renderSeat({ ...seat, agentId: "other" });
  expect(container.querySelector("select")?.value).toBe("unix");
  expect(container.querySelector("code")?.textContent).toContain("--agent-id 'other'");
  await renderSeat(seat, "other-company");
  expect(container.querySelector("select")?.value).toBe("unix");
  await renderSeat();
  expect(container.querySelector("select")?.value).toBe("windows");
});

it("keeps an explicit override when runtime reports arrive later", async () => {
  await show(); await expand(); await choosePlatform("unix");
  await renderSeat({ ...seat, runtime: { harnessRoot: "C:\\harness" } });
  expect(container.querySelector("select")?.value).toBe("unix");
});

it("ignores invalid stored choices and uses the target seat rather than its name", async () => {
  localStorage.setItem("paperclip:seat-upgrade-platform:company:seat", "invalid");
  await show({ ...seat, name: "Windows", runtime: { harnessRoot: "/home/user/harness" } });
  expect((await expand()).value).toBe("unix");
  expect(container.querySelector("code")?.textContent).toContain("python3");
});

it("still changes commands and explains when the browser cannot persist the choice", async () => {
  vi.stubGlobal("localStorage", {
    getItem: () => { throw new Error("Storage denied"); },
    setItem: () => { throw new Error("Storage denied"); },
  });
  await show(); await expand(); await choosePlatform("windows");
  expect(container.querySelector("select")?.value).toBe("windows");
  expect(container.querySelector("code")?.textContent).toContain("powershell.exe");
  expect(container.textContent).toContain("当前浏览器无法保存系统选择");
});
