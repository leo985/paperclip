// @vitest-environment jsdom
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentPermissions } from "@paperclipai/shared";
import { TrustPresetSection } from "./TrustPresetSection";
import { TooltipProvider } from "@/components/ui/tooltip";
import { uiText } from "@/i18n/interface";
import { act } from "react";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let container: HTMLDivElement | null = null;

function renderSection(permissions: Partial<AgentPermissions>) {
  container = document.createElement("div");
  document.body.appendChild(container);
  const onChange = vi.fn();
  const createdRoot = createRoot(container);
  root = createdRoot;
  act(() => {
    createdRoot.render(
      <TooltipProvider>
        <TrustPresetSection
          permissions={permissions}
          onChange={onChange}
          companyId="company-1"
          projectCandidates={[{ id: "project-1", label: "Paperclip App" }]}
          issueCandidates={[{ id: "issue-1", label: "PAP-1 · Review PR" }]}
        />
      </TooltipProvider>,
    );
  });
  return { onChange, text: () => container?.textContent ?? "" };
}

afterEach(() => {
  if (root) {
    act(() => root?.unmount());
  }
  container?.remove();
  root = null;
  container = null;
});

describe("TrustPresetSection", () => {
  it("hides the CE boundary editor under Standard", () => {
    const view = renderSection({ canCreateAgents: false, trustPreset: "standard" });

    expect(view.text()).toContain(uiText("Trust preset"));
    expect(view.text()).not.toContain(uiText("Boundary type"));
    expect(view.text()).not.toContain(uiText("Get Paperclip EE."));
  });

  it("shows a selectable CE boundary editor for low-trust review", () => {
    const view = renderSection({
      canCreateAgents: false,
      trustPreset: "low_trust_review",
      authorizationPolicy: {
        trustPreset: "low_trust_review",
        trustBoundary: {
          mode: "low_trust_review",
          companyId: "company-1",
          projectIds: ["project-1"],
        },
      },
    });

    expect(view.text()).toContain(uiText("Containment active"));
    expect(view.text()).toContain(uiText("Boundary type"));
    expect(view.text()).toContain("Paperclip App");
    expect(view.text()).toContain(uiText("Get Paperclip EE."));
    expect(view.text()).not.toContain(uiText("Managed by EE/API"));
  });

  it("renders multi-boundary policies as read-only", () => {
    const view = renderSection({
      canCreateAgents: false,
      trustPreset: "low_trust_review",
      authorizationPolicy: {
        trustPreset: "low_trust_review",
        trustBoundary: {
          mode: "low_trust_review",
          companyId: "company-1",
          projectIds: ["project-1", "project-2"],
        },
      },
    });

    expect(view.text()).toContain(uiText("Managed by EE/API"));
    expect(view.text()).toContain("2 boundaries");
    expect(view.text()).not.toContain(uiText("Clear boundary"));
  });
});
