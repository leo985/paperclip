import { Router } from "express";
import { createHash, randomBytes } from "node:crypto";
import { and, eq, sql, inArray, gt, isNotNull } from "drizzle-orm";
import { z } from "zod";
import { activityLog, companies, authUsers, authAccounts, authSessions, personnelSources, personnelPeople, personnelDepartments, companyMemberships, principalPermissionGrants, type Db } from "@paperclipai/db";
import { assertCompanyAccess, assertInstanceAdmin } from "./authz.js";
import { badRequest, conflict, notFound } from "../errors.js";
import { secretService } from "../services/secrets.js";
import { personnelDirectoryService } from "../services/personnel-directory.js";
import { personnelSourceInputSchema as schema, personnelMembershipInputSchema, personnelAccountRelinkInputSchema } from "@paperclipai/shared";
function publicSource(s:typeof personnelSources.$inferSelect){const {secretId,leaseUntil,...data}=s;return {...data,secretConfigured:!!secretId,syncing:!!leaseUntil&&leaseUntil>new Date()};}
export function personnelFederationRoutes(db:Db) {
 const router=Router(),service=personnelDirectoryService(db);
 router.use("/companies/:companyId/personnel-federation",(req,_res,next)=>{assertInstanceAdmin(req);assertCompanyAccess(req,String(req.params.companyId));next();});
 router.use("/instance/personnel-federation",(req,_res,next)=>{assertInstanceAdmin(req);next();});
 async function source(id:string){const [s]=await db.select().from(personnelSources).where(eq(personnelSources.id,id));if(!s)throw notFound("身份源不存在");return s;}
 for(const base of ["/instance/personnel-federation","/companies/:companyId/personnel-federation"]){
 router.get(base,async(req,res)=>{
  const sources=await db.select().from(personnelSources);
  const people=await db.select().from(personnelPeople);
  const passwords=await db.select({userId:authAccounts.userId}).from(authAccounts).where(and(eq(authAccounts.providerId,"credential"),isNotNull(authAccounts.password)));
  const passwordUsers=new Set(passwords.map(p=>p.userId));
  const existingAccounts=passwordUsers.size?await db.select({id:authUsers.id,name:authUsers.name,email:authUsers.email}).from(authUsers).where(inArray(authUsers.id,[...passwordUsers])):[];
  res.setHeader("Cache-Control","no-store");res.json({sources:sources.map(publicSource),existingAccounts,departments:await db.select().from(personnelDepartments),people:people.map(p=>{const {activationHash,activationExpires,...data}=p;return {...data,loginConfigured:!!p.userId&&passwordUsers.has(p.userId)};})});
 });
 router.post(base,async(req,res)=>{
  const parsed=schema.safeParse(req.body);if(!parsed.success)throw badRequest("请填写身份源、应用和有效的部门范围");
  const {credentials,id,auditCompanyId,...data}=parsed.data;
  if(data.type==="DingTalk"&&!data.appKey)throw badRequest("钉钉需要 AppKey");
  const result=await db.transaction(async tx=>{
   await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${"instance:personnel-sources"},0))`);
   const matches=await tx.select().from(personnelSources).where(and(eq(personnelSources.type,data.type),eq(personnelSources.corpId,data.corpId))).for("update");
   const [old]=id?await tx.select().from(personnelSources).where(eq(personnelSources.id,id)).for("update"):[];
   if(id&&!old)throw notFound("身份源不存在");
   if(old&&(old.type!==data.type||old.corpId!==data.corpId))throw conflict("已有身份源不能更换企业或平台，请新增身份源");
   if(matches.some(s=>s.id!==id)&&(!old||old.type!==data.type||old.corpId!==data.corpId))throw conflict("该企业已有系统级身份源，请编辑已有配置；历史重复配置请先停用并保持原企业标识");
   // Retain the original vault/audit context; this does not scope the shared directory.
   const companyId=old?.companyId??auditCompanyId??req.params.companyId;
   if(!companyId)throw badRequest("首次配置请选择用于记录操作的组织");
   if(!old)assertCompanyAccess(req,companyId);
   if(old?.leaseUntil&&old.leaseUntil>new Date())throw conflict("同步进行中，请稍后保存配置");
   let secretId=old?.secretId;
   if(credentials){const svc=secretService(tx);if(secretId)await svc.rotate(secretId,{value:credentials.secret},{userId:req.actor.userId});else secretId=(await svc.create(companyId,{name:"人员联邦 "+data.type+" "+data.corpId,provider:"local_encrypted",value:credentials.secret},{userId:req.actor.userId})).id;}
   if(!secretId)throw badRequest("首次配置需要应用密钥");
   const [s]=old?await tx.update(personnelSources).set({...data,secretId,updatedAt:new Date()}).where(eq(personnelSources.id,old.id)).returning():await tx.insert(personnelSources).values({...data,companyId,secretId}).returning();
   await tx.insert(activityLog).values({companyId,actorType:"user",actorId:req.actor.userId!,action:"personnel.federation.configured",entityType:"personnel_source",entityId:s.id,details:{...data,secretConfigured:true}});return s;
  });res.json(publicSource(result));
 });
 router.post(base+"/:id/sync",async(req,res)=>{const s=await source(String(req.params.id));res.json(await service.sync(s.id,req.actor.userId!));});
 router.post(base+"/people/:id/activation",async(req,res)=>{
  const [p]=await db.select().from(personnelPeople).where(eq(personnelPeople.id,String(req.params.id)));
  if(!p?.active||!p.userId||!p.managedAccount)throw conflict("只能为有效的联邦新账号生成激活链接；已有账号请用原登录方式");
  const companyId=p.companyId;
  const s=await source(p.sourceId);if(!s.enabled)throw conflict("身份源已暂停");
  const token=randomBytes(32).toString("hex"),expiresAt=new Date(Date.now()+24*60*60*1000);
  const [password]=await db.select().from(authAccounts).where(and(eq(authAccounts.userId,p.userId),eq(authAccounts.providerId,"credential")));
  if(password?.password)throw conflict("账号已激活，不能通过联邦入口重置已有密码");
  await db.update(personnelPeople).set({activationHash:createHash("sha256").update(token).digest("hex"),activationExpires:expiresAt}).where(eq(personnelPeople.id,p.id));
  await db.insert(activityLog).values({companyId,actorType:"user",actorId:req.actor.userId!,action:"personnel.activation.issued",entityType:"user",entityId:p.userId,details:{personId:p.id,expiresAt:expiresAt.toISOString()}});
  res.setHeader("Cache-Control","no-store");res.json({path:"/auth#activate="+token,expiresAt,username:p.username});
 });
 router.post(base+"/people/:id/link",async(req,res)=>{
  const body=z.object({userId:z.string().min(1),confirm:z.literal(true)}).strict().safeParse(req.body);if(!body.success)throw badRequest("请明确确认关联已有用户");
  await db.transaction(async tx=>{
   await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${"instance:personnel-account-links"},0))`);
   const [p]=await tx.select().from(personnelPeople).where(eq(personnelPeople.id,String(req.params.id))).for("update");
   if(!p?.active||p.userId&&!p.managedAccount)throw conflict("仅允许关联未激活的联邦新账号或尚未绑定人员");
   const companyId=p.companyId;
   if(p.userId){
    const credentials=await tx.select().from(authAccounts).where(eq(authAccounts.userId,p.userId));
    const sessions=await tx.select().from(authSessions).where(eq(authSessions.userId,p.userId));
    if(credentials.length||sessions.length)throw conflict("账号已激活或使用，不能替换关联");
   }
   const [user]=await tx.select().from(authUsers).where(eq(authUsers.id,body.data.userId));if(!user)throw notFound("网站用户不存在");
   if(user.id===p.userId)throw badRequest("请选择原网站账号，不能关联当前未激活的新账号");
   const targetAccounts=await tx.select().from(authAccounts).where(eq(authAccounts.userId,user.id));
   if(!targetAccounts.length)throw conflict("原网站账号尚未配置登录，请先核对账号");
   if(p.userId&&p.userId!==user.id){
    const memberships=await tx.select().from(companyMemberships).where(and(eq(companyMemberships.principalId,p.userId),eq(companyMemberships.principalType,"user")));
    if(memberships.length)throw conflict("原账号仍有关联组织，请先核对组织成员关系，不能直接替换身份");
   }
   await tx.update(personnelPeople).set({userId:user.id,managedAccount:false,activationHash:null,activationExpires:null}).where(eq(personnelPeople.id,p.id));
   await tx.insert(activityLog).values({companyId,actorType:"user",actorId:req.actor.userId!,action:"personnel.account.linked",entityType:"user",entityId:user.id,details:{personId:p.id}});
  });res.json({ok:true});
 });
 // Relinking repairs a generated duplicate account; it never merges users or transfers access.
 router.post(base+"/people/:id/relink",async(req,res)=>{
  const body=personnelAccountRelinkInputSchema.safeParse(req.body);
  if(!body.success)throw badRequest("请选择目标账号、填写核对原因，并明确确认重新关联");
  await db.transaction(async tx=>{
   await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${"instance:personnel-account-links"},0))`);
   const [initial]=await tx.select().from(personnelPeople).where(eq(personnelPeople.id,String(req.params.id)));
   if(!initial)throw notFound("人员不存在");
   // Lock in the same order as directory sync so a snapshot cannot restore the old binding.
   const [s]=await tx.select().from(personnelSources).where(eq(personnelSources.id,initial.sourceId)).for("update");
   if(!s?.enabled)throw conflict("身份源已暂停");
   if(s.leaseUntil&&s.leaseUntil>new Date())throw conflict("通讯录正在同步，请同步完成后重试");
   const [p]=await tx.select().from(personnelPeople).where(eq(personnelPeople.id,initial.id)).for("update");
   if(!p?.active||!p.userId||!p.managedAccount)throw conflict("只允许重新关联有效人员的系统生成账号；已有人工关联不能直接替换");
   if(p.userId!==body.data.expectedUserId)throw conflict("账号关联已变化，请刷新页面重新核对");
   if(p.userId===body.data.userId)throw badRequest("请选择与当前账号不同的原网站账号");
   assertCompanyAccess(req,p.companyId);
   const sessions=await tx.select({id:authSessions.id}).from(authSessions).where(and(eq(authSessions.userId,p.userId),gt(authSessions.expiresAt,new Date())));
   if(sessions.length)throw conflict("当前生成账号仍有有效登录会话，请先退出该账号或由管理员撤销会话后重试");
   const [user]=await tx.select().from(authUsers).where(eq(authUsers.id,body.data.userId)).for("update");
   if(!user)throw notFound("目标网站账号不存在");
   const targetAccounts=await tx.select({id:authAccounts.id}).from(authAccounts).where(and(eq(authAccounts.userId,user.id),eq(authAccounts.providerId,"credential"),isNotNull(authAccounts.password)));
   if(!targetAccounts.length)throw conflict("目标网站账号尚未配置登录");
   const sources=await tx.select({id:personnelSources.id}).from(personnelSources).where(and(eq(personnelSources.type,s.type),eq(personnelSources.corpId,s.corpId)));
   const linked=await tx.select({id:personnelPeople.id}).from(personnelPeople).where(and(eq(personnelPeople.userId,user.id),inArray(personnelPeople.sourceId,sources.map(source=>source.id)),eq(personnelPeople.active,true)));
   if(linked.length)throw conflict("目标账号已关联该企业的其他有效人员，请先核对，不能重复关联");
   // Retire the generated password login; keep its user, history, seats and grants intact.
   await tx.update(authAccounts).set({password:null,updatedAt:new Date()}).where(and(eq(authAccounts.userId,p.userId),eq(authAccounts.providerId,"credential")));
   await tx.update(personnelPeople).set({userId:user.id,managedAccount:false,requirePasswordChange:false,activationHash:null,activationExpires:null}).where(eq(personnelPeople.id,p.id));
   await tx.insert(activityLog).values({companyId:p.companyId,actorType:"user",actorId:req.actor.userId!,action:"personnel.account.relinked",entityType:"user",entityId:user.id,details:{personId:p.id,sourceId:s.id,previousUserId:p.userId,userId:user.id,reason:body.data.reason,accessTransferred:false}});
  });res.json({ok:true});
 });
 router.post(base+"/people/:id/membership",async(req,res)=>{
  const parsed=personnelMembershipInputSchema.safeParse(req.body);
  if(!parsed.success)throw badRequest("请选择目标组织");
  const {companyId}=parsed.data;assertCompanyAccess(req,companyId);
  await db.transaction(async tx=>{
   const [company]=await tx.select({id:companies.id}).from(companies).where(eq(companies.id,companyId));
   if(!company)throw notFound("目标组织不存在");
   const [person]=await tx.select().from(personnelPeople).where(eq(personnelPeople.id,String(req.params.id))).for("update");
   if(!person?.active||!person.userId)throw conflict("请先关联有效的人员账号");
   const s=await source(person.sourceId);if(!s.enabled)throw conflict("身份源已暂停");
   await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${"personnel-membership:"+companyId+":"+person.userId},0))`);
   const [existing]=await tx.select().from(companyMemberships).where(and(eq(companyMemberships.companyId,companyId),eq(companyMemberships.principalType,"user"),eq(companyMemberships.principalId,person.userId))).for("update");
   if(existing&&existing.status!=="active")throw conflict("该账号已有停用或待审核的组织成员关系，请到组织成员管理中处理");
   if(!existing){
    await tx.insert(companyMemberships).values({companyId,principalType:"user",principalId:person.userId,membershipRole:"operator",status:"active"});
    await tx.insert(principalPermissionGrants).values({companyId,principalType:"user",principalId:person.userId,permissionKey:"tasks:assign",grantedByUserId:req.actor.userId}).onConflictDoNothing();
    await tx.insert(activityLog).values({companyId,actorType:"user",actorId:req.actor.userId!,action:"personnel.membership.added",entityType:"user",entityId:person.userId,details:{personId:person.id,sourceId:s.id}});
   }
  });await service.initializePasswords();res.json({ok:true});
 });
 }
 return router;
}
