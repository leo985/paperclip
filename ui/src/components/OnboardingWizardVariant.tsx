import { lazy, Suspense, useRef } from "react";
import { useDialogState } from "@/context/DialogContext";
import { PaperclipLoading } from "./AnimatedPaperclipIcon";

const CreateOrganizationDialog = lazy(() => import("./CreateOrganizationDialog").then(m => ({ default: m.CreateOrganizationDialog })));

const OnboardingWizard = lazy(() => import("./OnboardingWizard").then(m => ({ default: m.OnboardingWizard })));

/** Keep the setup/editor graph out of ordinary page navigation. */
export function OnboardingWizardVariant() {
  const { onboardingOpen, onboardingOptions } = useDialogState();
  const opened = useRef(false);
  if (onboardingOpen) opened.current = true;
  if (!opened.current) return null;
  if (!onboardingOptions.companyId) return onboardingOpen ? <Suspense fallback={<PaperclipLoading />}><CreateOrganizationDialog /></Suspense> : null;
  return <Suspense fallback={onboardingOpen ? <PaperclipLoading /> : null}><OnboardingWizard /></Suspense>;
}
