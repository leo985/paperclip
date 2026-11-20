import { api } from "./client";
import type { DeliveryPlan, DeliveryJiraReviewResults, DeliverySnapshot, DeliverySnapshotInput, DeliverySnapshotComparison, DeliveryEntryList, DeliveryEntryDetail } from "@paperclipai/shared";
export const deliveryIntakeApi = {
  entries:(companyId:string,query:URLSearchParams)=>api.get<DeliveryEntryList>(`/companies/${companyId}/delivery-intake/entries?${query}`),
  entry:(companyId:string,snapshotId:string)=>api.get<DeliveryEntryDetail>(`/companies/${companyId}/delivery-intake/entries/${snapshotId}`),
  jiraReviewResults: (companyId: string, snapshotId: string) =>
    api.get<DeliveryJiraReviewResults>(`/companies/${companyId}/delivery-intake/entries/${snapshotId}?jiraReviewResults=1`),
  note:(companyId:string,snapshotId:string,baselineId:string,note:string)=>api.post<{recorded:true;executionAllowed:false;formalApproval:false}>(`/companies/${companyId}/delivery-intake/${snapshotId}/comparison-note`,{baselineId,note}),
  compare:(companyId:string,snapshotId:string,baselineId:string)=>api.get<DeliverySnapshotComparison>(`/companies/${companyId}/delivery-intake/${snapshotId}/compare?baselineId=${baselineId}`),
  list:(companyId:string,projectId:string,page:number,demandNo?:string)=>api.get<{items:DeliverySnapshot[];hasMore:boolean}>(`/companies/${companyId}/delivery-intake?projectId=${projectId}&page=${page}${demandNo?`&demandNo=${encodeURIComponent(demandNo)}`:""}`),
  preview:(companyId:string,input:DeliverySnapshotInput)=>api.post<DeliveryPlan>(`/companies/${companyId}/delivery-intake/preview`,input),
  save:(companyId:string,input:DeliverySnapshotInput,fingerprint:string)=>api.post<{snapshot:DeliverySnapshot;existing:boolean}>(`/companies/${companyId}/delivery-intake/import`,{...input,fingerprint}),
};
