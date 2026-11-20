import { and, asc, desc, eq, inArray, isNull } from "drizzle-orm";
import { agents, authUsers, companyMemberships, deliverySnapshots, deliveryWorkflows, personnelPeople, projects, type Db } from "@paperclipai/db";
import type { SeatMonthlyReport } from "@paperclipai/shared";
import { seatOwnerId } from "../routes/dsp7-seat-owners.js";
import { isCancelledJiraDeliveryStatus, isCompletedJiraDeliveryStatus } from "./delivery-intake.js";

type Seat = typeof agents.$inferSelect;
type ReportSeat = Pick<Seat, "id" | "adapterConfig">;
type Snapshot = Pick<typeof deliverySnapshots.$inferSelect, "id" | "projectId" | "demandNo" | "collectedAt" | "plan"> & { projectName: string };
type Workflow = Pick<typeof deliveryWorkflows.$inferSelect, "projectId" | "demandNo" | "stages">;
const dayMs = 86_400_000;
const assignmentKey = (origin: string, account: string) => JSON.stringify([origin, account]);

function append<K>(index: Map<K, Set<string>>, key: K, value: string) {
  const matches = index.get(key) ?? new Set<string>();
  matches.add(value);
  index.set(key, matches);
}

function reportSeatOwners(seats: ReportSeat[], directory: { username: string | null; userId: string | null }[]) {
  const accounts = new Map<string, Set<string>>();
  const seatsByOwner = new Map<string, Set<string>>();
  const ownersByUsername = new Map<string, Set<string>>();
  for (const seat of seats) {
    const owner = seatOwnerId(seat.adapterConfig.dsp7Seat as Record<string, unknown>);
    if (!owner) continue;
    append(seatsByOwner, owner, seat.id);
    const rule = seat.adapterConfig.dsp7JiraDispatch as {
      ownerUserId?: string; jiraAccountOwnerUserId?: string; jiraSecretId?: string; jiraBaseUrl?: string; jiraAssignee?: string;
    } | undefined;
    // A seat transfer revokes the former owner's Jira credential and keeps
    // the old account string in the disabled rule for the setup form.
    if (rule?.ownerUserId !== owner || (rule.jiraAccountOwnerUserId ?? (rule.jiraSecretId ? rule.ownerUserId : null)) !== owner ||
      !rule.jiraBaseUrl || !rule.jiraAssignee) continue;
    const url = URL.parse(rule.jiraBaseUrl);
    if (!url) continue;
    append(accounts, assignmentKey(url.origin, rule.jiraAssignee), owner);
  }
  for (const { username, userId } of directory) {
    if (username && userId && seatsByOwner.has(userId)) append(ownersByUsername, username, userId);
  }
  return (origin: string, account: string) => {
    const owners = new Set([...(accounts.get(assignmentKey(origin, account)) ?? []), ...(ownersByUsername.get(account) ?? [])]);
    if (owners.size !== 1) return [];
    return [...(seatsByOwner.get(owners.values().next().value!) ?? [])];
  };
}

export function collectSeatMonthlyIssues(
  snapshots: Snapshot[],
  workflows: Workflow[],
  registeredSeats: ReportSeat[],
  visibleSeatIds: Set<string>,
  manager: boolean,
  month: string,
  today: string,
  directory: { username: string | null; userId: string | null }[] = [],
): SeatMonthlyReport["issues"] {
  const soon = new Date(Date.parse(today) + 7 * dayMs).toISOString().slice(0, 10);
  const workflowsByDemand = new Map(workflows.map(flow => [`${flow.projectId}:${flow.demandNo}`, flow.stages]));
  const registered = new Set(registeredSeats.map(seat => seat.id));
  const seatsForJiraAccount = reportSeatOwners(registeredSeats, directory);
  const issues = new Map<string, SeatMonthlyReport["issues"][number]>();
  const seen = new Set<string>();

  // The caller supplies snapshots in descending collection order. The latest
  // evidence for a repeated Jira key determines its month and status.
  for (const snapshot of snapshots) {
    const { projectId, demandNo, plan } = snapshot;
    const stages = workflowsByDemand.get(`${projectId}:${demandNo}`) ?? [];
    const projection = plan.monthlyChildIssues;
    for (const item of plan.items) {
      if (!item.parentKey) continue;
      const id = `${projectId}:${item.key}`;
      if (seen.has(id)) continue;
      seen.add(id);
      const fact = projection?.issues[item.key];
      const status = item.status;
      if (fact?.cancelled ?? isCancelledJiraDeliveryStatus(status)) continue;
      const completed = fact?.done ?? isCompletedJiraDeliveryStatus(status);
      const dueDate = fact?.dueDate ?? null;
      const inMonth = plan.reportMonths ? plan.reportMonths.includes(month) : Boolean(dueDate?.startsWith(month + "-"));
      if (!inMonth && (dueDate || plan.reportMonths)) continue;

      const childStages = stages.filter(stage =>
        stage.jiraKey === item.key && (!stage.parentKey || stage.parentKey === item.parentKey),
      );
      const stageSeats = childStages.filter(stage => stage.executionMode !== "human" && registered.has(stage.seatId))
        .map(stage => stage.seatId);
      const matches = projection?.jiraOrigin && fact
        ? [fact.account, fact.ownerAccount].flatMap(account => account ? seatsForJiraAccount(projection.jiraOrigin!, account) : [])
        : [];
      const seatIds = [...new Set([...stageSeats, ...matches])].filter(seatId => visibleSeatIds.has(seatId));
      if (!manager && !seatIds.length) continue;

      const risk = !dueDate ? "unscheduled" : completed ? "done" :
        dueDate < today ? "overdue" : dueDate <= soon ? "due_soon" : "on_track";
      issues.set(id, {
        id, key: item.key, parentKey: item.parentKey, issueType: item.type, jiraAssignee: item.assignee || undefined, title: item.title, status,
        projectId, projectName: snapshot.projectName, demandNo, snapshotId: snapshot.id,
        collectedAt: snapshot.collectedAt.toISOString(), dueDate,
        deadlineSource: fact?.deadlineSource ?? null, seatIds, risk, completed, inMonth,
        interrupted: !completed && childStages.some(stage => stage.state === "interrupted"),
      });
    }
  }
  return [...issues.values()];
}

