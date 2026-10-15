import { useManagementAccess } from "@/hooks/useManagementAccess";
import { useLocation, useNavigationType, useNavigate } from "@/lib/router";
import { createContext, useCallback, useContext, useMemo, useState, useEffect, useRef, type ReactNode } from "react";
import type { IssueWorkMode } from "@paperclipai/shared";

interface NewIssueDefaults {
  status?: string;
  workMode?: IssueWorkMode;
  priority?: string;
  projectId?: string;
  projectWorkspaceId?: string;
  goalId?: string;
  parentId?: string;
  parentIdentifier?: string;
  parentTitle?: string;
  executionWorkspaceId?: string;
  executionWorkspaceMode?: string;
  parentExecutionWorkspaceLabel?: string;
  assigneeAgentId?: string;
  assigneeUserId?: string;
  title?: string;
  description?: string;
}

interface NewGoalDefaults {
  parentId?: string;
}

interface OnboardingOptions {
  initialStep?: 1 | 2 | 3 | 4;
  companyId?: string;
  returnTo?: string;
}

interface DialogContextValue {
  newIssueOpen: boolean;
  newIssueDefaults: NewIssueDefaults;
  openNewIssue: (defaults?: NewIssueDefaults) => void;
  closeNewIssue: () => void;
  newProjectOpen: boolean;
  openNewProject: () => void;
  closeNewProject: () => void;
  newGoalOpen: boolean;
  newGoalDefaults: NewGoalDefaults;
  openNewGoal: (defaults?: NewGoalDefaults) => void;
  closeNewGoal: () => void;
  newAgentOpen: boolean;
  openNewAgent: () => void;
  closeNewAgent: () => void;
  onboardingOpen: boolean;
  onboardingOptions: OnboardingOptions;
  openOnboarding: (options?: OnboardingOptions) => void;
  closeOnboarding: () => void;
  // Whether the user has dismissed the route-driven onboarding wizard (the one
  // that auto-opens on /onboarding). Shared so the route launcher can hand off
  // fully to the wizard instead of remaining interactive behind it.
  onboardingRouteDismissed: boolean;
  setOnboardingRouteDismissed: (dismissed: boolean) => void;
}

type DialogStateValue = Pick<
  DialogContextValue,
  | "newIssueOpen"
  | "newIssueDefaults"
  | "newProjectOpen"
  | "newGoalOpen"
  | "newGoalDefaults"
  | "newAgentOpen"
  | "onboardingOpen"
  | "onboardingOptions"
  | "onboardingRouteDismissed"
>;

type DialogActionsValue = Omit<DialogContextValue, keyof DialogStateValue>;

const DialogStateContext = createContext<DialogStateValue | null>(null);
const DialogActionsContext = createContext<DialogActionsValue | null>(null);

