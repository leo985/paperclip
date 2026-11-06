import { z } from "zod";
export const HARNESS_ROLES = ["requirements-analysis", "system-design", "coding", "bug-fix", "code-review", "design-review", "test-case-review", "test-cases", "functional-test"] as const;
export const harnessCapabilityInputSchema = z.object({
  kind: z.enum(["analysis", "development", "qa"]),
  repository: z.string().regex(/^[A-Za-z0-9.-]+(?::\d+)?\/[A-Za-z0-9_./-]+$/).max(500).refine(v=>!v.split("/").some(p=>p==="."||p==="..")),
  root: z.string().max(2048).regex(/^(?:\/|[A-Za-z]:[\\/])/).refine(v=>!/[\r\n\0]/.test(v)),
  profile: z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/),
  commit: z.string().regex(/^[a-f0-9]{40,64}$/),
  manifestDigest: z.string().regex(/^[a-f0-9]{64}$/),
  roles: z.array(z.enum(HARNESS_ROLES)).min(1).max(9),
  protocolVersion: z.literal(1),
}).strict().superRefine((value,ctx)=>{
  const allowed = value.kind === "analysis" ? ["requirements-analysis"] : value.kind === "qa" ? ["test-cases","functional-test","test-case-review"] : ["system-design","coding","bug-fix","code-review","design-review"];
  if(new Set(value.roles).size!==value.roles.length || value.roles.some(r=>!allowed.includes(r))) ctx.addIssue({code:"custom",message:"Harness 类型与能力不匹配"});
});
export type HarnessCapabilityInput = z.infer<typeof harnessCapabilityInputSchema>;
export interface HarnessCapability extends HarnessCapabilityInput { id: string; checkedAt: string; validation: "local-files"; executionReady: false }
export interface HarnessCapabilityRegistry { version:1; revision:number; items:HarnessCapability[]; routing?: Partial<Record<HarnessCapabilityInput["kind"], string>> }

/** Seat-reported business checkout metadata; machine-local paths never leave the seat. */
export const harnessRepositorySchema = z.object({
  url: z.string().max(1000).refine(value => {
    try {
      const u = new URL(value);
      return !/\s/.test(value) && !value.split("/").some(p => p === "." || p === "..") && ["http:", "https:", "ssh:"].includes(u.protocol) && !!u.hostname && !u.username && !u.password && !u.search && !u.hash && /^\/[A-Za-z0-9_./-]+$/.test(u.pathname) && !u.pathname.split("/").some(p => p === "." || p === "..");
    } catch { return false; }
  }, "Invalid credential-free repository URL"),
  ref: z.string().min(1).max(250).refine(v => !/[\s\x00-\x1f]/.test(v) && !v.startsWith("-") && !v.includes("..")),
}).strict();
export type HarnessRepository = z.infer<typeof harnessRepositorySchema>;
