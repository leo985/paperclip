// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { OnboardingWizardVariant } from "./OnboardingWizardVariant";
const state = vi.hoisted(() => ({ onboardingOpen: false, onboardingOptions: {} as { companyId?: string } }));
vi.mock("@/context/DialogContext", () => ({ useDialogState: () => state }));
vi.mock("./OnboardingWizard", () => ({ OnboardingWizard: () => <div data-testid="agent-wizard" /> }));
vi.mock("./CreateOrganizationDialog", () => ({ CreateOrganizationDialog: () => <div data-testid="organization-dialog" /> }));
let root: ReturnType<typeof createRoot>, container: HTMLDivElement;
beforeEach(() => { state.onboardingOpen = false; state.onboardingOptions = {}; container = document.createElement("div"); document.body.append(container); root = createRoot(container); });
afterEach(async () => { await act(async () => root.unmount()); container.remove(); });
async function render() { await act(async () => { root.render(<OnboardingWizardVariant />); }); await act(async () => { await new Promise(resolve => setTimeout(resolve, 50)); }); }
it("does not mount setup surfaces before opening", async () => { await render(); expect(container.textContent?.trim()).toBe(""); expect(container.children).toHaveLength(0); });
it("opens organization creation when no company is specified", async () => { state.onboardingOpen = true; await render(); expect(container.querySelector('[data-testid="organization-dialog"]')).not.toBeNull(); expect(container.querySelector('[data-testid="agent-wizard"]')).toBeNull(); });
it("opens the agent wizard for an existing company and keeps its graph mounted on close", async () => { state.onboardingOptions = { companyId: "c" }; state.onboardingOpen = true; await render(); const wizard = container.querySelector('[data-testid="agent-wizard"]'); expect(wizard).not.toBeNull(); state.onboardingOpen = false; await render(); expect(container.querySelector('[data-testid="agent-wizard"]')).toBe(wizard); });
it("unmounts organization creation on close", async () => { state.onboardingOpen = true; await render(); state.onboardingOpen = false; await render(); expect(container.children).toHaveLength(0); });
