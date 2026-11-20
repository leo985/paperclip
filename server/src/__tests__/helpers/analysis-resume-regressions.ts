import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { activityLog, agents, agentWakeupRequests, analysisExecutions, companies, environmentLeases, heartbeatRuns, issueRecoveryActions, issues, projects, seatExecutionPermits, type Db } from "@paperclipai/db";
import { acknowledgeStoppedAnalysisExecution } from "../../services/analysis-execution-resume.js";
import { analysisDispatchProblem, settleAnalysisDispatch } from "../../services/analysis-dispatch-state.js";
import { getExecutionBlocker } from "../../services/execution-blocker.js";

/** Runs equally against a disposable test DB or inside an explicitly rolled-back
 * verification transaction. It never starts a provider or calls external APIs. */
export async function runAnalysisResumeRegressions(db: Db) {
  const checks: string[] = [];
  async function seed() {
    const companyId=randomUUID(),agentId=randomUUID(),taskId=randomUUID(),runId=randomUUID(),machineId=randomUUID(),projectId=randomUUID(),dispatchId=randomUUID();
    await db.insert(companies).values({id:companyId,name:"Analysis resume regression",issuePrefix:"R"+companyId.slice(0,7)});
    await db.insert(projects).values({id:projectId,companyId,name:"Resume fixture"});
    const [agent]=await db.insert(agents).values({id:agentId,companyId,name:"Fixture seat",role:"engineer",adapterType:"claude_local",adapterConfig:{dsp7Transport:"outbound",dsp7Seat:{machineId}}}).returning();
    const [issue]=await db.insert(issues).values({id:taskId,companyId,assigneeAgentId:agentId,title:"Resume fixture",status:"todo"}).returning();
    await db.insert(analysisExecutions).values({id:taskId,companyId,projectId,seatId:agentId,ownerUserId:"fixture-owner",requestId:randomUUID(),createdBy:"fixture-owner",title:"Resume fixture",brief:"Continue preserved native analysis",state:"queued",dispatchId});
    const [run]=await db.insert(heartbeatRuns).values({id:runId,companyId,agentId,status:"cancelled",finishedAt:new Date(),errorCode:"cancelled",runtimeMode:"legacy",runnerProfileJson:{adapterDispatch:{adapterType:"claude_local"}},contextSnapshot:{issueId:taskId,analysisExecutionId:taskId,analysisDispatchId:randomUUID(),wakeReason:"智研需求分析授权启动；fixture"},resultJson:{preserved:"old evidence",localStopRequiresVerification:true,executionCancellation:{state:"requested"}}}).returning();
    const [permit]=await db.insert(seatExecutionPermits).values({companyId,agentId,taskId,runId,machineId,leaseHash:"a".repeat(64),expiresAt:new Date(),treeProofRequired:true,treeStopVerifiedAt:new Date(),processExitObservedAt:new Date(),revokedAt:new Date()}).returning();
    await db.insert(issueRecoveryActions).values({companyId,sourceIssueId:taskId,kind:"active_run_watchdog",cause:"legacy_execution_requires_reconciliation",fingerprint:runId,status:"resolved",outcome:"blocked",nextAction:"Preserve old work",evidence:{runId,automaticRecovery:{replay:"blocked",actionOutcome:"unknown"}}});
    return {agent:agent!,issue:issue!,run:run!,permit:permit!,dispatchId,actorId:"fixture-owner"};
  }
  {
    const f=await seed();assert(await getExecutionBlocker(db,f.issue.companyId,f.issue.id));
    await db.transaction(tx=>acknowledgeStoppedAnalysisExecution(tx as unknown as Db,f));
    assert.equal(await getExecutionBlocker(db,f.issue.companyId,f.issue.id),null);
    const [r]=await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id,f.run.id));assert.equal(r.status,"cancelled");assert.equal(r.resultJson?.preserved,"old evidence");assert.equal(r.resultJson?.localStopRequiresVerification,false);
    const [action]=await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.sourceIssueId,f.issue.id));assert.deepEqual(action.evidence.automaticRecovery,{replay:"blocked",actionOutcome:"unknown"});
    const audit=await db.select().from(activityLog).where(eq(activityLog.entityId,f.issue.id));assert.equal(audit.filter(x=>x.action==="analysis.execution_stop.acknowledged").length,1);
    await db.transaction(tx=>acknowledgeStoppedAnalysisExecution(tx as unknown as Db,f));
    assert.equal((await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.companyId,f.issue.companyId))).length,1);checks.push("verified_cancel_resume_preserves_history_and_is_idempotent");
  }
  for(const gate of ["missing_tree_receipt","child_exit_only","wrong_machine","wrong_task","wrong_adapter","non_analysis","active_run","process_owner","unreleased_lease","unrelated_hold"]){
    const f=await seed();
    if(gate==="missing_tree_receipt")await db.delete(seatExecutionPermits).where(eq(seatExecutionPermits.id,f.permit.id));
    if(gate==="child_exit_only")await db.update(seatExecutionPermits).set({treeStopVerifiedAt:null}).where(eq(seatExecutionPermits.id,f.permit.id));
    if(gate==="wrong_machine")f.agent.adapterConfig.dsp7Seat={machineId:randomUUID()};
    if(gate==="wrong_task")await db.update(heartbeatRuns).set({contextSnapshot:{...f.run.contextSnapshot,analysisExecutionId:randomUUID()}}).where(eq(heartbeatRuns.id,f.run.id));
    if(gate==="wrong_adapter")await db.update(heartbeatRuns).set({runnerProfileJson:{adapterDispatch:{adapterType:"process"}}}).where(eq(heartbeatRuns.id,f.run.id));
    if(gate==="non_analysis")await db.update(heartbeatRuns).set({contextSnapshot:{...f.run.contextSnapshot,wakeReason:"unrelated run"}}).where(eq(heartbeatRuns.id,f.run.id));
    if(gate==="active_run")await db.insert(heartbeatRuns).values({companyId:f.issue.companyId,agentId:f.agent.id,status:"running",contextSnapshot:{issueId:f.issue.id}});
    if(gate==="process_owner")await db.update(heartbeatRuns).set({processPid:1}).where(eq(heartbeatRuns.id,f.run.id));
    if(gate==="unreleased_lease")await db.insert(environmentLeases).values({companyId:f.issue.companyId,heartbeatRunId:f.run.id,provider:"local",status:"active",leasePolicy:"ephemeral"});
    if(gate==="unrelated_hold")await db.insert(issueRecoveryActions).values({companyId:f.issue.companyId,sourceIssueId:f.issue.id,kind:"active_run_watchdog",cause:"uncertain_external_action",fingerprint:randomUUID(),status:"active",nextAction:"Keep unrelated hold",evidence:{runId:f.run.id}});
    await assert.rejects(db.transaction(tx=>acknowledgeStoppedAnalysisExecution(tx as unknown as Db,f)));
    const [r]=await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id,f.run.id));assert.equal(r.resultJson?.localStopRequiresVerification,true);assert(await getExecutionBlocker(db,f.issue.companyId,f.issue.id));checks.push("retains_protection_"+gate);
  }
  for(const status of ["skipped","failed","cancelled","queued"]){
    const f=await seed();await db.delete(issueRecoveryActions).where(eq(issueRecoveryActions.sourceIssueId,f.issue.id));
    await db.insert(agentWakeupRequests).values({companyId:f.issue.companyId,agentId:f.agent.id,source:"automation",status,idempotencyKey:"analysis-"+f.dispatchId});
    const input={companyId:f.issue.companyId,seatId:f.agent.id,taskId:f.issue.id,dispatchId:f.dispatchId,actorId:f.actorId};
    if(status==="queued")assert.equal(await settleAnalysisDispatch(db,input,null),null);
    else await assert.rejects(settleAnalysisDispatch(db,input,null));
    const [row]=await db.select().from(analysisExecutions).where(eq(analysisExecutions.id,f.issue.id));assert.equal(row.state,status==="queued"?"queued":"interrupted");checks.push("dispatch_receipt_"+status);
  }
  {
    const f=await seed();assert(await analysisDispatchProblem(db,{id:f.issue.id,companyId:f.issue.companyId,seatId:f.agent.id,dispatchId:f.dispatchId,state:"queued",activeRunId:null,delivery:null}));
    await db.update(heartbeatRuns).set({status:"running",finishedAt:null,contextSnapshot:{...f.run.contextSnapshot,analysisDispatchId:f.dispatchId}}).where(eq(heartbeatRuns.id,f.run.id));
    const recovered=await settleAnalysisDispatch(db,{companyId:f.issue.companyId,seatId:f.agent.id,taskId:f.issue.id,dispatchId:f.dispatchId,actorId:f.actorId},null);assert.equal(recovered?.id,f.run.id);checks.push("lost_run_receipt_recovers_exact_dispatch_without_duplicate");
  }
  return checks;
}
