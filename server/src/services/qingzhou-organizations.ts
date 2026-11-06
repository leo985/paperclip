import type { DeliverySourceOrganization, DeliverySourceOrganizations } from "@paperclipai/shared";
import { qingzhouClient, QingzhouReadError } from "./qingzhou-client.js";

export async function readQingzhouOrganizations(input: {credentials: () => Promise<{username:string;password:string}>}, fetcher: typeof fetch = fetch): Promise<DeliverySourceOrganizations> {
  const client=qingzhouClient({credentials:input.credentials,fetch:fetcher});
  const result=new Map<string,DeliverySourceOrganization>();
  for (const kind of ["researchGroup","testGroup"] as const) {
    const response=await client.organizations(kind);
    const rows=response.data.rows??response.data.data??response.data.value;
    if (!Array.isArray(rows) || rows.length>5000 || (response.data.total!==undefined && (!Number.isSafeInteger(Number(response.data.total)) || Number(response.data.total)!==rows.length))) throw new QingzhouReadError("incomplete_response");
    for (const row of rows) {
      if (!row || typeof row!=="object") throw new QingzhouReadError("invalid_response");
      if (row.deleted===1||row.deleted==="1") continue;
      const id=typeof row.urid==="number"&&Number.isSafeInteger(row.urid)?String(row.urid):row.urid;
      if (typeof id!=="string"||!/^\d{1,30}$/.test(id)||typeof row.orgName!=="string"||!row.orgName.trim()||row.orgName.length>500) throw new QingzhouReadError("invalid_response");
      const code=typeof row.orgCode==="string"?row.orgCode.slice(0,200):"";
      const previous=result.get(id);
      if (previous && (previous.name!==row.orgName || previous.code!==code)) throw new QingzhouReadError("invalid_response");
      if(previous)previous.kinds.push(kind);else result.set(id,{id,name:row.orgName,code,kinds:[kind]});
    }
  }
  return {items:[...result.values()].sort((a,b)=>a.name.localeCompare(b.name,"zh-CN")||a.id.localeCompare(b.id)),collectedAt:new Date().toISOString()};
}
