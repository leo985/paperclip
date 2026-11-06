import { deliveryChainAdmission } from "../services/delivery-chain-admission.js";
import { deliveryAdmission, latestDeliverySnapshots } from "../services/delivery-admission.js";
import { deliveryConnectionRoutes } from "./delivery-connections.js";
import { Router, type Request } from "express";
import { and, desc, eq, sql } from "drizzle-orm";
import { activityLog, deliverySnapshots, projects, analysisExecutions, issues, heartbeatRuns, type Db } from "@paperclipai/db";
import { z } from "zod";
import { assertBoard, assertCompanyAccess } from "./authz.js";
import { isSeatManager } from "./dsp7-seat-owners.js";
import { badRequest, conflict, forbidden, notFound } from "../errors.js";
import { compareDeliveryPlans } from "../services/delivery-snapshot-comparison.js";
import { normalizeDeliverySnapshot } from "../services/delivery-intake.js";
const snapshotInput = z.object({
  projectId:z.string().uuid(), sourceOrigin:z.literal("https://proj.fingard.com:1888"),
  demandNo:z.string().regex(/^[A-Z][A-Z0-9]*-\d+$/), collectedAt:z.string().datetime({offset:true}),
  demandJson:z.string().min(2).max(200000), analysisJson:z.string().min(2).max(200000),
  detailJson:z.string().min(2).max(2000000).optional(),
  scheduleJsons:z.array(z.string().min(2).max(200000)).min(1).max(12), jiraJson:z.string().min(2).max(500000),
}).strict();
export function deliveryIntakeRoutes(db: Db) {
  const router = Router(); router.use(deliveryConnectionRoutes(db)); const base="/companies/:companyId/delivery-intake";
  function access(req:Request, write=false) {
    const companyId=String(req.params.companyId); assertBoard(req); assertCompanyAccess(req,companyId);
    if(write && !isSeatManager(req,companyId)) throw forbidden("条目纳管需要组织管理员权限");
    return companyId;
  }
  async function project(companyId:string, projectId:string) {
    const [p]=await db.select().from(projects).where(and(eq(projects.id,projectId),eq(projects.companyId,companyId)));
    if(!p || p.archivedAt) throw forbidden("项目不属于当前组织或已归档");
  }
  function input(body:unknown) {
    const parsed=snapshotInput.safeParse(body);
    if(!parsed.success) throw badRequest("请提供有效的项目、采集时间及完整来源快照");
    if(Date.parse(parsed.data.collectedAt)>Date.now()+60000) throw badRequest("采集时间不能晚于当前时间");
    return parsed.data;
  }
  // Select the newest source version before filtering/searching or paginating.
  // An older upload must not make a stale version look current.
  router.get(base+"/entries",async(req,res)=>{
    const companyId=access(req);
    const parsed=z.object({projectId:z.string().uuid().optional(),q:z.string().trim().max(200).default(""),attention:z.enum(["all","differences"]).default("all"),page:z.coerce.number().int().min(1).max(10000).default(1)}).strict().safeParse(req.query);
    if(!parsed.success)throw badRequest("条目筛选条件无效");
    const {projectId,q,attention,page}=parsed.data;
    if(projectId)await project(companyId,projectId);
    const rows=await db.select().from(deliverySnapshots).where(and(
      eq(deliverySnapshots.companyId,companyId),projectId?eq(deliverySnapshots.projectId,projectId):undefined,
      sql`exists (select 1 from projects p where p.id = ${deliverySnapshots.projectId} and p.company_id = ${companyId} and p.archived_at is null)`,
      sql`not exists (select 1 from delivery_snapshots newer where newer.company_id = ${companyId} and newer.project_id = ${deliverySnapshots.projectId} and newer.source_origin = ${deliverySnapshots.sourceOrigin} and newer.demand_no = ${deliverySnapshots.demandNo} and (newer.collected_at,newer.created_at,newer.id) > (${deliverySnapshots.collectedAt},${deliverySnapshots.createdAt},${deliverySnapshots.id}))`,
      q?sql`position(lower(${q}) in lower(${deliverySnapshots.demandNo} || ' ' || coalesce(${deliverySnapshots.plan}->>'title',''))) > 0`:undefined,
      attention==="differences"?sql`jsonb_array_length(${deliverySnapshots.plan}->'differences') > 0`:undefined,
    )).orderBy(desc(deliverySnapshots.collectedAt),desc(deliverySnapshots.createdAt),desc(deliverySnapshots.id)).limit(21).offset((page-1)*20);
    res.setHeader("Cache-Control","no-store");res.json({items:rows.slice(0,20),hasMore:rows.length>20});
  });
  router.get(base+"/entries/:snapshotId",async(req,res)=>{
    const companyId=access(req);
    if(!z.string().uuid().safeParse(req.params.snapshotId).success)throw badRequest("条目版本编号无效");
    const [snapshot]=await db.select().from(deliverySnapshots).where(and(eq(deliverySnapshots.companyId,companyId),eq(deliverySnapshots.id,String(req.params.snapshotId))));
    if(!snapshot)throw notFound("条目版本不存在或无权访问");
    await project(companyId,snapshot.projectId);
    const analyses=await db.select({id:analysisExecutions.id,title:analysisExecutions.title,state:analysisExecutions.state,revision:analysisExecutions.revision,activeRunId:analysisExecutions.activeRunId,updatedAt:analysisExecutions.updatedAt}).from(analysisExecutions).where(and(eq(analysisExecutions.companyId,companyId),eq(analysisExecutions.projectId,snapshot.projectId),eq(analysisExecutions.demandNo,snapshot.demandNo))).orderBy(desc(analysisExecutions.updatedAt));
    // Match registered Jira identity, never fuzzy-match a task title.
    const keys=new Set(snapshot.plan.items.map(i=>i.key));
    const candidates=keys.size?await db.select({id:issues.id,title:issues.title,status:issues.status,description:issues.description,updatedAt:issues.updatedAt,runStatus:heartbeatRuns.status}).from(issues).leftJoin(heartbeatRuns,and(eq(issues.executionRunId,heartbeatRuns.id),eq(heartbeatRuns.companyId,companyId))).where(and(eq(issues.companyId,companyId),eq(issues.projectId,snapshot.projectId),sql`(${issues.description} like '%<!-- DSP7-JIRA-INTAKE %' or ${issues.description} like '%<!-- DELIVERY-WORKFLOW %')`,sql`(${sql.join([...keys].map(key=>sql`position(${'"jira_key":"'+key+'"'} in ${issues.description}) > 0`),sql` or `)})`)).orderBy(desc(issues.updatedAt)):[];
    const tasks=candidates.flatMap(t=>{
      try{const data=JSON.parse(t.description?.match(/<!-- (?:DSP7-JIRA-INTAKE|DELIVERY-WORKFLOW) (.*?) -->/)?.[1]??"{}");if(!keys.has(data.jira_key)||data.project_id!==snapshot.projectId)return [];return [{id:t.id,jiraKey:data.jira_key,title:t.title,status:t.status,runStatus:t.runStatus,updatedAt:t.updatedAt}];}catch{return [];}
    });
    const admission = await deliveryAdmission(db,snapshot);
    res.setHeader("Cache-Control","no-store");res.json({snapshot,analyses,tasks,admission,chainAdmission:await deliveryChainAdmission(db,snapshot,{codingAdmission:admission})});
  });
  router.post(base + "/entries/:snapshotId/admission", async (req,res) => {
    const companyId = access(req,true);
    const reference = z.string().trim().url().max(2000).refine(value => { try { const url = new URL(value); return ["http:","https:"].includes(url.protocol) && !url.username && !url.password; } catch { return false; } });
    const parsed = z.object({ fingerprint:z.string().regex(/^[a-f0-9]{64}$/), analysisReference:reference, designRequired:z.boolean(), designReference:z.union([reference,z.literal("")]), note:z.string().trim().min(1).max(2000) }).strict().safeParse(req.body);
    if (!parsed.success || !z.string().uuid().safeParse(req.params.snapshotId).success) throw badRequest("请填写正式分析通过结论链接、设计评审结论或无需设计的理由");
    const data = parsed.data;
    if (data.designRequired && !data.designReference) throw badRequest("需要设计评审时，请提供正式通过结论链接");
    const result = await db.transaction(async transaction => {
      const tx = transaction as unknown as Db;
      const [snapshot] = await tx.select().from(deliverySnapshots).where(and(eq(deliverySnapshots.companyId,companyId),eq(deliverySnapshots.id,String(req.params.snapshotId)))).for("update");
      if (!snapshot) throw notFound("条目不存在或无权访问");
      await project(companyId,snapshot.projectId);
      const latest = await latestDeliverySnapshots(tx,companyId,snapshot.projectId);
      if (!latest.some(s => s.id === snapshot.id) || snapshot.fingerprint !== data.fingerprint) throw conflict("来源版本已变化，请对最新版本重新核验");
      const [analysis] = await tx.select().from(analysisExecutions).where(and(eq(analysisExecutions.companyId,companyId),eq(analysisExecutions.projectId,snapshot.projectId),eq(analysisExecutions.demandNo,snapshot.demandNo))).orderBy(desc(analysisExecutions.createdAt),desc(analysisExecutions.revision),desc(analysisExecutions.id)).limit(1);
      if (analysis && analysis.state !== "published") throw conflict("最新平台分析修订尚未正式发布");
      await tx.insert(activityLog).values({companyId,actorType:"user",actorId:req.actor.userId??"local-board",action:"delivery.admission.checked",entityType:"delivery_snapshot",entityId:snapshot.id,details:{...data,projectId:snapshot.projectId,demandNo:snapshot.demandNo,analysisExecutionId:analysis?.id??null,analysisRevision:analysis?.revision??null,formalApproval:false,executionGranted:false}});
      return deliveryAdmission(tx,snapshot);
    });
    res.setHeader("Cache-Control","no-store"); res.json(result);
  });
  router.get(base,async(req,res)=>{
    const companyId=access(req); const parsed=z.object({projectId:z.string().uuid(),demandNo:z.string().regex(/^[A-Z][A-Z0-9]*-\d+$/).optional(),page:z.coerce.number().int().min(1).max(10000).default(1)}).safeParse(req.query);
    if(!parsed.success) throw badRequest("请选择项目");
    await project(companyId,parsed.data.projectId);
    const rows=await db.select().from(deliverySnapshots).where(and(eq(deliverySnapshots.companyId,companyId),eq(deliverySnapshots.projectId,parsed.data.projectId),parsed.data.demandNo?eq(deliverySnapshots.demandNo,parsed.data.demandNo):undefined)).orderBy(desc(deliverySnapshots.createdAt),desc(deliverySnapshots.id)).limit(21).offset((parsed.data.page-1)*20);
    res.setHeader("Cache-Control","no-store");res.json({items:rows.slice(0,20),hasMore:rows.length>20});
  });
  router.get(base+"/:snapshotId/compare",async(req,res)=>{
    const companyId=access(req);
    const parsed=z.object({snapshotId:z.string().uuid(),baselineId:z.string().uuid()}).safeParse({snapshotId:req.params.snapshotId,baselineId:req.query.baselineId});
    if(!parsed.success)throw badRequest("请选择两个已保存的快照版本");
    const read=async(id:string)=>{
      const [row]=await db.select().from(deliverySnapshots).where(and(eq(deliverySnapshots.companyId,companyId),eq(deliverySnapshots.id,id)));
      if(!row)throw notFound("快照不存在或无权访问");
      return row;
    };
    const before=await read(parsed.data.baselineId),after=await read(parsed.data.snapshotId);
    await project(companyId,after.projectId);
    if(before.projectId!==after.projectId||before.sourceOrigin!==after.sourceOrigin||before.demandNo!==after.demandNo)throw conflict("只能比较同一项目、来源和条目的版本");
    if(before.id===after.id)throw badRequest("请选择不同的版本");
    res.setHeader("Cache-Control","no-store");
    res.json({baselineId:before.id,snapshotId:after.id,demandNo:after.demandNo,baselineCollectedAt:before.collectedAt.toISOString(),collectedAt:after.collectedAt.toISOString(),sourceModeChanged:before.plan.sourceMode!==after.plan.sourceMode,changes:compareDeliveryPlans(before.plan,after.plan),executionAllowed:false});
  });
  router.post(base+"/:snapshotId/comparison-note",async(req,res)=>{
    const companyId=access(req,true);
    const parsed=z.object({snapshotId:z.string().uuid(),baselineId:z.string().uuid(),note:z.string().trim().min(1).max(2000)}).strict().safeParse({...req.body,snapshotId:req.params.snapshotId});
    if(!parsed.success)throw badRequest("请选择版本并填写核对说明（最多 2000 字）");
    const {snapshotId,baselineId,note}=parsed.data;
    if(snapshotId===baselineId)throw badRequest("请选择不同的版本");
    const result=await db.transaction(async tx=>{
      const read=async(id:string)=>{
        const [row]=await tx.select().from(deliverySnapshots).where(and(eq(deliverySnapshots.companyId,companyId),eq(deliverySnapshots.id,id)));
        if(!row)throw notFound("快照不存在或无权访问");return row;
      };
      const before=await read(baselineId),after=await read(snapshotId);
      if(before.projectId!==after.projectId||before.sourceOrigin!==after.sourceOrigin||before.demandNo!==after.demandNo)throw conflict("只能核对同一项目、来源和条目的版本");
      const [p]=await tx.select().from(projects).where(and(eq(projects.id,after.projectId),eq(projects.companyId,companyId))).for("update");
      if(!p||p.archivedAt)throw forbidden("项目不可用");
      await tx.insert(activityLog).values({companyId,actorType:"user",actorId:req.actor.userId??"local-board",action:"delivery.comparison.noted",entityType:"delivery_snapshot",entityId:snapshotId,details:{projectId:after.projectId,demandNo:after.demandNo,baselineId,snapshotId,baselineFingerprint:before.fingerprint,fingerprint:after.fingerprint,note,changeCount:compareDeliveryPlans(before.plan,after.plan).length,executionGranted:false,formalApproval:false}});
      return {recorded:true,executionAllowed:false,formalApproval:false};
    });res.setHeader("Cache-Control","no-store");res.json(result);
  });
  router.post(base+"/preview",async(req,res)=>{
    const companyId=access(req,true);const data=input(req.body);await project(companyId,data.projectId);
    res.setHeader("Cache-Control","no-store");res.json(normalizeDeliverySnapshot(data));
  });
  router.post(base+"/import",async(req,res)=>{
    const companyId=access(req,true);const {fingerprint,...rest}=req.body??{};const data=input(rest);
    if(!z.string().regex(/^[a-f0-9]{64}$/).safeParse(fingerprint).success) throw badRequest("请先预览快照");
    const plan=normalizeDeliverySnapshot(data);if(plan.fingerprint!==fingerprint) throw conflict("快照已改变，请重新预览");
    const result=await db.transaction(async tx=>{
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${companyId+":delivery-intake:"+data.projectId},0))`);
      const [p]=await tx.select().from(projects).where(and(eq(projects.id,data.projectId),eq(projects.companyId,companyId))).for("update");
      if(!p||p.archivedAt) throw forbidden("项目不可用");
      const [prior]=await tx.select().from(deliverySnapshots).where(and(eq(deliverySnapshots.companyId,companyId),eq(deliverySnapshots.projectId,data.projectId),eq(deliverySnapshots.sourceOrigin,data.sourceOrigin),eq(deliverySnapshots.demandNo,data.demandNo),eq(deliverySnapshots.fingerprint,fingerprint)));
      if(prior)return {snapshot:prior,existing:true};
      const [saved]=await tx.insert(deliverySnapshots).values({companyId,projectId:data.projectId,sourceOrigin:data.sourceOrigin,demandNo:data.demandNo,fingerprint,collectedAt:new Date(data.collectedAt),createdByUserId:req.actor.userId??"local-board",plan}).returning();
      await tx.insert(activityLog).values({companyId,actorType:"user",actorId:req.actor.userId??"local-board",action:"delivery.snapshot.imported",entityType:"delivery_snapshot",entityId:saved.id,details:{projectId:data.projectId,demandNo:data.demandNo,fingerprint,executionGranted:false,sourceMode:"manual_snapshot"}});
      return {snapshot:saved,existing:false};
    });
    res.setHeader("Cache-Control","no-store");res.json(result);
  });
  return router;
}
