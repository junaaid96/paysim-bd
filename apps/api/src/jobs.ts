// Persisted job queue (dumb storage; the Scheduler in scheduler.ts owns
// timers and execution). Payloads are zod-validated at both ends so a
// corrupt row fails its own job loudly instead of crashing the loop.

import { and, asc, eq, inArray, lte, or, sql } from 'drizzle-orm';
import { z } from 'zod';

import { ScenarioStepSchema } from '@paysim/core';

import type { Db } from './db/client.js';
import { jobs, type Job } from './db/schema.js';

export const JOB_TYPES = ['scenario-step', 'session-expiry', 'delivery-retry'] as const;
export type JobType = (typeof JOB_TYPES)[number];

export const JobTypeSchema = z.enum(JOB_TYPES);

export const ScenarioStepPayloadSchema = z.object({
  txnId: z.string().min(1),
  scenarioId: z.string().nullable(),
  scenarioName: z.string().min(1),
  source: z.string().min(1),
  stepIndex: z.number().int().min(0),
  /** Steps snapshotted when the scenario started (later edits don't apply). */
  steps: z.array(ScenarioStepSchema),
});
export type ScenarioStepPayload = z.infer<typeof ScenarioStepPayloadSchema>;

export const SessionExpiryPayloadSchema = z.object({ txnId: z.string().min(1) });
export type SessionExpiryPayload = z.infer<typeof SessionExpiryPayloadSchema>;

export const DeliveryRetryPayloadSchema = z.object({
  txnId: z.string().min(1),
  kind: z.string().min(1),
  targetUrl: z.string().min(1),
  payload: z.record(z.string(), z.string()),
  /** The attempt number this retry will perform (first attempt is 1). */
  attempt: z.number().int().min(2),
});
export type DeliveryRetryPayload = z.infer<typeof DeliveryRetryPayloadSchema>;

export interface ScheduleJobInput {
  workspaceId: string;
  transactionId?: string | null;
  type: JobType;
  payload: Record<string, unknown>;
  runAt: Date;
}

export async function scheduleJob(db: Db, input: ScheduleJobInput): Promise<Job> {
  const rows = await db
    .insert(jobs)
    .values({
      workspaceId: input.workspaceId,
      transactionId: input.transactionId ?? null,
      type: input.type,
      payload: input.payload,
      runAt: input.runAt,
    })
    .returning();
  const row = rows[0];
  if (!row) throw new Error('Failed to insert job');
  return row;
}

/** Claim up to `limit` due jobs (single scheduler; SKIP LOCKED for safety). */
export async function claimDueJobs(db: Db, now: Date, limit = 25): Promise<Job[]> {
  return db.transaction(async (tx) => {
    const due = await tx
      .select()
      .from(jobs)
      .where(and(eq(jobs.status, 'pending'), lte(jobs.runAt, now)))
      .orderBy(asc(jobs.runAt))
      .limit(limit)
      .for('update', { skipLocked: true });
    const claimed: Job[] = [];
    for (const row of due) {
      const updated = await tx
        .update(jobs)
        .set({ status: 'running', attempts: sql`${jobs.attempts} + 1` })
        .where(eq(jobs.id, row.id))
        .returning();
      const next = updated[0];
      if (next) claimed.push(next);
    }
    return claimed;
  });
}

export async function markJobDone(db: Db, id: string): Promise<void> {
  await db.update(jobs).set({ status: 'done' }).where(eq(jobs.id, id));
}

export async function markJobFailed(db: Db, id: string, error: string): Promise<void> {
  await db.update(jobs).set({ status: 'failed', lastError: error }).where(eq(jobs.id, id));
}

/** Crash recovery: jobs stuck in `running` become pending again on boot. */
export async function reclaimRunningJobs(db: Db): Promise<number> {
  const rows = await db
    .update(jobs)
    .set({ status: 'pending' })
    .where(eq(jobs.status, 'running'))
    .returning({ id: jobs.id });
  return rows.length;
}

export async function cancelPendingJobsForTxn(
  db: Db,
  transactionId: string,
  types?: JobType[],
): Promise<number> {
  const conditions = [eq(jobs.transactionId, transactionId), eq(jobs.status, 'pending')];
  if (types && types.length > 0) conditions.push(inArray(jobs.type, [...types]));
  const rows = await db
    .update(jobs)
    .set({ status: 'cancelled' })
    .where(and(...conditions))
    .returning({ id: jobs.id });
  return rows.length;
}

export async function hasPendingJob(
  db: Db,
  transactionId: string,
  type: JobType,
): Promise<boolean> {
  const rows = await db
    .select({ id: jobs.id })
    .from(jobs)
    .where(
      and(
        eq(jobs.transactionId, transactionId),
        eq(jobs.type, type),
        or(eq(jobs.status, 'pending'), eq(jobs.status, 'running')),
      ),
    )
    .limit(1);
  return rows.length > 0;
}

/** Earliest pending run_at, or null when the queue is empty (disarm). */
export async function nextPendingRunAt(db: Db): Promise<Date | null> {
  const rows = await db
    .select({ runAt: jobs.runAt })
    .from(jobs)
    .where(eq(jobs.status, 'pending'))
    .orderBy(asc(jobs.runAt))
    .limit(1);
  return rows[0]?.runAt ?? null;
}

/** True when any pending job is already due (cheap kick check). */
export async function hasDueJobs(db: Db, now: Date): Promise<boolean> {
  const rows = await db
    .select({ id: jobs.id })
    .from(jobs)
    .where(and(eq(jobs.status, 'pending'), lte(jobs.runAt, now)))
    .limit(1);
  return rows.length > 0;
}

/**
 * Shift pending fake-timeline jobs when the workspace clock jumps by
 * deltaMs (forward jumps make jobs due sooner). Delivery retries are
 * wall-clock by design and are never shifted — pass only scenario and
 * expiry types here.
 */
export async function shiftPendingJobs(
  db: Db,
  workspaceId: string,
  deltaMs: number,
  types: JobType[],
): Promise<number> {
  if (deltaMs === 0 || types.length === 0) return 0;
  const rows = await db
    .update(jobs)
    .set({ runAt: sql`${jobs.runAt} - (${deltaMs} * INTERVAL '1 millisecond')` })
    .where(
      and(
        eq(jobs.workspaceId, workspaceId),
        eq(jobs.status, 'pending'),
        inArray(jobs.type, [...types]),
      ),
    )
    .returning({ id: jobs.id });
  return rows.length;
}
