import { describe,it,expect } from "vitest";
import { isSeatOnline,commandState,seatPolicySchema } from "../routes/dsp7-seat-control.js";
describe("DSP7 seat runtime contracts",()=>{
 it("derives online status from server heartbeat age, not Agent idle",()=>{
  const now=Date.parse("2026-10-07T03:00:00Z");
  expect(isSeatOnline(undefined,now)).toBe(false);
  expect(isSeatOnline({lastSeenAt:"garbage"},now)).toBe(false);
  expect(isSeatOnline({lastSeenAt:"2026-10-07T02:58:30Z"},now)).toBe(false);
  expect(isSeatOnline({lastSeenAt:"2026-10-07T02:59:00Z"},now)).toBe(true);
  expect(isSeatOnline({lastSeenAt:"2026-10-07T04:00:00Z"},now)).toBe(false);
 });
 it("uses monotonic receipt sequence regardless of query ordering",()=>{
  const request={commandId:"x",expiresAt:"2026-10-08T00:00:00Z"};
  const events=[{details:{commandId:"x",sequence:2,status:"running",message:"visible"}},{details:{commandId:"x",sequence:1,status:"accepted"}},{details:{commandId:"other",sequence:100,status:"failed"}}];
  expect(commandState(request,events,0)).toMatchObject({status:"running",sequence:2,message:"visible"});
 });
 it("expires waiting requests without expiring an already connected runtime",()=>{
  const request={commandId:"x",expiresAt:"2020-01-01T00:00:00Z"};
  expect(commandState(request,[])).toMatchObject({status:"expired"});
  expect(commandState(request,[{details:{commandId:"x",sequence:1,status:"awaiting_local"}}])).toMatchObject({status:"expired"});
  expect(commandState(request,[{details:{commandId:"x",sequence:2,status:"running"}}])).toMatchObject({status:"running"});
  expect(commandState(request,[{details:{commandId:"x",sequence:3,status:"cancelled"}}])).toMatchObject({status:"cancelled"});
 });
 it("rejects invalid policy scope and escalation intervals",()=>{
  const base={mode:"notify",jiraKeys:["ATSES-493499"],reminderMinutes:10,escalationMinutes:30};
  expect(seatPolicySchema.safeParse(base).success).toBe(true);
  expect(seatPolicySchema.safeParse({...base,dingtalk:{userId:"0704296864843839",profile:"corp:sender"}}).success).toBe(true);
  expect(seatPolicySchema.safeParse({...base,dingtalk:{userId:"0704296864843839",profile:""}}).success).toBe(false);
  expect(seatPolicySchema.safeParse({...base,jiraKeys:["arbitrary shell"]}).success).toBe(false);
  expect(seatPolicySchema.safeParse({...base,escalationMinutes:5}).success).toBe(false);
  expect(seatPolicySchema.safeParse({...base,extra:"secret"}).success).toBe(false);
 });
});
