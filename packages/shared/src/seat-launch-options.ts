import { z } from "zod";

/** Deliberately excludes session identity, hooks, settings and protocol overrides. */
export function validSeatClaudeArgs(args: string[]): boolean {
  const seen = new Set<string>();
  for (let i = 0; i < args.length; i++) {
    const flag = args[i];
    if (seen.has(flag)) return false;
    seen.add(flag);
    if (flag === "--dangerously-skip-permissions") continue;
    const value = args[++i];
    if (!value || value.startsWith("-") || /[\s\u0000-\u001f\u007f]/.test(value)) return false;
    if (flag === "--model") { if (!/^[a-zA-Z0-9._:/-]{1,160}$/.test(value)) return false; }
    else if (flag === "--effort") { if (!["low", "medium", "high", "max"].includes(value)) return false; }
    else if (flag === "--permission-mode") { if (!["default", "acceptEdits", "plan", "dontAsk", "auto"].includes(value)) return false; }
    else return false;
  }
  return !(seen.has("--dangerously-skip-permissions") && seen.has("--permission-mode"));
}
export const seatLaunchOptionsSchema = z.object({ extraArgs: z.array(z.string().max(160)).max(7).refine(validSeatClaudeArgs, "启动参数无效、重复或冲突；仅支持 --dangerously-skip-permissions、--model、--effort、--permission-mode") }).strict();
export interface SeatLaunchOptions { configured: boolean; extraArgs: string[]; revision: number }
export function publicSeatLaunchOptions(config: Record<string, unknown>): SeatLaunchOptions {
  const stored = config.dsp7SeatLaunchOptions as Record<string, unknown> | undefined;
  if (!stored) return { configured: false, extraArgs: [], revision: 0 };
  const parsed = seatLaunchOptionsSchema.parse({ extraArgs: stored.extraArgs });
  return { configured: true, ...parsed, revision: Number(stored.revision) };
}
