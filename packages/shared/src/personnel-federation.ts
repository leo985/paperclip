import { z } from "zod";

export const personnelSourceInputSchema = z.object({
  id: z.string().uuid().optional(),
  // Existing sources retain their original encrypted-vault and audit context.
  auditCompanyId: z.string().uuid().optional(),
  type: z.enum(["DingTalk", "WeCom"]),
  name: z.string().trim().min(1).max(200),
  corpId: z.string().trim().min(1).max(200),
  appKey: z.string().trim().max(200),
  syncScope: z.string().trim().regex(/^\d+(\s*,\s*\d+)*$/),
  enabled: z.boolean(),
  autoSync: z.boolean(),
  syncInterval: z.number().int().min(300).max(86400),
  credentials: z.object({secret: z.string().min(1).max(4096)}).strict().optional(),
}).strict();

export const personnelMembershipInputSchema = z.object({
  companyId: z.string().uuid(),
}).strict();

export type PersonnelSourceInput = z.infer<typeof personnelSourceInputSchema>;

export const personnelAccountRelinkInputSchema = z.object({
  userId: z.string().min(1),
  expectedUserId: z.string().min(1),
  reason: z.string().trim().min(5).max(500),
  confirm: z.literal(true),
}).strict();
export type PersonnelAccountRelinkInput = z.infer<typeof personnelAccountRelinkInputSchema>;
