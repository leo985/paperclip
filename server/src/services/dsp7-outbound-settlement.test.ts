import {randomUUID} from 'node:crypto';
import {describe,it,expect,vi} from 'vitest';
import {executeOutbound,outboundJob,receiveOutbound} from './dsp7-outbound.js';

describe('outbound original-result settlement',()=>{
 async function start(){
  const runId=randomUUID(),dispatchId=randomUUID();
  const result=executeOutbound({runId,agent:{id:randomUUID(),companyId:randomUUID()},context:{issueId:randomUUID(),harnessValidationDispatchId:dispatchId,wakeReason:'Harness 隔离验证授权启动；'+dispatchId},authToken:'isolated-test-placeholder',config:{},onMeta:vi.fn(),onCancellationReady:vi.fn(),onLog:vi.fn()} as any);
  await vi.waitFor(()=>expect(outboundJob(runId)).toBeDefined());
  return {runId,result,job:outboundJob(runId)!};
 }
 it('keeps the accepted original result when exit settlement races or repeats',async()=>{
  const {runId,result,job}=await start();
  const original={exitCode:0,signal:null,timedOut:false};
  await receiveOutbound(job,{sequence:1,result:original});
  expect(job.settled).toBe(true);
  job.resolve({exitCode:1,signal:null,timedOut:false,errorCode:'late_exit'});
  expect(await result).toEqual(original);expect(outboundJob(runId)).toBeUndefined();
 });
 it('retains a crash failure if a later result arrives after settlement',async()=>{
  const {result,job}=await start();
  const failure={exitCode:1,signal:null,timedOut:false,errorCode:'dsp7_validation_worker_exited'};
  job.resolve(failure);await receiveOutbound(job,{sequence:1,result:{exitCode:0,signal:null,timedOut:false}});
  expect(await result).toEqual(failure);
 });
});
