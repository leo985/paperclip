import { and, desc, eq } from "drizzle-orm";
import { managedSessions, managedTaskFacts, issues, type Db } from "@paperclipai/db";
export async function recordManagedTaskTransition(db:Db, task:typeof issues.$inferSelect, previousStatus:string) {
  if(previousStatus===task.status||!task.description?.includes("DSP7-PILOT:")||!["done","cancelled"].includes(task.status))return;
  const [session]=await db.select().from(managedSessions).where(and(eq(managedSessions.companyId,task.companyId),eq(managedSessions.taskId,task.id))).orderBy(desc(managedSessions.startedAt)).limit(1);
  // No historical execution owner is guessed for work without a collected binding.
  if(!session)return;
  await db.insert(managedTaskFacts).values({companyId:task.companyId,taskId:task.id,seatId:session.seatId,ownerUserId:session.ownerUserId,kind:task.status==="done"?"delivered":"cancelled",at:task.status==="done"?task.completedAt??new Date():task.cancelledAt??new Date(),simulated:session.simulated}).onConflictDoNothing();
}
