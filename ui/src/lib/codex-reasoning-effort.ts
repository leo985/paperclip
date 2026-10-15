import { uiText } from "@/i18n/interface";
import {
  codexLocalReasoningEffortsForModel,
  type CodexLocalReasoningEffort,
} from "@paperclipai/adapter-codex-local";

const CODEX_REASONING_EFFORT_LABELS: Record<CodexLocalReasoningEffort, string> = {
  minimal: uiText("Minimal"),
  low: uiText("Low"),
  medium: uiText("Medium"),
  high: uiText("High"),
  xhigh: "X-High",
  max: uiText("Max"),
  ultra: "Ultra",
};

export function codexReasoningEffortOptions(
  model: string | null | undefined,
  defaultLabel = "Default",
) {
  return [
    { value: "", label: defaultLabel },
    ...codexLocalReasoningEffortsForModel(model).map((value) => ({
      value,
      label: CODEX_REASONING_EFFORT_LABELS[value],
    })),
  ];
}
