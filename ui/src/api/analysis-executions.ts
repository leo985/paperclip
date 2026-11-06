import { api } from "./client";
import type { AnalysisExecution, AnalysisDecision } from "@paperclipai/shared";
const base = (c: string) => `/companies/${c}/analysis-executions`;
export const analysisApi = {
  list: (c: string, projectId: string, page = 1) =>
    api.get<{ items: AnalysisExecution[]; hasMore: boolean }>(
      base(c) +
        `?page=${page}${projectId ? `&projectId=${encodeURIComponent(projectId)}` : ""}`,
    ),
  seats: (c: string) =>
    api.get<
      Array<{
        id: string;
        name: string;
        ownerUserId: string | null;
        capabilityId: string | null;
        profile: string | null;
        clientReady: boolean;
        online: boolean;
      }>
    >(base(c) + "/seats"),
  detail: (c: string, id: string) =>
    api.get<{
      execution: AnalysisExecution;
      decisions: AnalysisDecision[];
      run: { id: string; status: string; error: string | null } | null;
    }>(base(c) + "/" + id),
  create: (c: string, input: unknown) =>
    api.post<AnalysisExecution>(base(c), input),
  dispatch: (c: string, id: string, requestId: string) =>
    api.post<{ runId: string | null }>(base(c) + "/" + id + "/dispatch", {
      requestId,
    }),
  answer: (c: string, id: string, d: AnalysisDecision, answer: string) =>
    api.post(base(c) + `/${id}/decisions/${d.id}/answer`, {
      answer,
      contentDigest: d.contentDigest,
    }),
  publication: (c: string, id: string, input: unknown) =>
    api.post(base(c) + `/${id}/publication`, input),
  stop: (c: string, id: string) => api.post(base(c) + `/${id}/stop`, {}),
};
