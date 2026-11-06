import { api } from "./client";
import type { SeatUpgradeRequest, SeatLaunchOptions, SeatDingtalkTarget, SeatNotificationGroup } from "@paperclipai/shared";
export interface JiraDispatchRule {jiraBaseUrl:string;jiraPatConfigured?:boolean;credentials?:{token:string};enabled:boolean;intakePaused?:boolean;jiraAssignee:string;jiraProjectKey:string;projectId:string;workspaceId?:string;readyStatuses:string[];issueTypes:string[];revision?:number;ownerUserId?:string}
export interface JiraIntakeSnapshot {jiraKey:string;summary:string;status:string;issueType:string;assignee:string|null;assigneeName:string|null;jiraUpdatedAt:string|null;checkedAt:string;eligible:boolean;reasons:string[];ruleRevision:number}
export interface SeatRuntime { environmentId:string;claudeCommand:string;claudeVersion:string;claudeSettingsFile:string|null;configurationSource:"local-default"|"local-settings-file";harnessRoot:string;settingsDigest:string|null;revision:number;checkedAt:string }
export interface SeatCheck { id:string;label:string;status:"pass"|"fail"|"warn";message:string }
export interface SeatAlert { id:string;taskId:string|null;jiraKey:string;level:"info"|"warning"|"urgent";message:string;elapsedMinutes:number }
export interface SeatTask { taskId:string;jiraKey:string;status:string;mode:"replay"|"formal";automatic?:boolean;stoppedRunId?:string;stopRequestedRunId?:string;ready:boolean }
export interface SeatPolicy { mode:"manual"|"notify"|"auto";jiraKeys:string[];reminderMinutes:number;escalationMinutes:number;dingtalk?:SeatDingtalkTarget|null }
export interface SeatPresence {activeRuns?:Array<{taskId:string;runId:string;state:"busy"|"waiting_decision"}>; acceptingWork?:boolean; bridgeVersion?:string|null; capabilities?:string[];checkedAt:string;lastSeenAt:string;revision:number|null;state:"idle"|"busy"|"waiting_decision"|"awaiting_local"|"config_error"|"error";activeTaskId:string|null;runId:string|null;checks:SeatCheck[];alerts:SeatAlert[];tasks:SeatTask[];autoPermit:{until:string;jiraKeys:string[]}|null }
export interface SeatOwner {id:string;name:string;email:string}
export interface RegisteredSeat {maxConcurrentRuns?:number;launchOptions?:SeatLaunchOptions;executionTransport?:"ssh"|"outbound";migrationState?:string|null;owner:SeatOwner|null;canConfigure:boolean; isMine?:boolean;agentId:string;name:string;agentName:string;environmentName:string;runtime:SeatRuntime|null;usable:boolean;message:string;online:boolean;presence:SeatPresence|null;policy:SeatPolicy;dispatch?:JiraDispatchRule|null }
export interface SeatCommand { commandId:string;agentId:string;kind:"check"|"refresh"|"start";taskId:string|null;revision:number;requestedBy:string;expiresAt:string;createdAt:string;status:string;message:string;runId:string|null }
const base=(companyId:string,id:string)=>`/companies/${companyId}/dsp7-seats/${id}`;
export interface NotificationContact {externalId:string;corpId:string;name:string;organization:string;departments:string[];userId:string|null}
export interface SeatStartupProgress {stage:string;startedAt:string;elapsedSeconds:number;steps:Array<{stage:string;at:string;elapsedSeconds:number}>}
export interface PlatformDispatchStatus {startup?:SeatStartupProgress|null;taskId:string;phase:string;message?:string|null;canResume?:boolean;resumeBlockedReason?:string|null;authorized:boolean;authorizationId:string|null}
export interface JiraIntakePreview {jiraKey:string;status:string;issueType:string;summary:string;readyStatuses:string[];revision:number}
export interface JiraPreview {actorName:string;statuses:string[];verifiedAt:string;matches:{total:number;issues:Array<{key:string;summary:string;status:string}>}|null}
export interface SeatBot {id:string;name:string;corpId:string;appKey:string;robotCode:string;enabled:boolean;secretConfigured:boolean}
function upgradeRequestId() {
 const bytes=crypto.getRandomValues(new Uint8Array(16)); bytes[6]=(bytes[6]&15)|64; bytes[8]=(bytes[8]&63)|128;
 const hex=Array.from(bytes,b=>b.toString(16).padStart(2,"0")).join("");
 return [hex.slice(0,8),hex.slice(8,12),hex.slice(12,16),hex.slice(16,20),hex.slice(20)].join("-");
}
export const dsp7SeatsApi={
 saveConcurrency:(companyId:string,id:string,maxConcurrentRuns:number)=>api.put<{maxConcurrentRuns:number}>(`${base(companyId,id)}/concurrency`,{maxConcurrentRuns}),
 upgradeStatus:(companyId:string,id:string)=>api.get<SeatUpgradeRequest|null>(`${base(companyId,id)}/client-upgrade`),
 requestUpgrade:(companyId:string,id:string,targetSha256:string)=>api.post<SeatUpgradeRequest>(`${base(companyId,id)}/client-upgrade`,{requestId:upgradeRequestId(),targetSha256}),
 cancelUpgrade:(companyId:string,id:string,requestId:string,targetSha256:string)=>api.post<SeatUpgradeRequest>(`${base(companyId,id)}/client-upgrade/cancel`,{requestId,targetSha256}),
 saveLaunchOptions:(companyId:string,id:string,extraArgs:string[])=>api.put<SeatLaunchOptions>(`${base(companyId,id)}/launch-options`,{extraArgs}),
 groups:(companyId:string)=>api.get<SeatNotificationGroup[]>(`/companies/${companyId}/dsp7-notification-groups`),
 saveGroup:(companyId:string,id:string|undefined,value:Record<string,unknown>)=>api.post<SeatNotificationGroup>(`/companies/${companyId}/dsp7-notification-groups${id?"/"+id:""}`,value),
 remove:(companyId:string,id:string)=>api.delete<{ok:true}>(base(companyId,id)),
 syncIntake:(companyId:string,id:string,taskId:string)=>api.post<JiraIntakeSnapshot>(`${base(companyId,id)}/jira-intake/${taskId}/sync`,{}),
 ownerCandidates:(companyId:string)=>api.get<SeatOwner[]>(`/companies/${companyId}/dsp7-seat-owner-candidates`),
 assignOwner:(companyId:string,id:string,userId:string)=>api.patch<{agentId:string;owner:SeatOwner;dispatchReset:boolean}>(`${base(companyId,id)}/owner`,{userId}),
 rename:(companyId:string,id:string,name:string)=>api.patch<{agentId:string;name:string}>(`${base(companyId,id)}/name`,{name}),
 bots:(companyId:string)=>api.get<SeatBot[]>(`/companies/${companyId}/dsp7-notification-bots`),
 saveBot:(companyId:string,id:string|undefined,value:Record<string,unknown>)=>api.post<SeatBot>(`/companies/${companyId}/dsp7-notification-bots${id?"/"+id:""}`,value),
 deliveries:(companyId:string,id:string)=>api.get<Array<{createdAt:string;status:string;code?:string;channel?:"message"|"ding"|"group";groupId?:string;groupName?:string;mentionedUserId?:string;openDingId?:string}>>(`${base(companyId,id)}/notification-deliveries`),
 pauseIntake:(companyId:string,id:string,paused:boolean)=>api.post<JiraDispatchRule>(`${base(companyId,id)}/jira-dispatch/intake`,{paused}),
 contacts:(companyId:string,id:string)=>api.get<NotificationContact[]>(`${base(companyId,id)}/notification-contacts`),
 platformDispatch:(companyId:string,id:string,taskId:string,action:"authorize"|"cancel"|"resume"="authorize")=>api.post<{taskId:string;state:string;authorizationId:string}>(`${base(companyId,id)}/platform-dispatch`,{taskId,action}),
 dispatchStatus:(companyId:string,id:string,taskId:string)=>api.get<PlatformDispatchStatus>(`${base(companyId,id)}/platform-dispatch/${taskId}`),
 previewIntake:(companyId:string,id:string,value:{jiraKey:string;projectId:string;workspaceId?:string})=>api.post<JiraIntakePreview>(`${base(companyId,id)}/jira-dispatch/intake-preview`,value),
 previewDispatch:(companyId:string,id:string,value:Partial<JiraDispatchRule>)=>api.post<JiraPreview>(`${base(companyId,id)}/jira-dispatch/preview`,value),
 dispatch:(companyId:string,id:string)=>api.get<JiraDispatchRule|null>(`${base(companyId,id)}/jira-dispatch`),
 saveDispatch:(companyId:string,id:string,value:JiraDispatchRule)=>api.post<JiraDispatchRule>(`${base(companyId,id)}/jira-dispatch`,value),
 quickInvite:(companyId:string,body:{requestId:string;name:string;ownerUserId:string})=>api.post<{invitationId:string;token:string;expiresAt:string}>(`/companies/${companyId}/dsp7-quick-enrollments`,body),
 list:(companyId:string)=>api.get<RegisteredSeat[]>(`/companies/${companyId}/dsp7-seats`),
 verify:(companyId:string,seat:RegisteredSeat)=>api.post<{agentId:string;revision:number}>(`${base(companyId,seat.agentId)}/verify`,{revision:seat.runtime?.revision}),
 commands:(companyId:string,id:string)=>api.get<SeatCommand[]>(`${base(companyId,id)}/commands`),
 request:(companyId:string,seat:RegisteredSeat,kind:SeatCommand['kind'],taskId?:string,confirmNoOtherExecutor=false)=>api.post<SeatCommand>(`${base(companyId,seat.agentId)}/commands`,{requestId:crypto.randomUUID(),kind,revision:seat.runtime?.revision,...(taskId?{taskId}:{}),confirmNoOtherExecutor}),
 cancel:(companyId:string,id:string,commandId:string)=>api.post(`${base(companyId,id)}/commands/${commandId}/cancel`,{}),
 policy:(companyId:string,id:string,value:SeatPolicy)=>api.post<SeatPolicy>(`${base(companyId,id)}/policy`,value),
 invite:(companyId:string,body:Record<string,unknown>)=>api.post<Record<string,unknown>>(`/companies/${companyId}/dsp7-seat-enrollments`,body),
};
