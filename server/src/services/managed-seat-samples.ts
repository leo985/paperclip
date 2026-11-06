import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { issues, managedSeatSamples, agents, type Db } from "@paperclipai/db";
import { seatOwnerId } from "../routes/dsp7-seat-owners.js";
export async function recordSeatSample(db:Db,agent:typeof agents.$inferSelect,state:string,taskId:string|null) {
  const [count]=await db.select({value:sql<number>`count(*)::int`}).from(issues).where(and(eq(issues.companyId,agent.companyId),eq(issues.assigneeAgentId,agent.id),inArray(issues.status,["backlog","todo","in_progress","blocked","in_review"]),sql`coalesce(${issues.description},'') not like '%明确模式：replay%'`));
  const ownerUserId=seatOwnerId(agent.adapterConfig.dsp7Seat as Record<string,unknown>),backlog=count?.value??0,now=new Date();
  const [last]=await db.select().from(managedSeatSamples).where(and(eq(managedSeatSamples.companyId,agent.companyId),eq(managedSeatSamples.seatId,agent.id))).orderBy(desc(managedSeatSamples.at)).limit(1);
  if(last&&last.ownerUserId===ownerUserId&&last.state===state&&last.taskId===taskId&&last.backlog===backlog&&now.getTime()-last.through.getTime()<90000){
    await db.update(managedSeatSamples).set({through:now}).where(eq(managedSeatSamples.id,last.id));
  }else await db.insert(managedSeatSamples).values({companyId:agent.companyId,seatId:agent.id,ownerUserId,state,taskId,backlog,at:now,through:now});
}
