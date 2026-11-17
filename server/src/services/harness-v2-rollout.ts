import { z } from "zod";

const scopeSchema = z.array(z.object({
  companyId: z.string().uuid(),
  seatId: z.string().uuid(),
}).strict()).max(16);

/** Candidate rollout only. This never grants task execution authority. */
export function harnessV2Enabled(
  feature: "observation" | "bundles",
  companyId: string,
  seatId: string,
): boolean {
  const flag = feature === "observation"
    ? "DSP7_HARNESS_OBSERVATION_ENABLED" : "DSP7_HARNESS_BUNDLES_ENABLED";
  if (process.env[flag] !== "true") return false;
  const raw = process.env.DSP7_HARNESS_V2_SEATS;
  if (!raw || raw.length > 8192) return false;
  try {
    const scopes = scopeSchema.safeParse(JSON.parse(raw));
    return scopes.success && scopes.data.some(scope =>
      scope.companyId === companyId && scope.seatId === seatId);
  } catch {
    return false;
  }
}
