import type { HarnessCapabilityInput } from "./harness-capabilities.js";
import { z } from "zod";
import { harnessBundleInputSchema } from "./harness-bundles.js";

/** Explicit operator selection, frozen in the original native permit. Discovery
 * records alone never populate this field or grant task execution authority. */
export const harnessExecutionCompositionSchema = z.object({
  schema: z.literal("harness.execution-composition/1"),
  selectionRevision: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  bundleRegistryRevision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  bundle: harnessBundleInputSchema,
  nativeSkill: z.enum(["jira-feature-dev", "jira-bug-fix", "jira-design-doc", "jira-code-review", "jira-design-review"]),
  entryId: z.string().regex(/^[a-z][a-z0-9-]{0,79}$/),
}).strict();
export type HarnessExecutionComposition = z.infer<typeof harnessExecutionCompositionSchema>;
/** Server-selected machine binding; not a task or business execution grant. */
export interface HarnessExecutionRoute {
  protocolVersion: 1 | 2;
  runId: string;
  taskId: string;
  agentId: string;
  companyId: string;
  machineId: string;
  registryRevision: number;
  capabilityId: string;
  capability: HarnessCapabilityInput;
  composition?: HarnessExecutionComposition;
}
