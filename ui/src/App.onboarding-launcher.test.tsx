// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter, Routes, Route } from "react-router-dom";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
const state = vi.hoisted(() => ({ admin: true, loading: false, open: false, create: vi.fn(), cloud: null as null | { cloudBaseUrl: string } }));
vi.mock("@/context/CompanyContext", () => ({ useCompany: () => ({ companies: [{ id: "c", issuePrefix: "PC1" }], selectedCompany: { id: "c", issuePrefix: "PC1" }, loading: false }) }));
vi.mock("@/context/DialogContext", () => ({ useDialogActions: () => ({ openOnboarding: state.create }), useDialogState: () => ({ onboardingOpen: state.open }) }));
vi.mock("@/hooks/useManagementAccess", () => ({ useManagementAccess: () => ({ isInstanceAdmin: state.admin, loading: state.loading }) }));
vi.mock("@/hooks/useCloudInstance", () => ({ useCloudInstance: () => state.cloud }));
const { OnboardingRoutePage } = await import("./App");
let container: HTMLDivElement, root: ReturnType<typeof createRoot>;
beforeEach(() => { state.admin = true; state.loading = false; state.open = false; state.cloud = null; state.create.mockClear(); container = document.createElement("div"); document.body.append(container); root = createRoot(container); });
afterEach(async () => { await act(async () => root.unmount()); container.remove(); });
async function render(prefix = "PC1") { await act(async () => root.render(<MemoryRouter initialEntries={[`/${prefix}/onboarding`]}><Routes><Route path="/:companyPrefix/onboarding" element={<OnboardingRoutePage />} /><Route path="/:companyPrefix/setup" element={<p>Organization setup checklist</p>} /></Routes></MemoryRouter>)); }
it("redirects an existing company to its setup checklist", async () => { await render(); expect(container.textContent).toContain("Organization setup checklist"); expect(state.create).not.toHaveBeenCalled(); });
it("allows instance admins to create an organization when the prefix does not match", async () => { await render("MISSING"); const button = [...container.querySelectorAll("button")].find(b => b.textContent === "创建组织"); expect(button).toBeDefined(); await act(async () => button!.click()); expect(state.create).toHaveBeenCalledWith(); });
it("does not offer organization creation to ordinary members", async () => { state.admin = false; await render("MISSING"); expect(container.textContent).toContain("需要实例管理员权限"); expect(container.querySelector("button")).toBeNull(); expect(state.create).not.toHaveBeenCalled(); });
it("does not redirect or launch while a dialog is open", async () => { state.open = true; await render(); expect(container.textContent).toBe(""); expect(state.create).not.toHaveBeenCalled(); });
