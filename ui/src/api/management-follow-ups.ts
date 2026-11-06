import type { ManagementFollowUp } from "@paperclipai/shared";
import { api } from "./client";

const base = (companyId: string) => `/companies/${companyId}/management-follow-ups`;
export const managementFollowUpApi = {
  get: async (companyId: string, issueId: string) => (await api.get<ManagementFollowUp[]>(base(companyId) + "?issueIds=" + encodeURIComponent(issueId)))[0] ?? null,
  update: (companyId: string, issueId: string, input: { expectedVersion: number; ownerUserId?: string | null; remindAt?: string | null }) => api.put<ManagementFollowUp>(base(companyId) + "/" + issueId, input),
};
