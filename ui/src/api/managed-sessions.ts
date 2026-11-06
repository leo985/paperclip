import { api } from "./client";
import type { ManagedSession, ManagedSessionDetail, ManagedContent, SeatPeriodReport, SeatWorkSchedule } from "@paperclipai/shared";
export const managedSessionsApi={
  list:(companyId:string,taskId:string)=>api.get<ManagedSession[]>(`/companies/${companyId}/issues/${taskId}/managed-sessions`),
  detail:(companyId:string,id:string)=>api.get<ManagedSessionDetail>(`/companies/${companyId}/managed-sessions/${id}`),
  messages:(companyId:string,id:string,after=0)=>api.get<{items:ManagedContent[];next:number|null}>(`/companies/${companyId}/managed-sessions/${id}/messages?after=${after}`),
  body:(companyId:string,id:string,contentId:string,from=0)=>api.get<{parts:Array<{partIndex:number;data:string}>;next:number|null;revision:string}>(`/companies/${companyId}/managed-sessions/${id}/messages/${contentId}?from=${from}`),
  control:(companyId:string,id:string,action:string)=>api.post<{ok:boolean}>(`/companies/${companyId}/managed-sessions/${id}/control`,{action}),
  report:(companyId:string,period:string,date:string)=>api.get<SeatPeriodReport>(`/companies/${companyId}/managed-seat-report?period=${encodeURIComponent(period)}&date=${encodeURIComponent(date)}`),
  updateWorkSchedule:(companyId:string,schedule:SeatWorkSchedule)=>api.put<SeatWorkSchedule>(`/companies/${companyId}/managed-seat-report/work-schedule`,schedule),
};
