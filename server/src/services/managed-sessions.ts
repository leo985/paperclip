import { createHash } from "node:crypto";
import { and, asc, eq, inArray, lt, isNull } from "drizzle-orm";
import { managedEvents, managedSessions, managedContents, managedParts, type Db } from "@paperclipai/db";
import type { ManagedTimelineEvent } from "@paperclipai/shared";

export const digest = (value: unknown) => createHash("sha256").update(typeof value === "string" ? value : JSON.stringify(value)).digest("hex");
// Same baseline as the client. It is a second check, not a promise of universal DLP.
export function containsCredential(value: string) {
  return /(?:sk-ant-|sk-proj-|ghp_|glpat-)[A-Za-z0-9_-]{10,}|Bearer\s+[A-Za-z0-9._~+\/-]{10,}|-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/i.test(value)
    || /(?:api[_-]?key|appsecret|access[_-]?token|password|passwd|authorization|secret|pat[_-]?token)["']?\s*[:=]\s*["']?(?!\[REDACTED\])[^\s"',;}]{5,}/i.test(value);
}
export async function contentBody(db: Db, sessionId: string, content: typeof managedContents.$inferSelect) {
  const parts = await db.select().from(managedParts).where(and(eq(managedParts.sessionId,sessionId),eq(managedParts.streamId,content.streamId),eq(managedParts.contentId,content.contentId),eq(managedParts.revision,content.revision))).orderBy(asc(managedParts.partIndex));
  const manifest = content.manifest as {parts:number;bytes:number;sha256:string};
  if (parts.length !== manifest.parts || parts.some((p,i)=>p.partIndex!==i)) return null;
  const body = Buffer.concat(parts.map(p=>Buffer.from(p.data,p.encoding==="base64"?"base64":"utf8")));
  return body.length===manifest.bytes && createHash("sha256").update(body).digest("hex")===manifest.sha256 ? body : null;
}
export type TimedState = {state:string; start:number; end:number};
export function executionIntervals(session: {startedAt:Date;endedAt:Date|null}, events: ManagedTimelineEvent[], now=Date.now()): TimedState[] {
  const start=session.startedAt.getTime(), end=Math.min(session.endedAt?.getTime()??now,now);
  const ordered=events.filter(e=>e.eventType==="execution").sort((a,b)=>Date.parse(a.occurredAt)-Date.parse(b.occurredAt));
  let position=start, state="unknown", validUntil=start;
  const intervals:TimedState[]=[];
  const add=(until:number)=>{
    const boundary=Math.min(until,validUntil);
    if(boundary>position)intervals.push({state,start:position,end:boundary});
    if(until>Math.max(position,boundary))intervals.push({state:"unknown",start:Math.max(position,boundary),end:until});
    position=until;
  };
  for(const event of ordered){
    const at=Date.parse(event.occurredAt), observed=Date.parse(event.observedAt);
    if(!Number.isFinite(at)||at<start||at>end||at<position)continue;
    add(at);
    state=["executing","waiting"].includes(String(event.payload.state))&&Math.abs(at-observed)<300000?String(event.payload.state):"unknown";
    // Repeated explicit state observations renew a short evidence window.
    validUntil=at+90000;
  }
  add(end);return intervals;
}
export function unionMs(intervals:Array<{start:number;end:number}>, from:number,to:number) {
  const sorted=intervals.map(i=>({start:Math.max(from,i.start),end:Math.min(to,i.end)})).filter(i=>i.end>i.start).sort((a,b)=>a.start-b.start);
  let sum=0,last=-Infinity;for(const i of sorted){sum+=Math.max(0,i.end-Math.max(last,i.start));last=Math.max(last,i.end);}return sum;
}
export function timingFor(session:{startedAt:Date;endedAt:Date|null},events:ManagedTimelineEvent[]) {
  const now=Date.now(), intervals=executionIntervals(session,events,now),from=session.startedAt.getTime(),to=session.endedAt?.getTime()??now;
  const executingMs=unionMs(intervals.filter(i=>i.state==="executing"),from,to), waitingMs=unionMs(intervals.filter(i=>i.state==="waiting"),from,to),elapsedMs=Math.max(0,to-from);
  const last=intervals.at(-1);
  return {executingMs,waitingMs,elapsedMs,unknownMs:Math.max(0,elapsedMs-executingMs-waitingMs),coverage:elapsedMs?(executingMs+waitingMs)/elapsedMs:0,state:session.endedAt?"ended":last?.state??"unknown",since:last?new Date(last.start).toISOString():null};
}
export async function timelineFor(db:Db, sessionId:string) {
  const rows=await db.select({id:managedEvents.id,eventType:managedEvents.eventType,occurredAt:managedEvents.occurredAt,observedAt:managedEvents.observedAt,payload:managedEvents.payload}).from(managedEvents).where(and(eq(managedEvents.sessionId,sessionId),inArray(managedEvents.eventType,["phase","execution","lifecycle","coverage"])) ).orderBy(asc(managedEvents.occurredAt));
  return rows.map(e=>({...e,occurredAt:e.occurredAt.toISOString(),observedAt:e.observedAt.toISOString()}));
}
/** Bodies, projections and blobs share one retention boundary. Tombstones survive. */
export async function purgeSessionBodies(db:Db,sessionId:string) {
  await db.delete(managedParts).where(eq(managedParts.sessionId,sessionId));
  await db.delete(managedContents).where(eq(managedContents.sessionId,sessionId));
  await db.delete(managedEvents).where(and(eq(managedEvents.sessionId,sessionId),inArray(managedEvents.eventType,["content.part","content.manifest"])));
}
const retentionStates = new WeakMap<Db, { lastCompletedAt: number; inFlight?: Promise<void> }>();
/** Bounded background sweep; failures remain retryable and independent databases
 * never suppress each other's retention work. Full batches drain on the next tick. */
export function expireSessionBodies(db: Db): Promise<void> {
  let state = retentionStates.get(db);
  if (!state) {
    state = { lastCompletedAt: -Infinity };
    retentionStates.set(db, state);
  }
  if (state.inFlight) return state.inFlight;
  if (Date.now() - state.lastCompletedAt < 3_600_000) return Promise.resolve();
  const current = state;
  current.inFlight = db.transaction(async tx => {
    const old = await tx.select({ id: managedSessions.id }).from(managedSessions)
      .where(and(lt(managedSessions.startedAt, new Date(Date.now() - 90 * 86_400_000)), isNull(managedSessions.deletedAt)))
      .orderBy(asc(managedSessions.startedAt), asc(managedSessions.id))
      .limit(100).for("update", { skipLocked: true });
    for (const row of old) {
      await tx.update(managedSessions).set({ deletedAt: new Date(), syncState: "expired", lastObservation: {} })
        .where(eq(managedSessions.id, row.id));
      await purgeSessionBodies(tx as unknown as Db, row.id);
    }
    // Preserve content-free source identities and receipts to reject reuploads.
    if (old.length < 100) current.lastCompletedAt = Date.now();
  }).finally(() => { current.inFlight = undefined; });
  return current.inFlight;
}
