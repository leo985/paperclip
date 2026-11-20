import type { ManagedManifest } from "@paperclipai/shared";

/** Old manifests lack provenance; only recognize concrete native injection wrappers. */
export function managedInputLabel(manifest: ManagedManifest, text: string): string | null {
  if (manifest.kind === "tool_call" && manifest.name === "AskUserQuestion") return "Claude 提问";
  if (manifest.kind === "tool_result" && manifest.name === "AskUserQuestion") {
    let nativeAnswer: unknown;
    try { nativeAnswer = JSON.parse(text); } catch { nativeAnswer = null; }
    const recordedHumanAnswer = typeof nativeAnswer === "string" && nativeAnswer.startsWith("User has answered your questions:");
    return manifest.inputSource === "manual" || (!manifest.inputSource && recordedHumanAnswer)
      ? "手动输入 · 选项答复" : "选项答复（来源未记录）";
  }
  if (manifest.kind !== "user") return null;
  if (manifest.inputSource === "harness") return "Harness 注入";
  if (manifest.inputSource === "manual") return "手动输入";
  if (/^Base directory for this skill: [^\n]+\n/.test(text) ||
      /^当前目录为已登记的需求分析 Harness。\s*先读取 CLAUDE\.md/.test(text)) return "Harness 注入";
  return "输入（来源未记录）";
}

export function isManagedDialogue(manifest: ManagedManifest): boolean {
  return ["user", "assistant"].includes(manifest.kind) ||
    (["tool_call", "tool_result"].includes(manifest.kind) && manifest.name === "AskUserQuestion");
}
