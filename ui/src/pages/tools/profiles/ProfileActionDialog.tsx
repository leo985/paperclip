import { uiTextFormat,  uiText } from "@/i18n/interface";
import { AlertTriangle } from "lucide-react";
import type { ToolProfileWithDetails } from "@paperclipai/shared";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

export type ProfileActionDialogKind = "archive" | "delete" | "restore";

export function ProfileActionDialog({
  kind,
  profile,
  pending,
  onClose,
  onArchive,
  onRestore,
  onDelete,
}: {
  kind: ProfileActionDialogKind | null;
  profile: ToolProfileWithDetails | null;
  pending: boolean;
  onClose: () => void;
  onArchive: () => void;
  onRestore: () => void;
  onDelete: () => void;
}) {
  if (!kind || !profile) return null;

  const defaultDeleteBlocked = kind === "delete" && profile.summary.isCompanyDefault;
  const copy = {
    archive: {
      title: uiText("Archive profile"),
      body: uiTextFormat("This profile stops applying to __PCVAR0__ __PCVAR1__. You can restore it later.", [profile.summary.appliesToAgentCount, profile.summary.appliesToAgentCount === 1 ? "agent" : "agents"]),
      confirm: "Archive",
      action: onArchive,
    },
    restore: {
      title: uiText("Restore profile"),
      body: uiText("This profile will be active again and can be assigned to agents."),
      confirm: "Restore",
      action: onRestore,
    },
    delete: {
      title: uiText("Delete profile"),
      body: defaultDeleteBlocked
        ? uiText("This profile is the organization default. Reassign the organization default to another profile before deleting it.")
        : `This permanently deletes the profile and removes ${profile.summary.assignmentCount} ${profile.summary.assignmentCount === 1 ? "assignment" : "assignments"}.`,
      confirm: "Delete",
      action: onDelete,
    },
  }[kind];

  return (
    <Dialog open onOpenChange={(next) => !next && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{copy.title}</DialogTitle>
          <DialogDescription>{copy.body}</DialogDescription>
        </DialogHeader>
        {defaultDeleteBlocked ? (
          <div className="flex gap-3 rounded-lg border border-destructive/40 bg-destructive/5 px-3 py-2 text-sm text-destructive">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
            <span>{uiText("Choose another access profile and make it the organization default first.")}</span>
          </div>
        ) : null}
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>{uiText("Cancel")}</Button>
          <Button
            variant={kind === "delete" ? "destructive" : "default"}
            disabled={pending || defaultDeleteBlocked}
            onClick={copy.action}
          >
            {copy.confirm}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
