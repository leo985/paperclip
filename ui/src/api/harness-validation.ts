import { api } from "./client";
import type { HarnessValidationGrant } from "@paperclipai/shared";

/** Preparation and one-use dispatch are separate actions. Dispatch is not completion. */
export const harnessValidationApi = {
  authorize: (companyId: string, seatId: string, taskId: string, dispatchId: string, expectedBundleDigest: string) =>
    api.post<{ authorization: HarnessValidationGrant; dispatched: false; executionStarted: false }>(
      `/companies/${companyId}/dsp7-seats/${seatId}/harness-validation/${taskId}`,
      { dispatchId, expectedBundleDigest }),
  dispatch: (companyId: string, seatId: string, taskId: string, dispatchId: string) =>
    api.post<{ runId: string; dispatched: true; executionStarted: false }>(
      `/companies/${companyId}/dsp7-seats/${seatId}/harness-validation/${taskId}/${dispatchId}/dispatch`, {}),
  revoke: (companyId: string, seatId: string, taskId: string, dispatchId: string) =>
    api.delete<{ revoked: true }>(`/companies/${companyId}/dsp7-seats/${seatId}/harness-validation/${taskId}/${dispatchId}`),
};
