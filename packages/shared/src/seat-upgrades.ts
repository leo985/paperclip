import { z } from "zod";

export const seatUpgradeRequestSchema = z.object({ requestId: z.string().uuid(), targetSha256: z.string().regex(/^[a-f0-9]{64}$/) }).strict();
export const seatUpgradeResultSchema = seatUpgradeRequestSchema.extend({ status: z.enum(["installed", "failed", "deferred"]) });
export interface SeatUpgradeRequest {
  requestId: string;
  targetSha256: string;
  requestedBy: string;
  requestedAt: string;
  expiresAt: string;
  status: "queued" | "claimed" | "verifying" | "succeeded" | "failed" | "cancelled" | "expired";
  message: string;
  updatedAt: string;
}
