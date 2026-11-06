import { api } from "./client";
import type { DeliveryInsights, DeliveryAcceptance } from "@paperclipai/shared";
export const deliveryInsightsApi={
  report:(companyId:string,query:URLSearchParams)=>api.get<DeliveryInsights>(`/companies/${companyId}/delivery-insights?${query}`),
  acceptance:(companyId:string,projectId:string,page:number)=>api.get<{items:DeliveryAcceptance[];hasMore:boolean}>(`/companies/${companyId}/delivery-insights/acceptance?projectId=${encodeURIComponent(projectId)}&page=${page}`),
};
