// Shared refund ledger for all gateway plugins. Refunds never change the
// payment state (validation/query APIs keep answering for the original
// payment, like the real gateways); they live in transaction metadata:
//   metadata.refunds       RefundEntry[] (completed and failed attempts)
//   metadata.refundedMinor sum of completed refunds
//   metadata.refundStatus  'none' | 'partial' | 'full'
// Writes go through PluginStores.recordRefund when available, which the
// API implements as one atomic conditional UPDATE (no over-refund under
// concurrent requests); fakes fall back to read-modify-write.

import type { PluginContext, TxnRecord } from './plugin.js';

/** Magic marker in the refund reason/remarks that simulates a declined refund. */
export const REFUND_FAIL_MARKER = 'SIM:refund_fail';

export type RefundStatus = 'none' | 'partial' | 'full';
export type RefundSource = 'api' | 'dashboard';

export interface RefundEntry {
  refundId: string;
  /** Merchant idempotency reference (refe_id, referenceNo, Idempotency-Key). */
  merchantRef: string | null;
  amountMinor: number;
  status: 'completed' | 'failed';
  reason: string;
  failureReason?: string;
  /** Provider refund reference (real-sandbox mode only). */
  providerRefundId?: string;
  source: RefundSource;
  createdAt: string;
}

export interface RefundLedger {
  refunds: RefundEntry[];
  refundedMinor: number;
  refundableMinor: number;
  refundStatus: RefundStatus;
}

export type RefundErrorCode =
  'not_refundable' | 'invalid_amount' | 'exceeds_refundable' | 'reference_conflict';

export class RefundError extends Error {
  constructor(
    public readonly code: RefundErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'RefundError';
  }
}

function isEntry(value: unknown): value is RefundEntry {
  return (
    value !== null &&
    typeof value === 'object' &&
    typeof (value as RefundEntry).refundId === 'string' &&
    typeof (value as RefundEntry).amountMinor === 'number'
  );
}

export function refundLedger(txn: Pick<TxnRecord, 'amountMinor' | 'metadata'>): RefundLedger {
  const raw = txn.metadata['refunds'];
  const refunds = Array.isArray(raw) ? raw.filter(isEntry) : [];
  const refundedMinor = refunds
    .filter((entry) => entry.status === 'completed')
    .reduce((sum, entry) => sum + entry.amountMinor, 0);
  const refundableMinor = Math.max(0, txn.amountMinor - refundedMinor);
  const refundStatus: RefundStatus =
    refundedMinor <= 0 ? 'none' : refundableMinor === 0 ? 'full' : 'partial';
  return { refunds, refundedMinor, refundableMinor, refundStatus };
}

export function generateRefundId(prefix = 'RF'): string {
  const bytes = new Uint8Array(6);
  globalThis.crypto.getRandomValues(bytes);
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
  return `${prefix}${hex.toUpperCase()}`;
}

export interface RefundRequest {
  /** Gateway plugin name, used for event types (`<gateway>.refund.*`). */
  gateway: string;
  /** Payment states that may be refunded (the gateway's "completed" state). */
  refundableStates: readonly string[];
  amountMinor: number;
  merchantRef?: string | null;
  reason?: string;
  source: RefundSource;
  /** Force a simulated decline (dashboard toggle); the reason marker also works. */
  simulateFailure?: boolean;
  refundIdPrefix?: string;
  /**
   * Real-sandbox settlement: called after validation, before the ledger
   * write. A provider decline is recorded as a failed entry.
   */
  settle?: (input: {
    amountMinor: number;
    reason: string;
    refundId: string;
  }) => Promise<{ ok: boolean; failureReason?: string; providerRefundId?: string }>;
  /** Extra data merged into the refund event (e.g. redacted HTTP request). */
  eventData?: Record<string, unknown>;
}

export interface RefundResult {
  entry: RefundEntry;
  txn: TxnRecord;
  ledger: RefundLedger;
  /** True when an earlier refund with the same merchantRef was returned. */
  replayed: boolean;
}

/**
 * Validate and record one refund. Idempotent on merchantRef: repeating a
 * reference with the same amount returns the original entry; a different
 * amount is a reference_conflict. Failed (simulated) refunds are recorded
 * but never count toward the refunded total.
 */
