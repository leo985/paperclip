import { lazy, Suspense, useRef, type ReactNode } from "react";
import { useDialogActions, useDialogState } from "@/context/DialogContext";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";

const NewIssueDialog = lazy(() => import("./NewIssueDialog").then(m => ({ default: m.NewIssueDialog })));
const NewProjectDialog = lazy(() => import("./NewProjectDialog").then(m => ({ default: m.NewProjectDialog })));
const NewGoalDialog = lazy(() => import("./NewGoalDialog").then(m => ({ default: m.NewGoalDialog })));
const NewAgentDialog = lazy(() => import("./NewAgentDialog").then(m => ({ default: m.NewAgentDialog })));

function RetainedDialog({ open, close, children }: { open: boolean; close: () => void; children: ReactNode }) {
  const opened = useRef(false);
  if (open) opened.current = true;
  // Once opened, keep the original dialog mounted so its draft/cleanup behavior
  // remains intact. Merely rendering a closed shell must not fetch the editor.
  if (!opened.current) return null;
  return <Suspense fallback={<Dialog open={open} onOpenChange={value => { if (!value) close(); }}><DialogContent><DialogTitle>正在打开表单…</DialogTitle><DialogDescription>首次打开需要加载编辑器，页面其他功能不受影响。</DialogDescription><Button variant="outline" onClick={close}>取消</Button></DialogContent></Dialog>}>{children}</Suspense>;
}

export function DeferredBoardDialogs() {
  const state = useDialogState();
  const actions = useDialogActions();
  return <>
    <RetainedDialog open={state.newIssueOpen} close={actions.closeNewIssue}><NewIssueDialog /></RetainedDialog>
    <RetainedDialog open={state.newProjectOpen} close={actions.closeNewProject}><NewProjectDialog /></RetainedDialog>
    <RetainedDialog open={state.newGoalOpen} close={actions.closeNewGoal}><NewGoalDialog /></RetainedDialog>
    <RetainedDialog open={state.newAgentOpen} close={actions.closeNewAgent}><NewAgentDialog /></RetainedDialog>
  </>;
}
