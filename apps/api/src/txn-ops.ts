// Dashboard operations on transactions: scenario overrides and callback
// replays. Used by routes/transactions.ts; errors map to HTTP statuses
// there (classes, not status codes, keep this module Express-free).

import { eq } from 'drizzle-orm';

import type { DeliverCallbackInput, DeliveryRecord, TxnRecord } from '@paysim/core';

import type { Db } from './db/client.js';
import { transactions } from './db/schema.js';
import { applyScenarioOverride, type ApplyOverrideDeps, type EngineDeps } from './engine.js';
import type { StorageAdapter } from './storage/index.js';

export class TransactionNotFoundError extends Error {
  constructor(id: string) {
    super(`Unknown transaction ${id}`);
    this.name = 'TransactionNotFoundError';
  }
}

export class DeliveryNotFoundError extends Error {
  constructor(id: string) {
    super(`Unknown delivery ${id}`);
    this.name = 'DeliveryNotFoundError';
  }
}

export class UnreplayableDeliveryError extends Error {
  constructor() {
    super('Delivery has no recorded request body to replay');
    this.name = 'UnreplayableDeliveryError';
  }
}

export interface TxnOpsDeps {
  db: Db;
  engineDeps: EngineDeps;
  applyDeps: ApplyOverrideDeps;
  storage: StorageAdapter;
  deliver: (input: DeliverCallbackInput) => Promise<DeliveryRecord>;
}

async function loadTxn(deps: TxnOpsDeps, txnId: string): Promise<TxnRecord> {
  const txn = await deps.engineDeps.stores.getTransaction(txnId);
  if (!txn) throw new TransactionNotFoundError(txnId);
  return txn;
}

/**
 * Attach a scenario override (or detach back to manual with null).
 * Persists scenario_override_id only when the attach succeeds.
 */
export async function applyTxnScenario(
  deps: TxnOpsDeps,
  txnId: string,
  scenarioId: string | null,
): Promise<TxnRecord> {
  const txn = await loadTxn(deps, txnId);
  const resolved = await applyScenarioOverride(deps.applyDeps, txn, scenarioId);
  await deps.db
    .update(transactions)
    .set({ scenarioOverrideId: resolved?.scenarioId ?? null })
    .where(eq(transactions.id, txnId));
  const updated = await deps.engineDeps.stores.getTransaction(txnId);
  if (!updated) throw new TransactionNotFoundError(txnId);
  return updated;
}

/**
 * Re-POST a recorded callback payload (latest attempt by default) as a
 * fresh delivery attempt, subject to the usual retry policy.
 */
export async function replayDelivery(
  deps: TxnOpsDeps,
  txnId: string,
  deliveryId?: string,
): Promise<DeliveryRecord> {
  const txn = await loadTxn(deps, txnId);
  const deliveries = await deps.engineDeps.stores.listDeliveries(txnId);
  const delivery = deliveryId
    ? (deliveries.find((candidate) => candidate.id === deliveryId) ?? null)
    : (deliveries[deliveries.length - 1] ?? null);
  if (!delivery) throw new DeliveryNotFoundError(deliveryId ?? '(latest)');
  let body: string | null;
  if (delivery.requestBodyKey) {
    const bytes = await deps.storage.get(delivery.requestBodyKey);
    body = new TextDecoder().decode(bytes);
  } else {
    body = delivery.requestBody;
  }
  if (!body) throw new UnreplayableDeliveryError();
  const payload: Record<string, string> = {};
  for (const [key, value] of new URLSearchParams(body)) {
    payload[key] = value;
  }
  const record = await deps.deliver({
    txn,
    kind: delivery.kind,
    targetUrl: delivery.targetUrl,
    payload,
  });
  await deps.engineDeps.stores.recordEvent({
    workspaceId: txn.workspaceId,
    transactionId: txn.id,
    type: 'callback.replayed',
    data: {
      replayOf: delivery.id,
      deliveryId: record.id,
      kind: delivery.kind,
      targetUrl: delivery.targetUrl,
      status: record.status,
    },
  });
  return record;
}