export async function processRefund(
  ctx: Pick<PluginContext, 'stores' | 'clock'>,
  txn: TxnRecord,
  request: RefundRequest,
): Promise<RefundResult> {
  const merchantRef = request.merchantRef?.trim() ? request.merchantRef.trim() : null;
  const before = refundLedger(txn);
  if (merchantRef) {
    const prior = before.refunds.find((entry) => entry.merchantRef === merchantRef);
    if (prior) {
      if (prior.amountMinor !== request.amountMinor) {
        throw new RefundError(
          'reference_conflict',
          `Refund reference ${merchantRef} was already used for a different amount.`,
        );
      }
      return { entry: prior, txn, ledger: before, replayed: true };
    }
  }
  if (!request.refundableStates.includes(txn.state)) {
    throw new RefundError(
      'not_refundable',
      `Only completed payments can be refunded (this one is ${txn.state}).`,
    );
  }
  if (!Number.isInteger(request.amountMinor) || request.amountMinor <= 0) {
    throw new RefundError('invalid_amount', 'Refund amount must be greater than zero.');
  }
  if (request.amountMinor > before.refundableMinor) {
    throw new RefundError(
      'exceeds_refundable',
      `Refund amount exceeds the refundable balance (${(before.refundableMinor / 100).toFixed(2)}).`,
    );
  }
  const reason = (request.reason ?? '').slice(0, 255);
  const refundId = generateRefundId(request.refundIdPrefix);
  let failed: boolean;
  let failureReason = 'Refund declined by the simulated gateway.';
  let providerRefundId: string | undefined;
  if (request.settle) {
    const settled = await request.settle({ amountMinor: request.amountMinor, reason, refundId });
    failed = !settled.ok;
    if (settled.failureReason) failureReason = settled.failureReason.slice(0, 255);
    providerRefundId = settled.providerRefundId;
  } else {
    failed = request.simulateFailure === true || reason.includes(REFUND_FAIL_MARKER);
  }
  const entry: RefundEntry = {
    refundId,
    merchantRef,
    amountMinor: request.amountMinor,
    status: failed ? 'failed' : 'completed',
    reason,
    ...(failed ? { failureReason } : {}),
    ...(providerRefundId ? { providerRefundId } : {}),
    source: request.source,
    createdAt: ctx.clock.now(txn.workspaceId).toISOString(),
  };
  const countMinor = failed ? 0 : entry.amountMinor;

  let updated: TxnRecord | null;
  if (ctx.stores.recordRefund) {
    updated = await ctx.stores.recordRefund(txn.id, entry as unknown as Record<string, unknown>, {
      countMinor,
      merchantRef,
    });
    if (!updated) {
      // Lost a race: re-read and report precisely (duplicate ref or balance).
      const fresh = (await ctx.stores.getTransaction(txn.id)) ?? txn;
      const ledger = refundLedger(fresh);
      const prior = merchantRef
        ? ledger.refunds.find((candidate) => candidate.merchantRef === merchantRef)
        : undefined;
      if (prior && prior.amountMinor === entry.amountMinor) {
        return { entry: prior, txn: fresh, ledger, replayed: true };
      }
      if (prior) {
        throw new RefundError(
          'reference_conflict',
          `Refund reference ${merchantRef} was already used for a different amount.`,
        );
      }
      throw new RefundError(
        'exceeds_refundable',
        `Refund amount exceeds the refundable balance (${(ledger.refundableMinor / 100).toFixed(2)}).`,
      );
    }
  } else {
    const refunds = [...before.refunds, entry];
    const refundedMinor = before.refundedMinor + countMinor;
    updated = await ctx.stores.setTransactionAmount(txn.id, txn.amountMinor, {
      refunds,
      refundedMinor,
      refundStatus: refundStatusFor(txn.amountMinor, refundedMinor),
      [refundIndexKey(entry.refundId)]: '1',
    });
  }
  await ctx.stores.recordEvent({
    workspaceId: txn.workspaceId,
    transactionId: txn.id,
    type: `${request.gateway}.refund.${failed ? 'failed' : 'completed'}`,
    data: {
      refundId: entry.refundId,
      merchantRef,
      amountMinor: entry.amountMinor,
      reason,
      source: request.source,
      ...(failed ? { failureReason: entry.failureReason } : {}),
      ...request.eventData,
    },
  });
  return { entry, txn: updated, ledger: refundLedger(updated), replayed: false };
}

export function refundStatusFor(amountMinor: number, refundedMinor: number): RefundStatus {
  if (refundedMinor <= 0) return 'none';
  return refundedMinor >= amountMinor ? 'full' : 'partial';
}

export function findRefund(txn: TxnRecord, refundId: string): RefundEntry | null {
  return refundLedger(txn).refunds.find((entry) => entry.refundId === refundId) ?? null;
}

/**
 * Metadata key marking that a transaction owns a refund id, so plugins can
 * find the payment from a refund reference with findTransactionByMetadata.
 */
export function refundIndexKey(refundId: string): string {
  return `refund:${refundId}`;
}
