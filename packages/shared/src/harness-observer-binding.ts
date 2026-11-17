import { z } from "zod";
import { harnessBundleInputSchema } from "./harness-bundles.js";

/** A frozen observation attachment. This is never an execution route or load receipt. */
export const harnessObserverBindingSchema = z.object({
  schema: z.literal("harness.observer-binding/1"),
  companyId: z.string().uuid(),
  seatId: z.string().uuid(),
  machineId: z.string().uuid(),
  taskId: z.string().uuid(),
  runId: z.string().uuid(),
  projectId: z.string().uuid().nullable(),
  registryRevision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  bundle: harnessBundleInputSchema,
  purpose: z.literal("observation-only"),
  executionReady: z.literal(false),
  loadState: z.literal("unconfirmed"),
}).strict();
export type HarnessObserverBinding = z.infer<typeof harnessObserverBindingSchema>;
