import { z } from "zod";

/** Collaboration sidecar: never changes task assignment, execution or approval. */
export interface ManagementFollowUp {
  issueId: string;
  companyId: string;
  ownerUserId: string | null;
  remindAt: string | null;
  version: number;
  updatedBy: string;
  updatedAt: string;
}
export const managementFollowUpSchema = z.object({
  expectedVersion: z.number().int().min(0),
  ownerUserId: z.string().trim().min(1).max(200).nullable().optional(),
  remindAt: z.string().datetime({ offset: true }).nullable().optional(),
}).strict().refine(value => value.ownerUserId !== undefined || value.remindAt !== undefined, "请选择认领、转交或提醒时间");
