import { z } from "zod";
import { harnessObserverBindingSchema } from "./harness-observer-binding.js";

/** Separate authorization for a single synthetic validation. Discovery and the
 * observation-only descriptor never grant authority by themselves. */
export const harnessValidationBindingSchema = harnessObserverBindingSchema.omit({
  schema: true, purpose: true, executionReady: true, loadState: true,
}).extend({
  schema: z.literal("harness.validation-binding/1"),
  dispatchId: z.string().uuid(),
  expiresAt: z.string().datetime(),
  purpose: z.literal("synthetic-history"),
  fixtureVersion: z.literal(1),
}).strict();
export type HarnessValidationBinding = z.infer<typeof harnessValidationBindingSchema>;

export const harnessValidationAuthorizationSchema = z.object({
  dispatchId: z.string().uuid(),
  expectedBundleDigest: z.string().regex(/^[a-f0-9]{64}$/),
}).strict();

export const harnessValidationGrantSchema = harnessValidationBindingSchema.omit({ runId: true }).extend({
  schema: z.literal("harness.validation-authorization/1"),
  ownerUserId: z.string().min(1),
  grantedBy: z.string().min(1),
}).strict();
export type HarnessValidationGrant = z.infer<typeof harnessValidationGrantSchema>;
