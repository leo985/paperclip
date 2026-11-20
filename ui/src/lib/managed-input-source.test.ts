import { describe, expect, it } from "vitest";
import type { ManagedManifest } from "@paperclipai/shared";
import { managedInputLabel, isManagedDialogue } from "./managed-input-source";
const manifest = (values: Partial<ManagedManifest> = {}) => ({ kind: "user", ...values }) as ManagedManifest;
describe("managed input provenance", () => {
  it("distinguishes injected and manual messages without guessing unknown historical input", () => {
    expect(managedInputLabel(manifest({ inputSource: "harness" }), "prompt")).toBe("Harness 注入");
    expect(managedInputLabel(manifest({ inputSource: "manual" }), "prompt")).toBe("手动输入");
    expect(managedInputLabel(manifest(), "prompt")).toBe("输入（来源未记录）");
    expect(managedInputLabel(manifest({ kind: "assistant" }), "answer")).toBeNull();
  });
  it("recognizes the historical skill and analysis bootstrap wrappers only at the start", () => {
    expect(managedInputLabel(manifest(), "Base directory for this skill: /repo/.claude/skills/analysis\n\n# Skill")).toBe("Harness 注入");
    expect(managedInputLabel(manifest(), "当前目录为已登记的需求分析 Harness。先读取 CLAUDE.md，加载技能。")).toBe("Harness 注入");
    expect(managedInputLabel(manifest(), "请解释 Base directory for this skill: /repo\n")).toBe("输入（来源未记录）");
    expect(managedInputLabel(manifest({ inputSource: "manual" }), "Base directory for this skill: /repo\n")).toBe("手动输入");
  });
  it("keeps option questions and answers visible in the dialogue filter", () => {
    for (const kind of ["tool_call", "tool_result"] as const) {
      expect(isManagedDialogue(manifest({ kind, name: "AskUserQuestion" }))).toBe(true);
      expect(isManagedDialogue(manifest({ kind, name: "Bash" }))).toBe(false);
    }
    expect(managedInputLabel(manifest({ kind: "tool_result", name: "AskUserQuestion", inputSource: "manual" }), "")).toBe("手动输入 · 选项答复");
    expect(managedInputLabel(manifest({ kind: "tool_result", name: "AskUserQuestion" }), "")).toBe("选项答复（来源未记录）");
    expect(managedInputLabel(manifest({ kind: "tool_result", name: "AskUserQuestion" }), JSON.stringify('User has answered your questions: "方式"="先下载附件"'))).toBe("手动输入 · 选项答复");
  });
});
