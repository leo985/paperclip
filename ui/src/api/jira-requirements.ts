import { api } from "./client";
import type { JiraRequirementPreview } from "@paperclipai/shared";
const base = (companyId: string, seatId: string) => `/companies/${companyId}/dsp7-seats/${seatId}/jira-requirements`;
export const jiraRequirementsApi = {
  prepare: (companyId: string, seatId: string, taskId: string) => api.post<{ taskId: string; seatId: string; jiraKey: string }>(base(companyId, seatId) + "/prepare", { taskId }),
  preview: (companyId: string, seatId: string, body: { jiraKey: string; projectId: string }) => api.post<JiraRequirementPreview>(base(companyId, seatId) + "/preview", body),
  import: (companyId: string, seatId: string, body: { jiraKey: string; projectId: string; fingerprint: string; ownerUserId?: string }) => api.post<{ taskId: string; existing: boolean }>(base(companyId, seatId) + "/import", body),
};