export function DialogProvider({ children }: { children: ReactNode }) {
  const { canManage } = useManagementAccess();
  const navigate = useNavigate();
  const location = useLocation();
  const navigationType = useNavigationType();
  const lastLocationKey = useRef(location.key);
  const [newIssueOpen, setNewIssueOpen] = useState(false);
  const [newIssueDefaults, setNewIssueDefaults] = useState<NewIssueDefaults>({});
  const [newProjectOpen, setNewProjectOpen] = useState(false);
  const [newGoalOpen, setNewGoalOpen] = useState(false);
  const [newGoalDefaults, setNewGoalDefaults] = useState<NewGoalDefaults>({});
  const [newAgentOpen, setNewAgentOpen] = useState(false);
  const [onboardingOpen, setOnboardingOpen] = useState(false);
  const [onboardingOptions, setOnboardingOptions] = useState<OnboardingOptions>({});
  const [onboardingRouteDismissed, setOnboardingRouteDismissed] = useState(false);

  const openNewIssue = useCallback((defaults: NewIssueDefaults = {}) => {
    if (!canManage) { navigate("/jira-intake"); return; }
    setNewIssueDefaults(defaults);
    setNewIssueOpen(true);
  }, [canManage, navigate]);

  const closeNewIssue = useCallback(() => {
    setNewIssueOpen(false);
    setNewIssueDefaults({});
  }, []);

  const openNewProject = useCallback(() => {
    if (!canManage) { navigate("/management"); return; }
    setNewProjectOpen(true);
  }, [canManage, navigate]);

  const closeNewProject = useCallback(() => {
    setNewProjectOpen(false);
  }, []);

  const openNewGoal = useCallback((defaults: NewGoalDefaults = {}) => {
    if (!canManage) { navigate("/management"); return; }
    setNewGoalDefaults(defaults);
    setNewGoalOpen(true);
  }, [canManage, navigate]);

  const closeNewGoal = useCallback(() => {
    setNewGoalOpen(false);
    setNewGoalDefaults({});
  }, []);

  const openNewAgent = useCallback(() => {
    if (!canManage) { navigate("/management"); return; }
    setNewAgentOpen(true);
  }, [canManage, navigate]);

  const closeNewAgent = useCallback(() => {
    setNewAgentOpen(false);
  }, []);

  const openOnboarding = useCallback((options: OnboardingOptions = {}) => {
    if (!canManage) { navigate("/seats"); return; }
    setOnboardingOptions({...options,returnTo:options.returnTo??location.pathname+location.search+location.hash});
    setOnboardingOpen(true);
  }, [canManage, navigate, location.pathname, location.search, location.hash]);

  const closeOnboarding = useCallback(() => {
    setOnboardingOpen(false);
    setOnboardingOptions({});
  }, []);

  // A global dialog must not follow users through browser Back / Forward.
  useEffect(() => {
    if(lastLocationKey.current===location.key)return;
    lastLocationKey.current=location.key;
    setNewIssueOpen(false);setNewProjectOpen(false);setNewGoalOpen(false);setNewAgentOpen(false);
    if(navigationType!=="POP")return;
    setOnboardingOpen(false);setOnboardingRouteDismissed(true);
  },[location.key,navigationType]);

  const stateValue = useMemo<DialogStateValue>(
    () => ({
      newIssueOpen,
      newIssueDefaults,
      newProjectOpen,
      newGoalOpen,
      newGoalDefaults,
      newAgentOpen,
      onboardingOpen,
      onboardingOptions,
      onboardingRouteDismissed,
    }),
    [
      newIssueOpen,
      newIssueDefaults,
      newProjectOpen,
      newGoalOpen,
      newGoalDefaults,
      newAgentOpen,
      onboardingOpen,
      onboardingOptions,
      onboardingRouteDismissed,
    ],
  );

  const actionsValue = useMemo<DialogActionsValue>(
    () => ({
      openNewIssue,
      closeNewIssue,
      openNewProject,
      closeNewProject,
      openNewGoal,
      closeNewGoal,
      openNewAgent,
      closeNewAgent,
      openOnboarding,
      closeOnboarding,
      setOnboardingRouteDismissed,
    }),
    [
      openNewIssue,
      closeNewIssue,
      openNewProject,
      closeNewProject,
      openNewGoal,
      closeNewGoal,
      openNewAgent,
      closeNewAgent,
      openOnboarding,
      closeOnboarding,
      setOnboardingRouteDismissed,
    ],
  );

  return (
    <DialogActionsContext.Provider value={actionsValue}>
      <DialogStateContext.Provider value={stateValue}>
        {children}
      </DialogStateContext.Provider>
    </DialogActionsContext.Provider>
  );
}

export function useDialogActions() {
  const ctx = useContext(DialogActionsContext);
  if (!ctx) {
    throw new Error("useDialogActions must be used within DialogProvider");
  }
  return ctx;
}

export function useDialogState() {
  const ctx = useContext(DialogStateContext);
  if (!ctx) {
    throw new Error("useDialogState must be used within DialogProvider");
  }
  return ctx;
}

export function useDialog() {
  return {
    ...useDialogState(),
    ...useDialogActions(),
  };
}
