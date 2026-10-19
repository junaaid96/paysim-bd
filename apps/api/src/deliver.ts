// Callback delivery: one SSRF-guarded POST attempt per call, every
// attempt recorded, failures rescheduled with backoff. Retry timing is
// wall-clock (a down merchant does not recover on simulator-clock jumps);
// a clock jump may simply fire a pending retry early.

import {
  MAX_RESPONSE_SNIPPET_BYTES,
  truncateUtf8,
  type DeliverCallbackInput,
  type DeliveryRecord,
  type PluginLogger,
  type PluginStores,
  type TxnRecord,
} from '@paysim/core';

import { safePost } from './ssrf.js';

/** Attempts are numbered from 1; the first attempt runs synchronously. */
export const MAX_DELIVERY_ATTEMPTS = 6;
export const DELIVERY_TIMEOUT_MS = 10_000;

/** Backoff before attempt n (n >= 2): 2s, 4s, 8s, … capped at 5 minutes. */
export function backoffForAttempt(attempt: number): number {
  return Math.min(2 ** (attempt - 1), 300) * 1000;
}

export function shouldRetryAfterAttempt(attempt: number): boolean {
  return attempt < MAX_DELIVERY_ATTEMPTS;
}

export interface ScheduleRetryJob {
  workspaceId: string;
  transactionId: string;
  kind: string;
  targetUrl: string;
  payload: Record<string, string>;
  /** The attempt number the scheduled retry will perform. */
  attempt: number;
  runAt: Date;
}

export interface DeliverDeps {
  stores: PluginStores;
  logger: PluginLogger;
  allowPrivate: boolean;
  timeoutMs?: number;
  /** Persist a delivery-retry job and wake the scheduler (host-wired). */
  scheduleRetry: (job: ScheduleRetryJob) => Promise<void>;
}

export interface AttemptInput {
  txn: TxnRecord;
  kind: string;
  targetUrl: string;
  payload: Record<string, string>;
}

async function recordBlocked(
  deps: DeliverDeps,
  input: AttemptInput,
  body: string,
  error: string,
  latencyMs: number,
): Promise<DeliveryRecord> {
  deps.logger.warn('callback blocked by SSRF guard', {
    kind: input.kind,
    target: input.targetUrl,
    error,
  });
  const record = await deps.stores.recordDelivery({
    workspaceId: input.txn.workspaceId,
    transactionId: input.txn.id,
    kind: input.kind,
    targetUrl: input.targetUrl,
    status: 'blocked',
    latencyMs,
    requestBody: body,
    responseSnippet: `blocked: ${error}`,
  });
  await deps.stores.recordEvent({
    workspaceId: input.txn.workspaceId,
    transactionId: input.txn.id,
    type: 'callback.blocked',
    data: { kind: input.kind, targetUrl: input.targetUrl, error },
  });
  return record;
}

/**
 * Perform exactly one POST attempt and record it. Returns whether the
 * callback was delivered, and whether the failure (if any) is terminal.
 */
export async function attemptDelivery(
  deps: DeliverDeps,
  input: AttemptInput,
): Promise<{ record: DeliveryRecord; delivered: boolean; terminal: boolean }> {
  const body = new URLSearchParams(input.payload).toString();
  const result = await safePost(
    { url: input.targetUrl, body },
    { allowPrivate: deps.allowPrivate, timeoutMs: deps.timeoutMs ?? DELIVERY_TIMEOUT_MS },
  );
  if (!result.ok) {
    if (result.blocked) {
      const record = await recordBlocked(deps, input, body, result.error, result.latencyMs);
      return { record, delivered: false, terminal: true };
    }
    deps.logger.warn('callback delivery failed', {
      kind: input.kind,
      target: input.targetUrl,
      error: result.error,
    });
    const record = await deps.stores.recordDelivery({
      workspaceId: input.txn.workspaceId,
      transactionId: input.txn.id,
      kind: input.kind,
      targetUrl: input.targetUrl,
      status: 'failed',
      latencyMs: result.latencyMs,
      requestBody: body,
      responseSnippet: `delivery error: ${result.error}`,
    });
    return { record, delivered: false, terminal: false };
  }
  const delivered = result.status >= 200 && result.status < 300;
  deps.logger.info('callback attempted', {
    kind: input.kind,
    target: result.url,
    status: result.status,
    delivered,
    latencyMs: result.latencyMs,
  });
  const record = await deps.stores.recordDelivery({
    workspaceId: input.txn.workspaceId,
    transactionId: input.txn.id,
    kind: input.kind,
    targetUrl: input.targetUrl,
    status: delivered ? 'delivered' : 'failed',
    latencyMs: result.latencyMs,
    requestBody: body,
    responseStatus: result.status,
    responseSnippet: truncateUtf8(result.body, MAX_RESPONSE_SNIPPET_BYTES),
    responseBody: result.body,
    sentAt: new Date(),
  });
  return { record, delivered, terminal: false };
}

async function continueOrGiveUp(
  deps: DeliverDeps,
  input: AttemptInput,
  attempt: number,
  delivered: boolean,
  terminal: boolean,
): Promise<void> {
  if (delivered || terminal) return;
  if (shouldRetryAfterAttempt(attempt)) {
    const next = attempt + 1;
    await deps.scheduleRetry({
      workspaceId: input.txn.workspaceId,
      transactionId: input.txn.id,
      kind: input.kind,
      targetUrl: input.targetUrl,
      payload: input.payload,
      attempt: next,
      runAt: new Date(Date.now() + backoffForAttempt(next)),
    });
    return;
  }
  deps.logger.warn('callback retries exhausted', {
    kind: input.kind,
    target: input.targetUrl,
    attempts: attempt,
  });
  await deps.stores.recordEvent({
    workspaceId: input.txn.workspaceId,
    transactionId: input.txn.id,
    type: 'callback.dead',
    data: { kind: input.kind, targetUrl: input.targetUrl, attempts: attempt },
  });
}

/** Plugin entrypoint: attempt now, reschedule on retryable failure. */
export async function deliverCallbackNow(
  deps: DeliverDeps,
  input: DeliverCallbackInput,
): Promise<DeliveryRecord> {
  const outcome = await attemptDelivery(deps, input);
  await continueOrGiveUp(deps, input, 1, outcome.delivered, outcome.terminal);
  return outcome.record;
}

/** Scheduler entrypoint: run attempt n of a delivery-retry job. */
export async function runScheduledRetry(
  deps: DeliverDeps,
  input: AttemptInput & { attempt: number },
): Promise<DeliveryRecord> {
  const outcome = await attemptDelivery(deps, input);
  await continueOrGiveUp(deps, input, input.attempt, outcome.delivered, outcome.terminal);
  return outcome.record;
}
