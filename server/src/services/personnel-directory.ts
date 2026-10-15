/** Company directory import. Never changes existing credentials or administrator roles. */
import { initializePersonnelPasswords } from "../auth/personnel-passwords.js";
import { createHash, randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { authUsers, companyMemberships, principalPermissionGrants, personnelSources, personnelPeople, personnelDepartments, activityLog, type Db } from "@paperclipai/db";
import { secretService } from "./secrets.js";
import { conflict } from "../errors.js";
import { logger } from "../middleware/logger.js";
type Source = typeof personnelSources.$inferSelect;
type Person = { externalId:string; name:string; email:string|null; phone:string|null; departments:string[] };
type Department = { externalId:string; name:string; parentId:string|null };
async function directory(source:Source,secret:string) {
  const ding=source.type==="DingTalk";
  const base=ding?"https://oapi.dingtalk.com":"https://qyapi.weixin.qq.com/cgi-bin";
  async function call(path:string,params:Record<string,string>,body?:object):Promise<any> {
    const response=await fetch(base+path+"?"+new URLSearchParams(params),{method:body?"POST":"GET",...(body?{headers:{"Content-Type":"application/json"},body:JSON.stringify(body)}:{}),signal:AbortSignal.timeout(20000)});
    if(!response.ok)throw new Error("通讯录 HTTP "+response.status);
    const result=await response.json() as any;
    if(result.errcode!==0)throw new Error("通讯录错误码 "+String(result.errcode));
    return result;
  }
  const token=await call("/gettoken",ding?{appkey:source.appKey,appsecret:secret}:{corpid:source.corpId,corpsecret:secret});
  if(!token.access_token)throw new Error("通讯录缺少访问令牌");
  const params={access_token:String(token.access_token)};
  const people=new Map<string,Person>(), departments=new Map<string,Department>();
  const roots=source.syncScope.split(",").map(x=>x.trim()).filter(Boolean);
  let requests=0;
  async function walk(id:string) {
    if(departments.has(id))return;
    if(++requests>10000)throw new Error("通讯录超过同步上限");
    const data=await call(ding?"/department/get":"/department/get",{...params,id});
    const d=ding?data:(data.department||[]).find((v:any)=>String(v.id)===id);
    if(!d)throw new Error("通讯录部门不可见");
    departments.set(id,{externalId:id,name:String(d.name||id),parentId:d.parentid?String(d.parentid):null});
    let offset=0;
    while(true) {
      if(++requests>10000)throw new Error("通讯录超过同步上限");
      const page=await call(ding?"/user/listbypage":"/user/list",{...params,department_id:id,...(ding?{offset:String(offset),size:"100",order:"entry_asc"}:{fetch_child:"0"})});
      for(const u of page.userlist||[]) {
        const key=String(u.userid||"");if(!key)throw new Error("通讯录缺少人员标识");
        const old=people.get(key);
        if(old){if(!old.departments.includes(id))old.departments.push(id);continue;}
        people.set(key,{externalId:key,name:String(u.name||key),email:u.email?.trim()||null,phone:u.mobile?.trim()||null,departments:[id]});
      }
      if(!ding||page.hasMore!==true)break;
      if(!(page.userlist||[]).length)throw new Error("通讯录分页未前进");offset+=100;
    }
    const children=ding?(await call("/topapi/v2/department/listsub",params,{dept_id:Number(id),language:"zh_CN"})).result:(await call("/department/list",{...params,id})).department;
    for(const child of children||[]) {
      const cid=String(ding?child.dept_id:child.id);
      if(cid!==id&&(ding||String(child.parentid)===id))await walk(cid);
    }
  }
  for(const root of roots)await walk(root);
  return {people:[...people.values()],departments:[...departments.values()]};
}
export function personnelDirectoryService(db:Db) {
  async function sync(sourceId:string,actorId="scheduler") {
    const lease=new Date(Date.now()+15*60*1000);
    const [source]=await db.update(personnelSources).set({leaseUntil:lease}).where(and(eq(personnelSources.id,sourceId),eq(personnelSources.enabled,true),sql`(${personnelSources.leaseUntil} is null or ${personnelSources.leaseUntil} < now())`)).returning();
    if(!source)throw conflict("身份源已暂停或正在同步");
    try {
      if(!source.secretId)throw new Error("身份源缺少应用密钥");
      const secret=await secretService(db).resolveSecretValue(source.companyId,source.secretId,"latest");
      const snapshot=await directory(source,secret);
      const result=await db.transaction(async tx=>{
        const [current]=await tx.select().from(personnelSources).where(eq(personnelSources.id,source.id)).for("update");
        if(!current?.enabled||current.updatedAt.getTime()!==source.updatedAt.getTime())throw conflict("同步期间配置变化，请重新同步");
        let newUsers=0,updatedUsers=0,conflicts=0;
        const suffix=source.corpId.slice(-8),prefix=source.type==="DingTalk"?"dt":"wx";
        for(const person of snapshot.people) {
          const [old]=await tx.select().from(personnelPeople).where(and(eq(personnelPeople.sourceId,source.id),eq(personnelPeople.externalId,person.externalId)));
          const username=person.email||`${prefix}_${suffix}_${person.externalId}`;
          let userId=old?.userId||null, managedAccount=old?.managedAccount||false;
          // Email alone must not link identities or grant access to an existing administrator.
          if(!old&&person.email) {
            const [existing]=await tx.select().from(authUsers).where(eq(authUsers.email,person.email.toLowerCase()));
            if(existing)conflicts++;
            else {userId=randomUUID();managedAccount=true;}
          } else if(!old) {userId=randomUUID();managedAccount=true;}
          if(userId&&managedAccount) {
            const internalEmail="federated-"+createHash("sha256").update(source.companyId+":"+source.type+":"+source.corpId+":"+person.externalId).digest("hex")+"@paperclip.invalid";
            if(!old)await tx.insert(authUsers).values({id:userId,name:person.name,email:internalEmail,emailVerified:false,createdAt:new Date(),updatedAt:new Date()});
            else await tx.update(authUsers).set({name:person.name,updatedAt:new Date()}).where(eq(authUsers.id,userId));
            const inserted=await tx.insert(companyMemberships).values({companyId:source.companyId,principalType:"user",principalId:userId,membershipRole:"operator",status:"active"}).onConflictDoNothing().returning();
            if(inserted.length)await tx.insert(principalPermissionGrants).values({companyId:source.companyId,principalType:"user",principalId:userId,permissionKey:"tasks:assign"}).onConflictDoNothing();
          }
          const fields={name:person.name,email:person.email,phone:person.phone,departmentIds:person.departments,userId,managedAccount,active:true,lastSyncedAt:new Date()};
          if(old){await tx.update(personnelPeople).set(fields).where(eq(personnelPeople.id,old.id));updatedUsers++;}
          else {await tx.insert(personnelPeople).values({...fields,sourceId:source.id,companyId:source.companyId,externalId:person.externalId,username});newUsers++;}
        }
        for(const dept of snapshot.departments)await tx.insert(personnelDepartments).values({...dept,sourceId:source.id,companyId:source.companyId}).onConflictDoUpdate({target:[personnelDepartments.sourceId,personnelDepartments.externalId],set:{name:dept.name,parentId:dept.parentId,active:true}});
        // Absence can mean a changed app scope; flag it without deleting accounts, sessions or seats.
        const present=snapshot.people.map(p=>p.externalId);
        const existing=await tx.select().from(personnelPeople).where(eq(personnelPeople.sourceId,source.id));
        const removed=existing.filter(p=>!present.includes(p.externalId));
        for(const p of removed)await tx.update(personnelPeople).set({active:false,activationHash:null,activationExpires:null}).where(eq(personnelPeople.id,p.id));
        const deptIds=new Set(snapshot.departments.map(d=>d.externalId));
        for(const d of await tx.select().from(personnelDepartments).where(eq(personnelDepartments.sourceId,source.id)))if(!deptIds.has(d.externalId))await tx.update(personnelDepartments).set({active:false}).where(eq(personnelDepartments.id,d.id));
        const result={syncTime:new Date().toISOString(),syncUserCount:snapshot.people.length,departmentCount:snapshot.departments.length,newUsers,updatedUsers,conflicts,missingPeople:removed.length};
        await tx.update(personnelSources).set({lastSyncAt:new Date(),lastResult:result,leaseUntil:null}).where(eq(personnelSources.id,source.id));
        await tx.insert(activityLog).values({companyId:source.companyId,actorType:actorId==="scheduler"?"system":"user",actorId,action:"personnel.federation.synced",entityType:"personnel_source",entityId:source.id,details:result});
        return result;
      });await initializePersonnelPasswords(db,source.id,actorId);return result;
    } catch(error) {
      // External response bodies and token URLs must never reach logs or the board.
      const code=error instanceof Error && /^通讯录(?: HTTP \d+|错误码 \d+)$/.test(error.message)?error.message:null;
      await db.update(personnelSources).set({leaseUntil:null,lastResult:{error:"同步失败，请核对应用凭证、通讯录权限和部门范围",...(code?{code}:{}),failedAt:new Date().toISOString()}}).where(eq(personnelSources.id,source.id));
      throw conflict("同步失败，请核对应用凭证、通讯录权限和部门范围");
    }
  }
  let busy=false;
  let inFlight:Promise<void>|null=null;
  async function tick() {
    if(busy)return;busy=true;
    try {for(const s of await db.select().from(personnelSources).where(and(eq(personnelSources.enabled,true),eq(personnelSources.autoSync,true))))if(!s.lastSyncAt||Date.now()-s.lastSyncAt.getTime()>s.syncInterval*1000)try{await sync(s.id);}catch{logger.warn({sourceId:s.id},"Personnel directory sync did not complete");}}
    catch{logger.warn("Personnel directory scheduler unavailable");}finally{busy=false;}
  }
  return {sync,tick:()=>{if(!inFlight)inFlight=tick().finally(()=>{inFlight=null;});return inFlight;},drain:()=>inFlight||Promise.resolve()};
}
