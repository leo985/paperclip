import { z } from "zod";

export const seatQingzhouSaveSchema = z.object({
  expectedRevision: z.number().int().min(0),
  username: z.string().trim().min(1).max(200).refine(value => !/[\r\n\0]/.test(value)),
  password: z.string().min(1).max(1000).refine(value => !/[\r\n\0]/.test(value)).optional(),
}).strict();
export const seatQingzhouRevisionSchema = z.object({ expectedRevision: z.number().int().min(0) }).strict();
export type SeatQingzhouSave = z.infer<typeof seatQingzhouSaveSchema>;
export interface SeatQingzhouAccount {
  seatId: string;
  username: string | null;
  configured: boolean;
  revision: number;
  lastCheckStatus: "not_checked" | "valid" | "failed";
  lastCheckedAt: string | null;
  updatedAt: string | null;
}
