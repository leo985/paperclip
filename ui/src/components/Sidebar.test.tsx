// @vitest-environment jsdom
// The focused delivery shell replaced the legacy expandable/plugin sidebar.
// Exercise its live navigation, authorization, mobile and collapsed contracts.
import { act, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { TooltipProvider } from "./ui/tooltip";
import { Sidebar } from "./Sidebar";
const state = vi.hoisted(() => ({ canManage: false, collapsed: false, peeking: false, isMobile: false, setSidebarOpen: vi.fn(), inbox: 3 }));
vi.mock("@/lib/router", () => ({
  Link: ({ to, children, ...props }: { to: string; children: ReactNode }) => <a href={to} {...props}>{children}</a>,
  NavLink: ({ to, children, className, ...props }: { to: string; children: ReactNode; className?: string | ((state: { isActive: boolean }) => string) }) => <a href={to} className={typeof className === "function" ? className({ isActive: false }) : className} {...props}>{children}</a>,
}));
vi.mock("@/context/CompanyContext", () => ({ useCompany: () => ({ selectedCompanyId: "company" }) }));
vi.mock("@/context/SidebarContext", () => ({ useSidebar: () => state }));
vi.mock("@/hooks/useManagementAccess", () => ({ useManagementAccess: () => ({ canManage: state.canManage }) }));
vi.mock("@/hooks/useInboxBadge", () => ({ useInboxBadge: () => ({ inbox: state.inbox }) }));
vi.mock("./SidebarCompanyMenu.production", () => ({ SidebarCompanyMenu: () => <button>Company chooser</button> }));
vi.mock("./SeatAttentionNav", () => ({ SeatAttentionNav: () => <a href="/seats">席位管理</a> }));
let root: ReturnType<typeof createRoot>, container: HTMLDivElement;
beforeEach(() => { state.canManage = false; state.collapsed = false; state.peeking = false; state.isMobile = false; state.setSidebarOpen.mockClear(); container = document.createElement("div"); document.body.append(container); root = createRoot(container); });
afterEach(async () => { await act(async () => root.unmount()); container.remove(); });
async function render() { await act(async () => root.render(<TooltipProvider><Sidebar /></TooltipProvider>)); }
it.each([
  ["/dashboard", "工作台"], ["/delivery", "需求条目"], ["/delivery-chain", "AI交付链"], ["/issues", "AI任务"],
  ["/delivery-dashboard", "席位看板"], ["/delivery-workbench", "交付报表"], ["/projects", "项目"], ["/seats", "席位管理"],
  ["/runs", "执行记录"], ["/search", "搜索"], ["/help", "帮助中心"],
])("keeps %s reachable with its visible label", async (path, label) => { await render(); expect(container.querySelector(`nav a[href="${path}"]`)?.textContent).toContain(label); });
it("shows management only to managers", async () => { await render(); expect(container.querySelector('a[href="/management"]')).toBeNull(); state.canManage = true; await render(); expect(container.querySelector('a[href="/management"]')?.textContent).toContain("管理中心"); });
it("keeps brand, chooser and section navigation in the live shell", async () => { await render(); expect(container.querySelector('nav[aria-label="交付协同导航"]')).not.toBeNull(); expect(container.textContent).toContain("Company chooser"); expect(container.querySelector('aside')?.classList.contains("border-r")).toBe(true); });
it("has one workbench entry and does not reuse the legacy inbox badge", async () => { await render(); expect(container.querySelector('a[href="/inbox"]')).toBeNull(); expect(container.querySelector('a[href="/dashboard"]')?.textContent).not.toContain("3"); });
it("hides section headings in the rail and restores them while peeking", async () => { state.collapsed = true; await render(); expect(container.querySelectorAll("nav > p")).toHaveLength(0); state.peeking = true; await render(); expect(container.querySelectorAll("nav > p")).toHaveLength(3); });
it("preserves accessible link names in the collapsed rail", async () => { state.collapsed = true; await render(); const workbench = container.querySelector('a[href="/dashboard"]'); expect(workbench?.getAttribute("aria-label")).toContain("工作台"); });
it("closes the mobile drawer on navigation", async () => { state.isMobile = true; await render(); await act(async () => (container.querySelector('nav a[href="/issues"]') as HTMLAnchorElement).click()); expect(state.setSidebarOpen).toHaveBeenCalledWith(false); });
it("leaves desktop navigation open", async () => { await render(); await act(async () => (container.querySelector('nav a[href="/issues"]') as HTMLAnchorElement).click()); expect(state.setSidebarOpen).not.toHaveBeenCalled(); });

it("keeps analysis under tasks instead of a separate sidebar entry", async () => { await render(); expect(container.querySelector('a[href="/analysis-executions"]')).toBeNull(); });
