import { randomUUID } from "node:crypto";
import { and, eq, isNull, sql } from "drizzle-orm";
import { activityLog, deliveryConnections, projects, type Db } from "@paperclipai/db";
import type { DeliveryMonthlySyncRun, DeliveryMonthlySyncSchedule, DeliveryMonthlySyncState } from "@paperclipai/shared";
import { conflict } from "../errors.js";
import { createDeliverySourceOperations } from "./delivery-source-operations.js";

const dayMs = 86_400_000;
const shanghaiOffset = 8 * 3_600_000;
// One source read has bounded network calls. The lease is reset before each
// item and its identity is checked again in the snapshot commit transaction.
const leaseMs = 10 * 60_000;
const entityType = "delivery_connection";
const schedulerActor = { type: "system", id: "delivery-monthly-scheduler" } as const;
const defaultSchedule: DeliveryMonthlySyncSchedule = {
  enabled: false, time: "06:00", timezone: "Asia/Shanghai", nextRunAt: null, lastRun: null,
};

export const monthlySyncTimePattern = /^(?:[01]\d|2[0-3]):[0-5]\d$/;

export function nextDeliveryMonthlySync(time: string, now: Date): string {
  const localDate = new Date(now.getTime() + shanghaiOffset).toISOString().slice(0, 10);
  const scheduled = Date.parse(`${localDate}T${time}:00+08:00`);
  return new Date(scheduled <= now.getTime() ? scheduled + dayMs : scheduled).toISOString();
}

export function publicDeliveryMonthlySchedule(state: DeliveryMonthlySyncState | null): DeliveryMonthlySyncSchedule {
  if (!state) return defaultSchedule;
  const { leaseUntil: _lease, ...value } = state;
  return value;
}

export async function saveDeliveryMonthlySchedule(
  db: Db, companyId: string, projectId: string, settings: { enabled: boolean; time: string }, userId: string,
  source: Pick<ReturnType<typeof createDeliverySourceOperations>, "project" | "projectJira">,
) {
  return db.transaction(async transaction => {
    const tx = transaction as unknown as Db;
    await source.project(companyId, projectId, tx);
    const [row] = await tx.select().from(deliveryConnections).where(and(
      eq(deliveryConnections.companyId, companyId), eq(deliveryConnections.projectId, projectId),
    )).for("update");
    if (!row) throw conflict("请先配置项目来源");
    if (settings.enabled) await source.projectJira(companyId, row, tx, true);
    const previous = row.monthlySync;
    if (previous?.enabled === settings.enabled && previous.time === settings.time) return publicDeliveryMonthlySchedule(previous);
    const now = new Date();
    const running = previous?.lastRun;
    const value: DeliveryMonthlySyncState = {
      ...(previous ?? defaultSchedule), ...settings,
      nextRunAt: settings.enabled ? nextDeliveryMonthlySync(settings.time, now) : null,
      ...(!settings.enabled && running?.status === "running" ? {
        leaseUntil: undefined,
        lastRun: {
          ...running, status: "interrupted", finishedAt: now.toISOString(),
          message: "已关闭定时同步，已保存的条目仍可查看。",
        },
      } : {}),
    };
    await tx.update(deliveryConnections).set({ monthlySync: value }).where(eq(deliveryConnections.id, row.id));
    await tx.insert(activityLog).values({
      companyId, actorType: "user", actorId: userId, action: "delivery.monthly_sync.schedule_updated",
      entityType, entityId: row.id, details: { projectId, ...settings, nextRunAt: value.nextRunAt },
    });
    return publicDeliveryMonthlySchedule(value);
  });
}

type Source = Pick<ReturnType<typeof createDeliverySourceOperations>, "monthly" | "sync">;
type Connection = typeof deliveryConnections.$inferSelect;
type Claim = { row: Connection; run: DeliveryMonthlySyncRun };
const leaseExpiry = (now: Date) => new Date(now.getTime() + leaseMs).toISOString();
const due = (state: DeliveryMonthlySyncState, now: string) => state.enabled && state.nextRunAt !== null && state.nextRunAt <= now;
const expired = (state: DeliveryMonthlySyncState, now: string) => state.lastRun?.status === "running" && (!state.leaseUntil || state.leaseUntil <= now);

function ownsRun(row: Connection, runId: string, now: string) {
  const state = row.monthlySync;
  return !!state && state.enabled && state.lastRun?.id === runId && state.lastRun.status === "running" &&
    !!state.leaseUntil && state.leaseUntil > now;
}

