import { api } from "./client";
import type {
  DeliveryWorkflow,
  DeliveryWorkflowInbox,
  DeliveryWorkflowTaskContext,
  DeliveryAutomaticPlan,
  DeliveryAutomaticPlanInput,
  DeliveryAutomaticStartInput,
  DeliverySavedAutomaticPlan,
  DeliveryWorkflowConfig,
  DeliveryRepairConfig,
} from "@paperclipai/shared";
const base = (c: string) => `/companies/${c}/delivery-workflows`;
export interface WorkflowSeat {
  id: string;
  name: string;
  domains: Array<{ kind: string; roles: string[] }>;
  online: boolean;
  clientReady: boolean;
  orderedReviewReady?: boolean;
  jiraKeys?: string[];
}
export const deliveryWorkflowApi = {
  pendingActions: (c:string,scope:"mine"|"company"="mine") => api.get<DeliveryWorkflowInbox>(base(c)+"/pending-actions?scope="+scope),
  forTask: (c:string,taskId:string) => api.get<DeliveryWorkflowTaskContext|null>(base(c)+"/for-task/"+encodeURIComponent(taskId)),
  plan: (c:string, input:DeliveryAutomaticPlanInput) => api.post<DeliveryAutomaticPlan>(base(c)+"/plan",input),
  savedPlan: (c: string, snapshotId: string) =>
    api.get<DeliverySavedAutomaticPlan | null>(base(c) + "/plan?snapshotId=" + encodeURIComponent(snapshotId)),
  initialPlan: (c: string, input: DeliveryAutomaticPlanInput) =>
    api.post<DeliverySavedAutomaticPlan>(base(c) + "/plan/initial", input),
  automaticStart: (c:string, input:DeliveryAutomaticStartInput) => api.post<DeliveryWorkflow>(base(c)+"/automatic-start",input),
  list: (c: string, snapshotId: string) =>
    api.get<DeliveryWorkflow[]>(
      base(c) + "?snapshotId=" + encodeURIComponent(snapshotId),
    ),
  seats: (c: string, snapshotId?: string, jiraKeys?: string[]) => api.get<WorkflowSeat[]>(base(c) + "/seats" + (snapshotId ? "?snapshotId="+encodeURIComponent(snapshotId)+(jiraKeys?"&jiraKeys="+encodeURIComponent(jiraKeys.join(",")):"") : "")),
  start: (c: string, config: DeliveryWorkflowConfig) =>
    api.post<DeliveryWorkflow>(base(c), config),
  review: (c: string, id: string, input: unknown) =>
    api.post(base(c) + `/${id}/review`, input),
  rework: (c: string, id: string, input: unknown) => api.post(base(c) + `/${id}/rework`, input),
  accept: (c: string, id: string, input: unknown) =>
    api.post(base(c) + `/${id}/accept`, input),
  answer: (c: string, id: string, input: unknown) =>
    api.post(base(c) + `/${id}/answer`, input),
  cancel: (c: string, id: string) => api.post(base(c) + `/${id}/cancel`, {}),
  retry: (c: string, id: string, taskId: string) =>
    api.post(base(c) + `/${id}/retry`, { taskId }),
  confirmStart: (c: string, id: string, input: unknown) =>
    api.post(base(c) + `/${id}/confirm-start`, input),
  retryAutomaticRepair: (c:string,id:string,expectedReceiptDigest:string) => api.post(base(c)+`/${id}/automatic-repair/recheck`,{expectedReceiptDigest}),
  repair: (c: string, id: string, input: DeliveryRepairConfig) =>
    api.post<DeliveryWorkflow>(base(c) + `/${id}/repair`, input),
};

export function deliveryPlanPreviewQuery(companyId: string, snapshotId: string) {
  return {
    queryKey: ["delivery-plan-preview", companyId, snapshotId] as const,
    queryFn: () => deliveryWorkflowApi.savedPlan(companyId, snapshotId),
  };
}
