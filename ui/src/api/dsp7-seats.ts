import { api } from "./client";
export interface JiraDispatchRule {jiraBaseUrl:string;jiraPatConfigured?:boolean;credentials?:{token:string};enabled:boolean;intakePaused?:boolean;jiraAssignee:string;jiraProjectKey:string;projectId:string;workspaceId:string;readyStatuses:string[];issueTypes:string[];revision?:number;ownerUserId?:string}
export interface SeatRuntime { environmentId:string;claudeCommand:string;claudeVersion:string;claudeSettingsFile:string|null;configurationSource:"local-default"|"local-settings-file";harnessRoot:string;settingsDigest:string|null;revision:number;checkedAt:string }
export interface SeatCheck { id:string;label:string;status:"pass"|"fail"|"warn";message:string }
export interface SeatAlert { id:string;taskId:string|null;jiraKey:string;level:"info"|"warning"|"urgent";message:string;elapsedMinutes:number }
export interface SeatTask { taskId:string;jiraKey:string;status:string;mode:"replay"|"formal";automatic?:boolean;ready:boolean }
export interface SeatPolicy { mode:"manual"|"notify"|"auto";jiraKeys:string[];reminderMinutes:number;escalationMinutes:number;dingtalk?:{userId:string;profile?:string;botId?:string}|null }
export interface SeatPresence { checkedAt:string;lastSeenAt:string;revision:number|null;state:"idle"|"busy"|"waiting_decision"|"awaiting_local"|"config_error"|"error";activeTaskId:string|null;runId:string|null;checks:SeatCheck[];alerts:SeatAlert[];tasks:SeatTask[];autoPermit:{until:string;jiraKeys:string[]}|null }
export interface RegisteredSeat { isMine?:boolean;agentId:string;name:string;agentName:string;environmentName:string;runtime:SeatRuntime|null;usable:boolean;message:string;online:boolean;presence:SeatPresence|null;policy:SeatPolicy;dispatch?:JiraDispatchRule|null }
export interface SeatCommand { commandId:string;agentId:string;kind:"check"|"refresh"|"start";taskId:string|null;revision:number;requestedBy:string;expiresAt:string;createdAt:string;status:string;message:string;runId:string|null }
const base=(companyId:string,id:string)=>`/companies/${companyId}/dsp7-seats/${id}`;
export interface NotificationContact {externalId:string;corpId:string;name:string;organization:string;departments:string[];userId:string|null}
export interface JiraPreview {actorName:string;statuses:string[];verifiedAt:string;matches:{total:number;issues:Array<{key:string;summary:string;status:string}>}|null}
export interface SeatBot {id:string;name:string;corpId:string;appKey:string;robotCode:string;enabled:boolean;secretConfigured:boolean}
export const dsp7SeatsApi={
 bots:(companyId:string)=>api.get<SeatBot[]>(`/companies/${companyId}/dsp7-notification-bots`),
 saveBot:(companyId:string,id:string|undefined,value:Record<string,unknown>)=>api.post<SeatBot>(`/companies/${companyId}/dsp7-notification-bots${id?"/"+id:""}`,value),
 deliveries:(companyId:string,id:string)=>api.get<Array<{createdAt:string;status:string;code?:string}>>(`${base(companyId,id)}/notification-deliveries`),
 pauseIntake:(companyId:string,id:string,paused:boolean)=>api.post<JiraDispatchRule>(`${base(companyId,id)}/jira-dispatch/intake`,{paused}),
 contacts:(companyId:string,id:string)=>api.get<NotificationContact[]>(`${base(companyId,id)}/notification-contacts`),
 previewDispatch:(companyId:string,id:string,value:Partial<JiraDispatchRule>)=>api.post<JiraPreview>(`${base(companyId,id)}/jira-dispatch/preview`,value),
 dispatch:(companyId:string,id:string)=>api.get<JiraDispatchRule|null>(`${base(companyId,id)}/jira-dispatch`),
 saveDispatch:(companyId:string,id:string,value:JiraDispatchRule)=>api.post<JiraDispatchRule>(`${base(companyId,id)}/jira-dispatch`,value),
 quickInvite:(companyId:string,body:{requestId:string;name:string})=>api.post<{invitationId:string;token:string;expiresAt:string}>(`/companies/${companyId}/dsp7-quick-enrollments`,body),
 list:(companyId:string)=>api.get<RegisteredSeat[]>(`/companies/${companyId}/dsp7-seats`),
 verify:(companyId:string,seat:RegisteredSeat)=>api.post<{agentId:string;revision:number}>(`${base(companyId,seat.agentId)}/verify`,{revision:seat.runtime?.revision}),
 commands:(companyId:string,id:string)=>api.get<SeatCommand[]>(`${base(companyId,id)}/commands`),
 request:(companyId:string,seat:RegisteredSeat,kind:SeatCommand['kind'],taskId?:string,confirmNoOtherExecutor=false)=>api.post<SeatCommand>(`${base(companyId,seat.agentId)}/commands`,{requestId:crypto.randomUUID(),kind,revision:seat.runtime?.revision,...(taskId?{taskId}:{}),confirmNoOtherExecutor}),
 cancel:(companyId:string,id:string,commandId:string)=>api.post(`${base(companyId,id)}/commands/${commandId}/cancel`,{}),
 policy:(companyId:string,id:string,value:SeatPolicy)=>api.post<SeatPolicy>(`${base(companyId,id)}/policy`,value),
 invite:(companyId:string,body:Record<string,unknown>)=>api.post<Record<string,unknown>>(`/companies/${companyId}/dsp7-seat-enrollments`,body),
};
