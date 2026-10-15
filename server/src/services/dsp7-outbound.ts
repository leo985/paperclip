import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { AdapterExecutionContext, AdapterExecutionResult, AdapterSkillContext } from "../adapters/types.js";
import { buildRuntimeMountedSkillSnapshot, resolveLegacyPaperclipDesiredSkillNames, readPaperclipRuntimeSkillEntries, renderPaperclipWakePrompt, selectPaperclipTaskMarkdown } from "@paperclipai/adapter-utils/server-utils";

// Only live native adapter invocations can be claimed. No transport token or
// model credential is persisted. A server restart fences the old invocation.
interface Job {
  ctx: AdapterExecutionContext; packet: Record<string,unknown>; lease: string|null;
  lastSeen: number; sequence: number; dispatching: boolean; receipts: Promise<void>;
  resolve: (result: AdapterExecutionResult)=>void;
}
const jobs=new Map<string,Job>();
export function outboundJob(runId:string) { return jobs.get(runId); }
export function pendingOutbound(agentId:string) { return [...jobs.values()].find(j=>j.ctx.agent.id===agentId&&!j.lease); }
export async function claimOutbound(job:Job) {
  if(job.lease||job.dispatching)throw new Error("运行已领取，不自动重新派发");
  job.dispatching=true;
  try {
    if(job.ctx.signal?.aborted)throw new Error("运行已取消");
    await job.ctx.onCancellationReady?.();
    job.ctx.onDispatch?.();
    job.lease=randomUUID();job.lastSeen=Date.now();
    return {...job.packet,lease:job.lease,authToken:job.ctx.authToken??null};
  } finally { job.dispatching=false; }
}
export async function receiveOutbound(job:Job,input:{sequence:number;stream?:"stdout"|"stderr";chunk?:string;result?:AdapterExecutionResult}) {
  const receipt = job.receipts.then(async () => {
    job.lastSeen=Date.now();
    if(input.sequence<=job.sequence)return;
    if(input.sequence!==job.sequence+1)throw new Error("回执序号不连续");
    if(input.chunk)await job.ctx.onLog(input.stream??"stdout",input.chunk);
    job.sequence=input.sequence;
    if(input.result)job.resolve(input.result);
  });
  job.receipts=receipt.catch(()=>{});
  await receipt;
}
async function skills(config:Record<string,unknown>) {
  const entries=await readPaperclipRuntimeSkillEntries(config,path.dirname(fileURLToPath(import.meta.url)));
  const files:Array<{path:string;data:string}>=[];let bytes=0;
  for(const entry of entries) {
    if(!/^[A-Za-z0-9_.-]+$/.test(entry.runtimeName))throw new Error("技能名称无效");
    const root=await fs.realpath(entry.source);
    async function visit(relative:string) {
      const folder=path.join(root,relative);
      for(const item of await fs.readdir(folder,{withFileTypes:true})) {
        if(item.isSymbolicLink()||item.name===".git"||item.name==="node_modules")continue;
        const rel=path.join(relative,item.name);const full=path.join(root,rel);
        if(item.isDirectory()){await visit(rel);continue;}
        if(!item.isFile())continue;
        const data=await fs.readFile(full);bytes+=data.length;
        if(bytes>2*1024*1024||files.length>=1000)throw new Error("组织技能包超过本机传输上限");
        files.push({path:entry.runtimeName+"/"+rel.split(path.sep).join("/"),data:data.toString("base64")});
      }
    }
    await visit("");
  }
  return files;
}
export async function executeOutbound(ctx:AdapterExecutionContext):Promise<AdapterExecutionResult> {
  const reason=String(ctx.context.wakeReason??ctx.context.reason??(ctx.context.paperclipWake as Record<string,unknown>|undefined)?.reason??"");
  // User messages go through the Harness decision relay, never another model.
  if(!reason.startsWith("本地研发人员主动启动交互会话；"))return {exitCode:0,signal:null,timedOut:false,usage:{inputTokens:0,outputTokens:0},usageBasis:"per_run",costUsd:0,resultJson:{dsp7_no_model_invocation:true},summary:"页面消息由本机接入桥处理；本次未调用模型。"};
  if(!ctx.authToken)throw new Error("本机执行缺少运行期凭证");
  const taskId=String(ctx.context.issueId??ctx.context.taskId??"");
  if(!/^[a-f0-9-]{36}$/.test(taskId))throw new Error("本机执行需要已登记的任务");
  const packet={runId:ctx.runId,agentId:ctx.agent.id,companyId:ctx.agent.companyId,taskId,reason,prompt:[renderPaperclipWakePrompt(ctx.context.paperclipWake),selectPaperclipTaskMarkdown(ctx.context),"按已登记的 Harness 流程执行。先 inspect、claim；不得绕过 Jira 审批与领域完成核验。"].filter(Boolean).join("\n\n"),skills:await skills(ctx.config),mcp:ctx.runtimeMcp?.getServers()??[]};
  await ctx.onCancellationReady?.();
  if(ctx.signal?.aborted)throw new Error("运行已取消");
  await ctx.onMeta?.({adapterType:"claude_local",command:"本机主动连接",commandNotes:["本机领取真实运行，沿用本机模型配置；不使用 SSH。"]});
  const outcome=await new Promise<AdapterExecutionResult>(resolve=>{
    const job:Job={ctx,packet,lease:null,lastSeen:Date.now(),sequence:0,dispatching:false,receipts:Promise.resolve(),resolve};jobs.set(ctx.runId,job);
    const timer=setInterval(()=>{
      const cancelled=ctx.signal?.aborted;
      // No blind replacement after connectivity loss. Local worker must stop
      // when the lease status cannot be renewed, before a human can retry.
      if(cancelled||Date.now()-job.lastSeen>(job.lease?90000:150000))job.resolve({exitCode:1,signal:null,timedOut:!cancelled,errorCode:"dsp7_local_connection_lost",errorMessage:cancelled?"运行已取消；本机将在下一次租约检查时停止，请核对停止状态":"本机连接丢失，保留状态；核对本机停止后才能重试",resultJson:{localStopRequiresVerification:true}});
    },1000);timer.unref();
    const settle=job.resolve;job.resolve=r=>{clearInterval(timer);settle(r);};
  });
  jobs.delete(ctx.runId);return outcome;
}

export async function outboundSkills(ctx:AdapterSkillContext) {
  const entries=await readPaperclipRuntimeSkillEntries(ctx.config,path.dirname(fileURLToPath(import.meta.url)));
  return buildRuntimeMountedSkillSnapshot({adapterType:"claude_local",availableEntries:entries,desiredSkills:resolveLegacyPaperclipDesiredSkillNames(ctx.config,entries),configuredDetail:"下一次本机运行领取后加载；本机 Harness 技能由本机工程提供。",externalInstalled:new Map(),externalLocationLabel:"本机",externalDetail:"本机技能不通过服务器文件系统扫描。",skillsHome:"本机运行目录"});
}
