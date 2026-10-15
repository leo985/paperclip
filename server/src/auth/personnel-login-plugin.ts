import { requiresPersonnelPasswordChange } from "./personnel-passwords.js";
import { createHash, randomUUID } from "node:crypto";
import type { RequestHandler } from "express";
import { and, eq, or, gt } from "drizzle-orm";
import { z } from "zod";
import { createAuthEndpoint, createAuthMiddleware, sessionMiddleware, isAPIError, APIError } from "better-auth/api";
import { setSessionCookie } from "better-auth/cookies";
import { hashPassword, verifyPassword } from "better-auth/crypto";
import { authAccounts, personnelPeople, personnelSources, companyMemberships, activityLog, type Db } from "@paperclipai/db";
// Independent of the instance's optional Better Auth rate-limit switch.
const attempts = new Map<string, { until: number; count: number }>();
export const personnelAuthRateLimit: RequestHandler = (req, res, next) => {
 const now = Date.now(), key = req.socket.remoteAddress || "unknown";
 for (const [k, value] of attempts) if (value.until <= now) attempts.delete(k);
 if (attempts.size >= 10000 && !attempts.has(key)) { res.status(429).json({error:"登录请求过多，请稍后重试"}); return; }
 const value = attempts.get(key) || { until: now + 60_000, count: 0 };
 value.count++; attempts.set(key,value);
 if (value.count > 10) { res.setHeader("Retry-After",String(Math.ceil((value.until-now)/1000))); res.status(429).json({error:"登录请求过多，请稍后重试"}); return; }
 next();
};
export function personnelLoginPlugin(db:Db) {
 const fail=()=>new APIError("UNAUTHORIZED",{message:"账号、密码或激活链接无效"});
 return {id:"personnel-federation",hooks:{after:[{
  matcher:(ctx:{path?:string})=>ctx.path==="/change-password",
  handler:createAuthMiddleware(async ctx=>{
   if(isAPIError(ctx.context.returned)||!ctx.context.session?.user.id)return;
   const userId=ctx.context.session.user.id;
   await db.transaction(async tx=>{
    const changed=await tx.update(personnelPeople).set({requirePasswordChange:false}).where(and(eq(personnelPeople.userId,userId),eq(personnelPeople.requirePasswordChange,true))).returning();
    for(const p of changed)await tx.insert(activityLog).values({companyId:p.companyId,actorType:"user",actorId:userId,action:"personnel.initial-password.changed",entityType:"user",entityId:userId,details:{personId:p.id}});
   });
  }),
 }]},endpoints:{
  personnelPasswordStatus:createAuthEndpoint("/personnel-password-status",{method:"GET",requireHeaders:true,use:[sessionMiddleware]},async ctx=>{
   ctx.setHeader("Cache-Control","no-store");return ctx.json({required:await requiresPersonnelPasswordChange(db,ctx.context.session.user.id)});
  }),
  personnelSignIn:createAuthEndpoint("/personnel-sign-in",{method:"POST",requireHeaders:true,body:z.object({username:z.string().trim().min(1).max(300),password:z.string().min(1).max(1024)})},async ctx=>{
   const found=await db.select({person:personnelPeople}).from(personnelPeople).innerJoin(personnelSources,eq(personnelSources.id,personnelPeople.sourceId)).where(and(eq(personnelPeople.active,true),eq(personnelSources.enabled,true),or(eq(personnelPeople.username,ctx.body.username),eq(personnelPeople.email,ctx.body.username),eq(personnelPeople.externalId,ctx.body.username)))).limit(2);
   if(found.length!==1||!found[0].person.userId)throw fail();const p=found[0].person;
   const [member]=await db.select().from(companyMemberships).where(and(eq(companyMemberships.companyId,p.companyId),eq(companyMemberships.principalId,p.userId!),eq(companyMemberships.principalType,"user"),eq(companyMemberships.status,"active")));
   const [account]=await db.select().from(authAccounts).where(and(eq(authAccounts.userId,p.userId!),eq(authAccounts.providerId,"credential")));
   if(!member||!account?.password||!await verifyPassword({hash:account.password,password:ctx.body.password}))throw fail();
   const user=await ctx.context.internalAdapter.findUserById(p.userId!);if(!user)throw fail();
   const session=await ctx.context.internalAdapter.createSession(user.id);if(!session)throw fail();
   await setSessionCookie(ctx,{session,user});ctx.setHeader("Cache-Control","no-store");return ctx.json({ok:true});
  }),
  personnelActivate:createAuthEndpoint("/personnel-activate",{method:"POST",requireHeaders:true,body:z.object({token:z.string().regex(/^[a-f0-9]{64}$/),credentials:z.object({password:z.string().min(12).max(1024)})})},async ctx=>{
   const digest=createHash("sha256").update(ctx.body.token).digest("hex");
   const hash=await hashPassword(ctx.body.credentials.password);
   const person=await db.transaction(async tx=>{
    const [p]=await tx.select().from(personnelPeople).where(and(eq(personnelPeople.activationHash,digest),gt(personnelPeople.activationExpires,new Date()),eq(personnelPeople.active,true),eq(personnelPeople.managedAccount,true))).for("update");
    if(!p?.userId)throw fail();
    const [s]=await tx.select().from(personnelSources).where(and(eq(personnelSources.id,p.sourceId),eq(personnelSources.enabled,true)));if(!s)throw fail();
    const [member]=await tx.select().from(companyMemberships).where(and(eq(companyMemberships.companyId,p.companyId),eq(companyMemberships.principalType,"user"),eq(companyMemberships.principalId,p.userId),eq(companyMemberships.status,"active")));if(!member)throw fail();
    const [old]=await tx.select().from(authAccounts).where(and(eq(authAccounts.userId,p.userId),eq(authAccounts.providerId,"credential")));if(old)throw fail();
    await tx.insert(authAccounts).values({id:randomUUID(),issuer:"local:credential",accountId:p.userId,providerId:"credential",userId:p.userId,password:hash,createdAt:new Date(),updatedAt:new Date()});
    await tx.update(personnelPeople).set({activationHash:null,activationExpires:null}).where(eq(personnelPeople.id,p.id));
    await tx.insert(activityLog).values({companyId:p.companyId,actorType:"user",actorId:p.userId,action:"personnel.account.activated",entityType:"user",entityId:p.userId,details:{personId:p.id}});return p;
   });
   const user=await ctx.context.internalAdapter.findUserById(person.userId!);if(!user)throw fail();
   const session=await ctx.context.internalAdapter.createSession(user.id);if(!session)throw fail();
   await setSessionCookie(ctx,{session,user});ctx.setHeader("Cache-Control","no-store");return ctx.json({ok:true});
  }),
 }};
}
