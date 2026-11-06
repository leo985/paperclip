import { createHash } from "node:crypto";
import { Router } from "express";
import { and, eq, inArray, sql } from "drizzle-orm";
import { activityLog, agents, heartbeatRuns, type Db } from "@paperclipai/db";
import { harnessCapabilityInputSchema, type HarnessCapabilityRegistry } from "@paperclipai/shared";
import { z } from "zod";
import { canConfigureSeat } from "./dsp7-seat-owners.js";
import { assertBoard, assertCompanyAccess } from "./authz.js";
import { badRequest, conflict, forbidden, notFound } from "../errors.js";
const identity=z.object({seat_id:z.string().uuid(),machine_id:z.string().uuid(),machine_fingerprint:z.string().regex(/^[a-f0-9]{64}$/)});
const registration=identity.extend({expectedRevision:z.number().int().min(0),capability:harnessCapabilityInputSchema}).strict();
const empty:HarnessCapabilityRegistry={version:1,revision:0,items:[]};
export function harnessCapabilityRoutes(db:Db){
 const router=Router();
 router.get("/companies/:companyId/dsp7-seats/:id/harness-capabilities",async(req,res)=>{
  const companyId=String(req.params.companyId);assertBoard(req);assertCompanyAccess(req,companyId);
  const [agent]=await db.select().from(agents).where(and(eq(agents.companyId,companyId),eq(agents.id,String(req.params.id))));
  if(!agent?.adapterConfig.dsp7Seat)throw notFound("席位不存在");
  res.setHeader("Cache-Control","no-store");res.json(agent.adapterConfig.dsp7HarnessCapabilities??empty);
 });
 router.put("/companies/:companyId/dsp7-seats/:id/harness-routing",async(req,res)=>{
  const companyId=String(req.params.companyId);assertBoard(req);assertCompanyAccess(req,companyId);
  const parsed=z.object({expectedRevision:z.number().int().min(0),kind:z.enum(["analysis","development","qa"]),capabilityId:z.string().regex(/^[a-f0-9]{64}$/)}).strict().safeParse(req.body);
  if(!parsed.success)throw badRequest("请选择已登记的领域 Harness");
  const result=await db.transaction(async tx=>{
   await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${String(req.params.id)+":seat-commands"},0))`);
   const [agent]=await tx.select().from(agents).where(and(eq(agents.companyId,companyId),eq(agents.id,String(req.params.id)))).for("update");
   const seat=agent?.adapterConfig.dsp7Seat as Record<string,unknown>|undefined;
   if(!agent||!seat||!canConfigureSeat(req,companyId,seat))throw forbidden("只有席位负责人或管理员可以配置 Harness 路由");
   const registry=agent.adapterConfig.dsp7HarnessCapabilities as HarnessCapabilityRegistry|undefined;
   if(!registry||registry.revision!==parsed.data.expectedRevision)throw conflict("能力登记已变化，请刷新后重试");
   if(!registry.items.some(item=>item.id===parsed.data.capabilityId&&item.kind===parsed.data.kind))throw conflict("所选能力不属于该领域或当前席位");
   const [active]=await tx.select({id:heartbeatRuns.id}).from(heartbeatRuns).where(and(eq(heartbeatRuns.agentId,agent.id),inArray(heartbeatRuns.status,["queued","running","scheduled_retry"])));
   const presence=agent.adapterConfig.dsp7SeatPresence as {state?:string;lastSeenAt?:string}|undefined;
   if(active||presence?.lastSeenAt&&Date.now()-Date.parse(presence.lastSeenAt)<90000&&presence.state!=="idle")throw conflict("席位有执行或待决策任务，请结束后调整路由");
   const updated:HarnessCapabilityRegistry={...registry,revision:registry.revision+1,routing:{...registry.routing,[parsed.data.kind]:parsed.data.capabilityId}};
   await tx.update(agents).set({adapterConfig:{...agent.adapterConfig,dsp7HarnessCapabilities:updated},updatedAt:new Date()}).where(eq(agents.id,agent.id));
   await tx.insert(activityLog).values({companyId,agentId:agent.id,actorType:"user",actorId:req.actor.userId??"local-board",action:"harness.routing.changed",entityType:"agent",entityId:agent.id,details:{kind:parsed.data.kind,capabilityId:parsed.data.capabilityId,revision:updated.revision,executionGranted:false}});
   return updated;
  });res.setHeader("Cache-Control","no-store");res.json(result);
 });
 router.get("/agents/:id/dsp7-harness-capabilities",async(req,res)=>{
  if(req.actor.type!=="agent"||req.actor.source!=="agent_key"||(req.actor.keyScope&&req.actor.keyScope.kind!=="standard")||req.actor.agentId!==String(req.params.id))throw forbidden("需要本席位独立凭证");
  assertCompanyAccess(req,req.actor.companyId!);
  const [agent]=await db.select().from(agents).where(and(eq(agents.companyId,req.actor.companyId!),eq(agents.id,String(req.params.id))));
  if(!agent?.adapterConfig.dsp7Seat)throw notFound("席位不存在");
  res.setHeader("Cache-Control","no-store");res.json(agent.adapterConfig.dsp7HarnessCapabilities??empty);
 });
 router.post("/agents/:id/dsp7-harness-capabilities",async(req,res)=>{
  const parsed=registration.safeParse(req.body);if(!parsed.success)throw badRequest("Harness 能力登记无效，请更新客户端后重新登记");const data=parsed.data;
  if(req.actor.type!=="agent"||req.actor.source!=="agent_key"||(req.actor.keyScope&&req.actor.keyScope.kind!=="standard")||req.actor.agentId!==String(req.params.id)||data.seat_id!==req.actor.agentId)throw forbidden("需要本席位独立凭证");
  assertCompanyAccess(req,req.actor.companyId!);
  const companyId=req.actor.companyId!;
  const result=await db.transaction(async tx=>{
   await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${data.seat_id+":seat-commands"},0))`);
   const [agent]=await tx.select().from(agents).where(and(eq(agents.companyId,companyId),eq(agents.id,data.seat_id))).for("update");
   const seat=agent?.adapterConfig.dsp7Seat as Record<string,unknown>|undefined;
   if(!seat||seat.machineId!==data.machine_id||seat.machineFingerprint!==data.machine_fingerprint||agent.status==="terminated")throw forbidden("电脑身份与席位不一致");
   const registry=(agent.adapterConfig.dsp7HarnessCapabilities??empty) as HarnessCapabilityRegistry;
   if(registry.version!==1||registry.revision!==data.expectedRevision)throw conflict("能力登记已变化，请刷新后重试");
   const capability={...data.capability,roles:[...data.capability.roles].sort()};
   const id=createHash("sha256").update(JSON.stringify([capability.kind,capability.repository,capability.profile])).digest("hex");
   const prior=registry.items.find(c=>c.id===id);
   const changed=!prior||Object.keys(capability).some(k=>JSON.stringify(prior[k as keyof typeof prior])!==JSON.stringify(capability[k as keyof typeof capability]));
   if(changed){
    const [active]=await tx.select({id:heartbeatRuns.id}).from(heartbeatRuns).where(and(eq(heartbeatRuns.companyId,companyId),eq(heartbeatRuns.agentId,agent.id),inArray(heartbeatRuns.status,["queued","running","scheduled_retry"])));
    const p=agent.adapterConfig.dsp7SeatPresence as {state?:string;lastSeenAt?:string}|undefined;
    if(active||p?.lastSeenAt&&Date.now()-Date.parse(p.lastSeenAt)<90000&&p.state!=="idle")throw conflict("席位有执行或待决策任务，请结束后更换 Harness 登记");
    if(!prior&&registry.items.length>=16)throw conflict("每席位最多登记 16 项 Harness 能力");
   }
   const updated:HarnessCapabilityRegistry={version:1,revision:registry.revision+(changed?1:0),routing:registry.routing,items:[...registry.items.filter(c=>c.id!==id),{...capability,id,checkedAt:new Date().toISOString(),validation:"local-files" as const,executionReady:false as const}].sort((a,b)=>a.id.localeCompare(b.id))};
   await tx.update(agents).set({adapterConfig:{...agent.adapterConfig,dsp7HarnessCapabilities:updated},updatedAt:new Date()}).where(eq(agents.id,agent.id));
   if(changed)await tx.insert(activityLog).values({companyId,agentId:agent.id,actorType:"agent",actorId:agent.id,action:"harness.capability.registered",entityType:"agent",entityId:agent.id,details:{capabilityId:id,kind:capability.kind,repository:capability.repository,profile:capability.profile,revision:updated.revision,executionGranted:false}});
   return updated;
  });res.setHeader("Cache-Control","no-store");res.json(result);
 });
 return router;
}
