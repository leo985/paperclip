// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import type { SeatQingzhouAccount } from "@paperclipai/shared";
import { SeatQingzhouAccountForm } from "./SeatQingzhouAccount";
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
let cleanup: (() => Promise<void>) | undefined;
afterEach(async () => { await cleanup?.(); cleanup = undefined; });
const account: SeatQingzhouAccount = { seatId: "seat", username: "analyst", configured: true, revision: 4, lastCheckStatus: "valid", lastCheckedAt: null, updatedAt: null };
async function mount(value = account) {
  const node = document.createElement("div"); document.body.append(node); const root = createRoot(node);
  const onSave = vi.fn(), onCheck = vi.fn(), onRemove = vi.fn();
  await act(async () => root.render(<SeatQingzhouAccountForm account={value} busy={false} onSave={onSave} onCheck={onCheck} onRemove={onRemove}/>));
  cleanup = async () => { await act(async () => root.unmount()); node.remove(); };
  return { node, onSave, onCheck, onRemove };
}
it("shows the bound identity without putting any stored password into the form", async () => {
  const { node, onSave } = await mount();
  const password = node.querySelector('input[type="password"]') as HTMLInputElement;
  expect(password.value).toBe(""); expect(password.placeholder).toBe("****"); expect(password.required).toBe(false);
  expect(node.textContent).toContain("登录成功"); expect(node.textContent).toContain("不会返回页面");
  await act(async () => node.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
  expect(onSave).toHaveBeenCalledWith({ username: "analyst", expectedRevision: 4 });
});
it("requires a password for a new account", async () => {
  const { node } = await mount({ ...account, username: null, configured: false, revision: 0, lastCheckStatus: "not_checked" });
  expect((node.querySelector('input[type="password"]') as HTMLInputElement).required).toBe(true);
  expect((node.querySelector('input[type="password"]') as HTMLInputElement).placeholder).toBe("请输入密码");
  expect((node.querySelector('button[type="submit"]') as HTMLButtonElement).disabled).toBe(true);
  expect(node.textContent).toContain("未配置");
});
it("requires a replacement password when the username changes", async () => {
  const { node } = await mount();
  const username = node.querySelector('input[name="qingzhou-username"]') as HTMLInputElement;
  await act(async () => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(username, "new-analyst"); username.dispatchEvent(new Event("input", { bubbles: true })); });
  expect((node.querySelector('input[type="password"]') as HTMLInputElement).required).toBe(true);
});
it("checks or removes the saved account through explicit controls", async () => {
  const { node, onCheck, onRemove } = await mount();
  await act(async () => (Array.from(node.querySelectorAll("button")).find(button => button.textContent === "检查已保存账号")!).click());
  await act(async () => (Array.from(node.querySelectorAll("button")).find(button => button.textContent === "移除账号")!).click());
  expect(onCheck).toHaveBeenCalledOnce(); expect(onRemove).toHaveBeenCalledOnce();
});
