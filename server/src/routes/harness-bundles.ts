import { Router, type Request } from "express";
import { and, eq, inArray, sql } from "drizzle-orm";
import { activityLog, agents, heartbeatRuns, type Db } from "@paperclipai/db";
import { harnessBundleRegistrationSchema, type HarnessBundleRegistry } from "@paperclipai/shared";
import { assertBoard, assertCompanyAccess } from "./authz.js";
import { canConfigureSeat } from "./dsp7-seat-owners.js";
import { badRequest, conflict, forbidden, notFound } from "../errors.js";
import { z } from "zod";
import { harnessV2Enabled } from "../services/harness-v2-rollout.js";

const empty:HarnessBundleRegistry={version:1,revision:0,items:[]};

function ownActor(req:Request){
  if(req.actor.type!=="agent"||req.actor.source!=="agent_key"||req.actor.agentId!==String(req.params.id)||
      (req.actor.keyScope&&req.actor.keyScope.kind!=="standard"))throw forbidden("Seat credential required");
  assertCompanyAccess(req,req.actor.companyId!);
}
export function harnessBundleRoutes(db:Db){
  const router=Router();
  for(const key of ["id","companyId"])router.param(key,(_req,_res,next,value)=>{
    if(!z.string().uuid().safeParse(value).success)return next(badRequest("Invalid registry identity"));
    next();
  });
  router.use(["/companies/:companyId/dsp7-seats/:id/harness-bundles","/agents/:id/dsp7-harness-bundles"],(_req,res,next)=>{res.setHeader("Cache-Control","no-store");next();});
  router.get("/companies/:companyId/dsp7-seats/:id/harness-bundles",async(req,res)=>{
    const companyId=String(req.params.companyId);assertBoard(req);assertCompanyAccess(req,companyId);
    const [agent]=await db.select().from(agents).where(and(eq(agents.companyId,companyId),eq(agents.id,String(req.params.id))));
    const seat=agent?.adapterConfig.dsp7Seat as Record<string,unknown>|undefined;
    if(!agent||!seat||!canConfigureSeat(req,companyId,seat))throw notFound("Seat not found or inaccessible");
    res.json({...((agent.adapterConfig.dsp7HarnessBundles??empty) as HarnessBundleRegistry),registrationSupported:harnessV2Enabled("bundles",agent.companyId,agent.id)});
  });
  router.get("/agents/:id/dsp7-harness-bundles",async(req,res)=>{
    ownActor(req);
    const [agent]=await db.select().from(agents).where(and(eq(agents.companyId,req.actor.companyId!),eq(agents.id,String(req.params.id))));
    if(!agent?.adapterConfig.dsp7Seat||agent.status==="terminated")throw notFound("Seat unavailable");
    res.json({...((agent.adapterConfig.dsp7HarnessBundles??empty) as HarnessBundleRegistry),registrationSupported:harnessV2Enabled("bundles",agent.companyId,agent.id)});
  });
  router.post("/agents/:id/dsp7-harness-bundles",async(req,res)=>{
    ownActor(req);
    if(!harnessV2Enabled("bundles",req.actor.companyId!,String(req.params.id)))throw conflict("Bundle registration is not enabled");
    const parsed=harnessBundleRegistrationSchema.safeParse(req.body);
    if(!parsed.success)throw badRequest("Invalid bundle registration");
    const data=parsed.data,companyId=req.actor.companyId!;
    if(data.seat_id!==req.actor.agentId)throw forbidden("Seat identity mismatch");
    const result=await db.transaction(async tx=>{
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${data.seat_id+":seat-commands"},0))`);
      const [agent]=await tx.select().from(agents).where(and(eq(agents.companyId,companyId),eq(agents.id,data.seat_id))).for("update");
      const seat=agent?.adapterConfig.dsp7Seat as Record<string,unknown>|undefined;
      if(!agent||!seat||agent.status==="terminated"||seat.machineId!==data.machine_id||seat.machineFingerprint!==data.machine_fingerprint)throw forbidden("Device identity mismatch");
      const registry=(agent.adapterConfig.dsp7HarnessBundles??empty) as HarnessBundleRegistry;
      if(registry.version!==1||registry.revision!==data.expectedRevision)throw conflict("Bundle registry revision changed");
      const bundle={...data.bundle,packages:data.bundle.packages.map(p=>({...p,skills:[...p.skills].sort()})).sort((a,b)=>a.layer.localeCompare(b.layer))};
      const prior=registry.items.find(item=>item.bundleDigest===bundle.bundleDigest);
      if(prior){
        if(Object.entries(bundle).some(([k,v])=>JSON.stringify(prior[k as keyof typeof prior])!==JSON.stringify(v)))throw conflict("Conflicting descriptor for immutable bundle digest");
        return registry;
      }
      const [active]=await tx.select({id:heartbeatRuns.id}).from(heartbeatRuns).where(and(eq(heartbeatRuns.companyId,companyId),eq(heartbeatRuns.agentId,agent.id),inArray(heartbeatRuns.status,["queued","running","scheduled_retry"])));
      const presence=agent.adapterConfig.dsp7SeatPresence as {state?:string;lastSeenAt?:string}|undefined;
      if(active||(presence?.lastSeenAt&&Date.now()-Date.parse(presence.lastSeenAt)<90000&&presence.state!=="idle"))throw conflict("Seat is busy");
      if(registry.items.length>=16)throw conflict("Bundle registry limit reached");
      const updated:HarnessBundleRegistry={version:1,revision:registry.revision+1,items:[...registry.items,{...bundle,
        checkedAt:new Date().toISOString(),validation:"seat-reported-local-files",executionReady:false,loadState:"unconfirmed"}]};
      await tx.update(agents).set({adapterConfig:{...agent.adapterConfig,dsp7HarnessBundles:updated},updatedAt:new Date()}).where(eq(agents.id,agent.id));
      await tx.insert(activityLog).values({companyId,agentId:agent.id,actorType:"agent",actorId:agent.id,action:"harness.bundle.registered",
        entityType:"agent",entityId:agent.id,details:{bundleDigest:bundle.bundleDigest,revision:updated.revision,executionGranted:false}});
      return updated;
    });
    res.json({...result,registrationSupported:true});
  });
  return router;
}