export function createDeliveryMonthlyScheduler(db: Db, source: Source, clock = () => new Date()) {
  async function claim(): Promise<Claim | null> {
    const now = clock(), iso = now.toISOString();
    return db.transaction(async tx => {
      const [row] = await tx.select({ connection: deliveryConnections }).from(deliveryConnections)
        .innerJoin(projects, and(eq(projects.id, deliveryConnections.projectId), eq(projects.companyId, deliveryConnections.companyId)))
        .where(and(isNull(projects.archivedAt), sql`(
          (${deliveryConnections.monthlySync}->'lastRun'->>'status' = 'running'
           AND coalesce(${deliveryConnections.monthlySync}->>'leaseUntil', '') <= ${iso})
          OR (${deliveryConnections.monthlySync}->>'enabled' = 'true'
           AND ${deliveryConnections.monthlySync}->>'nextRunAt' <= ${iso}
           AND ${deliveryConnections.monthlySync}->'lastRun'->>'status' IS DISTINCT FROM 'running')
        )`)).orderBy(sql`${deliveryConnections.monthlySync}->>'nextRunAt' nulls last`, deliveryConnections.id)
        .limit(1).for("update", { of: deliveryConnections, skipLocked: true });
      const selected = row?.connection, state = selected?.monthlySync;
      if (!selected || !state) return null;
      if (expired(state, iso) && state.lastRun) {
        await tx.update(deliveryConnections).set({ monthlySync: {
          ...state, leaseUntil: undefined, lastRun: {
            ...state.lastRun, status: "interrupted", finishedAt: iso, message: "上次运行中断，已保存的条目仍可查看。",
          },
        } }).where(eq(deliveryConnections.id, selected.id));
        return null;
      }
      if (!due(state, iso)) return null;
      const run: DeliveryMonthlySyncRun = {
        id: randomUUID(), month: new Date(now.getTime() + shanghaiOffset).toISOString().slice(0, 7),
        status: "running", startedAt: iso, finishedAt: null, total: null, succeeded: 0, failed: 0, message: null,
      };
      await tx.update(deliveryConnections).set({ monthlySync: {
        ...state, nextRunAt: nextDeliveryMonthlySync(state.time, now), leaseUntil: leaseExpiry(now), lastRun: run,
      } }).where(eq(deliveryConnections.id, selected.id));
      return { row: selected, run };
    });
  }

  async function checkpoint(task: Claim, run: DeliveryMonthlySyncRun) {
    return db.transaction(async tx => {
      const [current] = await tx.select().from(deliveryConnections)
        .where(and(eq(deliveryConnections.id, task.row.id), eq(deliveryConnections.companyId, task.row.companyId))).for("update");
      const state = current?.monthlySync, now = clock();
      if (!current || !state || state.lastRun?.id !== run.id || state.lastRun.status !== "running") return false;
      const authorized = current.revision === task.row.revision && ownsRun(current, run.id, now.toISOString());
      if (!authorized && run.status === "running") return false;
      if (!authorized) {
        run.status = "interrupted";
        run.message = "同步已中断，已保存的条目仍可查看。";
      }
      await tx.update(deliveryConnections).set({ monthlySync: {
        ...state, leaseUntil: run.status === "running" ? leaseExpiry(now) : undefined, lastRun: run,
      } }).where(eq(deliveryConnections.id, current.id));
      return true;
    });
  }

  return async function sweep(shouldStop = () => false) {
    if (shouldStop()) return;
    const task = await claim();
    if (!task) return;
    const { row, run } = task;
    const input = { projectId: row.projectId, expectedRevision: row.revision };
    try {
      if (shouldStop()) {
        await checkpoint(task, { ...run, status: "interrupted", finishedAt: clock().toISOString(), message: "同步已中断。" });
        return;
      }
      const { result } = await source.monthly(row.companyId, { ...input, month: run.month, forceRefresh: true });
      const keys = [...new Set(result.items.map(item => item.demandNo))];
      run.total = keys.length;
      for (const demandNo of keys) {
        if (shouldStop() || !await checkpoint(task, run)) {
          run.status = "interrupted";
          run.message = "同步已中断，已保存的条目仍可查看。";
          break;
        }
        try {
          await source.sync(row.companyId, { ...input, demandNo, months: [run.month] }, "sync", schedulerActor,
            current => !shouldStop() && ownsRun(current, run.id, clock().toISOString()));
          run.succeeded++;
        } catch {
          run.failed++;
        }
      }
      if (run.status === "running") {
        run.status = run.failed === 0 ? "succeeded" : run.succeeded > 0 ? "partial" : "failed";
        if (run.status === "partial") run.message = "部分条目同步失败，可在月度条目中手动重试。";
        if (run.status === "failed") run.message = "条目同步失败，可在月度条目中手动重试。";
      }
    } catch {
      run.status = "failed";
      run.message = "无法读取月度清单，请检查轻舟与 Jira 来源配置。";
    }
    if (shouldStop()) {
      run.status = "interrupted";
      run.message = "同步已中断，已保存的条目仍可查看。";
    }
    run.finishedAt = clock().toISOString();
    await checkpoint(task, run);
  };
}