export async function readSeatMonthlyReport(
  db: Db, companyId: string, month: string, manager: boolean, userId?: string | null,
): Promise<SeatMonthlyReport> {
  const [allSeats, latest, workflows] = await Promise.all([
    db.select().from(agents).where(eq(agents.companyId, companyId)).orderBy(asc(agents.name), asc(agents.id)),
    db.selectDistinctOn([deliverySnapshots.projectId, deliverySnapshots.sourceOrigin, deliverySnapshots.demandNo], {
      id: deliverySnapshots.id, projectId: deliverySnapshots.projectId, demandNo: deliverySnapshots.demandNo,
      plan: deliverySnapshots.plan, collectedAt: deliverySnapshots.collectedAt, projectName: projects.name,
    }).from(deliverySnapshots)
      .innerJoin(projects, and(eq(projects.id, deliverySnapshots.projectId), eq(projects.companyId, companyId)))
      .where(and(eq(deliverySnapshots.companyId, companyId), isNull(projects.archivedAt)))
      .orderBy(deliverySnapshots.projectId, deliverySnapshots.sourceOrigin, deliverySnapshots.demandNo,
        desc(deliverySnapshots.collectedAt), desc(deliverySnapshots.createdAt), desc(deliverySnapshots.id)),
    db.select({
      projectId: deliveryWorkflows.projectId, demandNo: deliveryWorkflows.demandNo, stages: deliveryWorkflows.stages,
    }).from(deliveryWorkflows).where(and(eq(deliveryWorkflows.companyId, companyId),
      inArray(deliveryWorkflows.state, ["active", "blocked", "acceptance", "completed"]))),
  ]);
  const registered = allSeats.filter(seat => seat.adapterConfig.dsp7WebJiraIntake === true && seat.adapterConfig.dsp7Seat);
  const seatConfig = (seat: Seat) => seat.adapterConfig.dsp7Seat as Record<string, unknown>;
  const visible = registered.filter(seat => manager || Boolean(userId && seatOwnerId(seatConfig(seat)) === userId));
  const ownerIds = [...new Set(visible.map(seat => seatOwnerId(seatConfig(seat))).filter((id): id is string => !!id))];
  const registeredOwnerIds = [...new Set(registered.map(seat => seatOwnerId(seatConfig(seat))).filter((id): id is string => !!id))];
  const [owners, directory] = await Promise.all([
    ownerIds.length ? db.select({ id: authUsers.id, name: authUsers.name }).from(authUsers).where(inArray(authUsers.id, ownerIds)) : [],
    registeredOwnerIds.length ? db.select({ username: personnelPeople.username, userId: personnelPeople.userId })
      .from(personnelPeople).innerJoin(companyMemberships, and(eq(companyMemberships.principalId, personnelPeople.userId),
        eq(companyMemberships.principalType, "user"), eq(companyMemberships.companyId, companyId), eq(companyMemberships.status, "active")))
      .where(and(eq(personnelPeople.active, true), inArray(personnelPeople.userId, registeredOwnerIds))) : [],
  ]);
  const names = new Map(owners.map(owner => [owner.id, owner.name]));
  const asOf = new Date().toISOString();
  const today = new Date(Date.parse(asOf) + 8 * 3_600_000).toISOString().slice(0, 10);
  latest.sort((a, b) => b.collectedAt.getTime() - a.collectedAt.getTime());

  return {
    month, asOf,
    seats: visible.map(seat => ({
      id: seat.id,
      name: String(seatConfig(seat).name ?? seat.name),
      ownerName: names.get(seatOwnerId(seatConfig(seat)) ?? "") ?? null,
      ownerUserId: seatOwnerId(seatConfig(seat)),
    })),
    issues: collectSeatMonthlyIssues(latest, workflows, registered, new Set(visible.map(seat => seat.id)), manager, month, today, directory),
  };
}
