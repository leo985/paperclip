import { Router } from "express";
import { createHash, randomBytes } from "node:crypto";
import { and, eq, sql, inArray } from "drizzle-orm";
import { z } from "zod";
import { activityLog, authUsers, authAccounts, authSessions, personnelSources, personnelPeople, personnelDepartments, companyMemberships, principalPermissionGrants, type Db } from "@paperclipai/db";
import { assertCompanyAccess, assertInstanceAdmin } from "./authz.js";
import { badRequest, conflict, notFound } from "../errors.js";
import { secretService } from "../services/secrets.js";
import { personnelDirectoryService } from "../services/personnel-directory.js";
const schema=z.object({type:z.enum(["DingTalk","WeCom"]),name:z.string().trim().min(1).max(200),corpId:z.string().trim().min(1).max(200),appKey:z.string().trim().max(200),syncScope:z.string().trim().regex(/^\d+(\s*,\s*\d+)*$/),enabled:z.boolean(),autoSync:z.boolean(),syncInterval:z.number().int().min(300).max(86400),credentials:z.object({secret:z.string().min(1).max(4096)}).strict().optional()}).strict();
function publicSource(s:typeof personnelSources.$inferSelect){const {secretId,leaseUntil,...data}=s;return {...data,secretConfigured:!!secretId,syncing:!!leaseUntil&&leaseUntil>new Date()};}
export function personnelFederationRoutes(db:Db) {
 const router=Router(),service=personnelDirectoryService(db);
 router.use("/companies/:companyId/personnel-federation",(req,_res,next)=>{assertInstanceAdmin(req);assertCompanyAccess(req,String(req.params.companyId));next();});
 const base="/companies/:companyId/personnel-federation";
 async function source(companyId:string,id:string){const [s]=await db.select().from(personnelSources).where(and(eq(personnelSources.id,id),eq(personnelSources.companyId,companyId)));if(!s)throw notFound("身份源不存在");return s;}
 router.get(base,async(req,res)=>{
  const companyId=String(req.params.companyId);
  const sources=await db.select().from(personnelSources).where(eq(personnelSources.companyId,companyId));
  const people=await db.select().from(personnelPeople).where(eq(personnelPeople.companyId,companyId));
  const passwords=await db.select({userId:authAccounts.userId}).from(authAccounts).where(eq(authAccounts.providerId,"credential"));
  const passwordUsers=new Set(passwords.map(p=>p.userId));
  const existingAccounts=passwordUsers.size?await db.select({id:authUsers.id,name:authUsers.name,email:authUsers.email}).from(authUsers).where(inArray(authUsers.id,[...passwordUsers])):[];
  res.setHeader("Cache-Control","no-store");res.json({sources:sources.map(publicSource),existingAccounts,departments:await db.select().from(personnelDepartments).where(eq(personnelDepartments.companyId,companyId)),people:people.map(p=>{const {activationHash,activationExpires,...data}=p;return {...data,loginConfigured:!!p.userId&&passwordUsers.has(p.userId)};})});
 });
 router.post(base,async(req,res)=>{
  const parsed=schema.safeParse(req.body);if(!parsed.success)throw badRequest("请填写身份源、应用和有效的部门范围");
  const {credentials,...data}=parsed.data,companyId=String(req.params.companyId);
  if(data.type==="DingTalk"&&!data.appKey)throw badRequest("钉钉需要 AppKey");
  const result=await db.transaction(async tx=>{
   await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${companyId+":personnel-sources"},0))`);
   const [old]=await tx.select().from(personnelSources).where(and(eq(personnelSources.companyId,companyId),eq(personnelSources.type,data.type),eq(personnelSources.corpId,data.corpId))).for("update");
   if(old?.leaseUntil&&old.leaseUntil>new Date())throw conflict("同步进行中，请稍后保存配置");
   let secretId=old?.secretId;
   if(credentials){const svc=secretService(tx);if(secretId)await svc.rotate(secretId,{value:credentials.secret},{userId:req.actor.userId});else secretId=(await svc.create(companyId,{name:"人员联邦 "+data.type+" "+data.corpId,provider:"local_encrypted",value:credentials.secret},{userId:req.actor.userId})).id;}
   if(!secretId)throw badRequest("首次配置需要应用密钥");
   const [s]=old?await tx.update(personnelSources).set({...data,secretId,updatedAt:new Date()}).where(eq(personnelSources.id,old.id)).returning():await tx.insert(personnelSources).values({...data,companyId,secretId}).returning();
   await tx.insert(activityLog).values({companyId,actorType:"user",actorId:req.actor.userId!,action:"personnel.federation.configured",entityType:"personnel_source",entityId:s.id,details:{...data,secretConfigured:true}});return s;
  });res.json(publicSource(result));
 });
 router.post(base+"/:id/sync",async(req,res)=>{const s=await source(String(req.params.companyId),String(req.params.id));res.json(await service.sync(s.id,req.actor.userId!));});
 router.post(base+"/people/:id/activation",async(req,res)=>{
  const companyId=String(req.params.companyId);
  const [p]=await db.select().from(personnelPeople).where(and(eq(personnelPeople.id,String(req.params.id)),eq(personnelPeople.companyId,companyId)));
  if(!p?.active||!p.userId||!p.managedAccount)throw conflict("只能为有效的联邦新账号生成激活链接；已有账号请用原登录方式");
  const s=await source(companyId,p.sourceId);if(!s.enabled)throw conflict("身份源已暂停");
  const token=randomBytes(32).toString("hex"),expiresAt=new Date(Date.now()+24*60*60*1000);
  const [password]=await db.select().from(authAccounts).where(and(eq(authAccounts.userId,p.userId),eq(authAccounts.providerId,"credential")));
  if(password?.password)throw conflict("账号已激活，不能通过联邦入口重置已有密码");
  await db.update(personnelPeople).set({activationHash:createHash("sha256").update(token).digest("hex"),activationExpires:expiresAt}).where(eq(personnelPeople.id,p.id));
  await db.insert(activityLog).values({companyId,actorType:"user",actorId:req.actor.userId!,action:"personnel.activation.issued",entityType:"user",entityId:p.userId,details:{personId:p.id,expiresAt:expiresAt.toISOString()}});
  res.setHeader("Cache-Control","no-store");res.json({path:"/auth#activate="+token,expiresAt,username:p.username});
 });
 router.post(base+"/people/:id/link",async(req,res)=>{
  const body=z.object({userId:z.string().min(1),confirm:z.literal(true)}).strict().safeParse(req.body);if(!body.success)throw badRequest("请明确确认关联已有用户");
  const companyId=String(req.params.companyId);
  await db.transaction(async tx=>{
   const [p]=await tx.select().from(personnelPeople).where(and(eq(personnelPeople.id,String(req.params.id)),eq(personnelPeople.companyId,companyId))).for("update");
   if(!p?.active||p.userId&&!p.managedAccount)throw conflict("仅允许关联未激活的联邦新账号或尚未绑定人员");
   if(p.userId){
    const credentials=await tx.select().from(authAccounts).where(eq(authAccounts.userId,p.userId));
    const sessions=await tx.select().from(authSessions).where(eq(authSessions.userId,p.userId));
    if(credentials.length||sessions.length)throw conflict("账号已激活或使用，不能替换关联");
   }
   const [user]=await tx.select().from(authUsers).where(eq(authUsers.id,body.data.userId));if(!user)throw notFound("网站用户不存在");
   if(user.id===p.userId)throw badRequest("请选择原网站账号，不能关联当前未激活的新账号");
   const targetAccounts=await tx.select().from(authAccounts).where(eq(authAccounts.userId,user.id));
   if(!targetAccounts.length)throw conflict("原网站账号尚未配置登录，请先核对账号");
   if(p.userId&&p.userId!==user.id)await tx.update(companyMemberships).set({status:"inactive",updatedAt:new Date()}).where(and(eq(companyMemberships.companyId,companyId),eq(companyMemberships.principalId,p.userId),eq(companyMemberships.principalType,"user")));
   await tx.update(personnelPeople).set({userId:user.id,managedAccount:false,activationHash:null,activationExpires:null}).where(eq(personnelPeople.id,p.id));
   const inserted=await tx.insert(companyMemberships).values({companyId,principalType:"user",principalId:user.id,membershipRole:"operator",status:"active"}).onConflictDoNothing().returning();
   if(inserted.length)await tx.insert(principalPermissionGrants).values({companyId,principalType:"user",principalId:user.id,permissionKey:"tasks:assign",grantedByUserId:req.actor.userId}).onConflictDoNothing();
   await tx.insert(activityLog).values({companyId,actorType:"user",actorId:req.actor.userId!,action:"personnel.account.linked",entityType:"user",entityId:user.id,details:{personId:p.id}});
  });res.json({ok:true});
 });
 return router;
}
