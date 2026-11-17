import { describe, expect, it, vi } from "vitest";
import type { AdapterExecutionContext } from "../adapters/types.js";
import { executeOutbound, pendingOutbound, claimOutbound, receiveOutbound } from "./dsp7-outbound.js";

describe("validation preparation cannot fall through to legacy outbound", () => {
  it("uses a distinct packet without organization skills, MCP or issue prompt execution", async () => {
    const marker="10000000-0000-4000-8000-000000000001",taskId="10000000-0000-4000-8000-000000000002";
    const ctx={runId:"run",agent:{id:"seat",companyId:"company"},authToken:"runtime-only-fixture",config:{},
      context:{harnessValidationDispatchId:marker,issueId:taskId,wakeReason:"Harness 隔离验证授权启动；"+marker},
      onMeta:vi.fn(),onCancellationReady:vi.fn(),onDispatch:vi.fn(),onLog:vi.fn()};
    const result=executeOutbound(ctx as unknown as AdapterExecutionContext);
    await vi.waitFor(()=>expect(pendingOutbound("seat")).toBeDefined());
    const job=pendingOutbound("seat")!;
    expect(job.packet).toMatchObject({executionKind:"validation",harnessValidationDispatchId:marker,skills:[],mcp:[]});
    const packet=await claimOutbound(job);expect(packet.lease).toBeTruthy();
    await receiveOutbound(job,{sequence:1,result:{exitCode:0,signal:null,timedOut:false}});
    expect((await result).exitCode).toBe(0);expect(pendingOutbound("seat")).toBeUndefined();
  });
  it.each(["dispatch-id", "", null])( "rejects a validation marker %j before registering a job or notifying dispatch", async marker => {
    const onDispatch = vi.fn(), onMeta = vi.fn();
    const result = await executeOutbound({ agent: { id: "seat" }, context: {
      harnessValidationDispatchId: marker, wakeReason: "本地研发人员主动启动交互会话；legacy",
    }, onDispatch, onMeta } as unknown as AdapterExecutionContext);
    expect(result).toMatchObject({ exitCode: 1, errorCode: "harness_validation_dispatch_pending", resultJson: { dsp7_no_model_invocation: true } });
    expect(pendingOutbound("seat")).toBeUndefined();
    expect(onDispatch).not.toHaveBeenCalled(); expect(onMeta).not.toHaveBeenCalled();
  });
});
