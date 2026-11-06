import { and, eq } from "drizzle-orm";
import { agents, deliveryConnections, type Db } from "@paperclipai/db";
import { conflict } from "../errors.js";
import { secretService } from "./secrets.js";
import { seatOwnerId } from "../routes/dsp7-seat-owners.js";
import { resolveHarnessRoute } from "./harness-execution-routing.js";

type Seat = typeof agents.$inferSelect;
export interface DeliveryJiraAssignment { account: string; displayName: string; origin: string }
/** Fetch current Jira identities, never infer an account from a display name. */
export async function readDeliveryJiraAssignments(db: Db, companyId: string, projectId: string, keys: string[]): Promise<Map<string, DeliveryJiraAssignment>> {
  const result = new Map<string, DeliveryJiraAssignment>();
  if (!keys.length) return result;
  if (keys.length > 1000 || keys.some(key => !/^[A-Z][A-Z0-9_]*-\d+$/.test(key))) throw conflict("工单查询范围无效");
  const [connection] = await db.select().from(deliveryConnections).where(and(eq(deliveryConnections.companyId,companyId),eq(deliveryConnections.projectId,projectId)));
  if (!connection) throw conflict("请先配置项目 Jira 来源");
  let baseUrl=connection.jiraBaseUrl, secretId=connection.jiraSecretId;
  if (!secretId && connection.jiraAgentId) {
    const [legacy]=await db.select().from(agents).where(and(eq(agents.companyId,companyId),eq(agents.id,connection.jiraAgentId)));
    const rule=legacy?.adapterConfig.dsp7JiraDispatch as {projectId?:string;jiraBaseUrl?:string;jiraSecretId?:string}|undefined;
    if (rule?.projectId===projectId) {baseUrl=rule.jiraBaseUrl??null;secretId=rule.jiraSecretId??null;}
  }
  if (!baseUrl || !secretId) throw conflict("项目 Jira 来源尚未配置完整");
  const origin=new URL(baseUrl).origin;
  if (!(process.env.PAPERCLIP_JIRA_ALLOWED_ORIGINS??"http://jira.fingard.com:6001").split(",").map(v=>v.trim()).includes(origin)) throw conflict("Jira 来源地址不受信任");
  const token=await secretService(db).resolveSecretValue(companyId,secretId,"latest");
  const unique=[...new Set(keys)];
  for (let offset=0;offset<unique.length;offset+=50) {
    const batch=unique.slice(offset,offset+50),url=new URL('/rest/api/2/search',origin);
    url.search=new URLSearchParams({jql:`key in (${batch.map(k=>'"'+k+'"').join(',')}) ORDER BY key ASC`,fields:'assignee',maxResults:'50',startAt:'0'}).toString();
    let reply:Response;try{reply=await fetch(url,{headers:{Authorization:'Bearer '+token,Accept:'application/json'},redirect:'error',signal:AbortSignal.timeout(15000)});}catch{throw conflict("无法读取 Jira 经办人，请稍后重试");}
    if(!reply.ok)throw conflict("读取 Jira 经办人失败，请核对项目连接与权限");
    const page=await reply.json() as {total:number;startAt:number;issues:Array<{key:string;fields:{assignee:{name?:string;accountId?:string;displayName?:string}|null}}>};
    if(!Array.isArray(page.issues)||page.startAt!==0||page.total!==batch.length||page.issues.length!==batch.length||new Set(page.issues.map(i=>i.key)).size!==batch.length||page.issues.some(i=>!batch.includes(i.key)))throw conflict("Jira 工单经办人未完整返回，请核对工单访问权限");
    for(const row of page.issues)result.set(row.key,{account:row.fields.assignee?.name??row.fields.assignee?.accountId??'',displayName:row.fields.assignee?.displayName??'',origin});
  }
  return result;
}
export function deliverySeatMatchesAssignee(seat: Seat, projectId:string, assignment:DeliveryJiraAssignment) {
  const rule=seat.adapterConfig.dsp7JiraDispatch as {projectId?:string;jiraBaseUrl?:string;jiraAssignee?:string;enabled?:boolean;intakePaused?:boolean}|undefined;
  let origin:string;try{origin=new URL(rule?.jiraBaseUrl??'').origin;}catch{return false;}
  return !!assignment.account && seat.adapterConfig.dsp7Transport==='outbound' && !!seatOwnerId(seat.adapterConfig.dsp7Seat as Record<string,unknown>) && !['paused','terminated','pending_approval'].includes(seat.status) && rule?.enabled===true && !rule.intakePaused && rule.projectId===projectId && origin===assignment.origin && rule.jiraAssignee===assignment.account;
}
export function chooseDeliverySeat(candidates: Seat[], selected:string|undefined, key:string) {
  if(selected){if(!candidates.some(s=>s.id===selected))throw conflict(key+" 所选席位不属于当前 Jira 经办人或不具备执行能力");return selected;}
  if(candidates.length===1)return candidates[0].id;
  throw conflict(candidates.length ? key+" 的经办人有多个可用席位，请选择其中一个" : key+" 的 Jira 经办人未配置具备所需能力的席位，请先配置");
}
export function deliverySeatCandidates(seats:Seat[],projectId:string,assignment:DeliveryJiraAssignment,kind:'analysis'|'development'|'qa',role:string) {
  return seats.filter(seat=>{
    if(!deliverySeatMatchesAssignee(seat,projectId,assignment))return false;
    try{return !!resolveHarnessRoute(seat,{runId:seat.id,taskId:seat.id,kind,required:true})?.capability.roles.some(value=>value===role);}catch{return false;}
  });
}
