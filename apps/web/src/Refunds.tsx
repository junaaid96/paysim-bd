import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState, type JSX } from 'react';

import { refundLedger, type RefundEntry } from '@paysim/core';

import { refundTxn, type TxnRecord } from './api';
import { formatAmount } from './ui';

/** Payment states each gateway lets a merchant refund. */
const REFUNDABLE: Record<string, string> = {
  sslcommerz: 'valid',
  bkash: 'completed',
  nagad: 'success',
};

export function isRefundable(txn: TxnRecord): boolean {
  return REFUNDABLE[txn.gateway] === txn.state;
}

export function RefundChip({ txn }: { txn: TxnRecord }): JSX.Element | null {
  const status = txn.metadata['refundStatus'];
  if (status !== 'partial' && status !== 'full') return null;
  return (
    <span className="inline-flex items-center rounded-full bg-violet-900 px-2 py-0.5 text-[11px] font-semibold text-violet-300">
      {status === 'full' ? 'refunded' : 'partly refunded'}
    </span>
  );
}

function newKey(): string {
  return `dash-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function RefundDialog({
  txn,
  refundableMinor,
  onClose,
}: {
  txn: TxnRecord;
  refundableMinor: number;
  onClose: () => void;
}): JSX.Element {
  const queryClient = useQueryClient();
  const [amount, setAmount] = useState((refundableMinor / 100).toFixed(2));
  const [reason, setReason] = useState('');
  const [simulateFailure, setSimulateFailure] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // One key per dialog: double-clicks and retries cannot refund twice.
  const key = useRef(newKey());
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    input.current?.focus();
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape' && !busy) onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [busy, onClose]);

  const minor = Math.round(Number(amount) * 100);
  const valid = /^\d+(\.\d{1,2})?$/.test(amount.trim()) && minor > 0 && minor <= refundableMinor;

  const submit = (): void => {
    if (!valid || busy) return;
    setBusy(true);
    setError(null);
    refundTxn(txn.id, {
      amountMinor: minor,
      reason: reason.trim() || undefined,
      idempotencyKey: key.current,
      simulateFailure: simulateFailure && txn.metadata['sandboxMode'] !== 'real',
    })
      .then(async ({ refund }) => {
        await queryClient.invalidateQueries();
        if (refund.status === 'failed') {
          setError('The simulated gateway declined this refund. No money moved.');
          key.current = newKey();
          setBusy(false);
          return;
        }
        onClose();
      })
      .catch((err: unknown) => {
        setError(err instanceof Error ? err.message : String(err));
        setBusy(false);
      });
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-end justify-center bg-black/60 p-4 sm:items-center"
      onClick={() => !busy && onClose()}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="refund-title"
        className="w-full max-w-sm rounded-xl border border-zinc-800 bg-zinc-900 p-4 shadow-xl"
        onClick={(event) => event.stopPropagation()}
      >
        <h3 id="refund-title" className="text-base font-semibold text-zinc-100">
          Refund payment
        </h3>
        <p className="mt-1 text-xs text-zinc-500">
          Up to {formatAmount(refundableMinor, txn.currency)} can be refunded. Partial refunds are
          fine; you can refund the rest later.
        </p>
        <form
          className="mt-3 space-y-3"
          onSubmit={(event) => {
            event.preventDefault();
            submit();
          }}
        >
          <label className="block text-xs text-zinc-500">
            Amount ({txn.currency})
            <div className="mt-1 flex gap-2">
              <input
                ref={input}
                inputMode="decimal"
                value={amount}
                onChange={(event) => setAmount(event.target.value)}
                className="input mt-0 flex-1 tabular-nums"
                aria-invalid={!valid}
              />
              <button
                type="button"
                className="btn"
                onClick={() => setAmount((refundableMinor / 100).toFixed(2))}
              >
                Full
              </button>
            </div>
          </label>
          <label className="block text-xs text-zinc-500">
            Reason (optional)
            <input
              value={reason}
              maxLength={200}
              onChange={(event) => setReason(event.target.value)}
              placeholder="e.g. item out of stock"
              className="input"
            />
          </label>
          {txn.metadata['sandboxMode'] === 'real' ? (
            <p className="text-xs text-zinc-400">
              This payment ran in Real sandbox mode: the refund is sent to the provider&apos;s
              sandbox{txn.gateway === 'bkash' ? ' (bKash allows one refund per payment)' : ''}.
            </p>
          ) : (
            <label className="flex items-center gap-2 text-xs text-zinc-400">
              <input
                type="checkbox"
                checked={simulateFailure}
                onChange={(event) => setSimulateFailure(event.target.checked)}
              />
              Simulate a declined refund
            </label>
          )}
          {!valid && amount.trim() !== '' && (
            <p className="text-xs text-amber-400">
              Enter an amount between 0.01 and {(refundableMinor / 100).toFixed(2)}.
            </p>
          )}
          {error && <p className="text-xs text-red-400">{error}</p>}
          <div className="flex justify-end gap-2 pt-1">
            <button type="button" className="btn" disabled={busy} onClick={onClose}>
              Cancel
            </button>
            <button type="submit" className="btn btn-primary" disabled={!valid || busy}>
              {busy ? 'Refunding…' : `Refund ${valid ? formatAmount(minor, txn.currency) : ''}`}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

function RefundRow({ entry, currency }: { entry: RefundEntry; currency: string }): JSX.Element {
  const ok = entry.status === 'completed';
  return (
    <li className="flex items-center justify-between gap-2 py-1.5">
      <div className="min-w-0">
        <code className="block truncate text-zinc-200">{entry.refundId}</code>
        <span className="text-[11px] text-zinc-500">
          {new Date(entry.createdAt).toLocaleString()} · via {entry.source}
          {entry.reason ? ` · ${entry.reason}` : ''}
        </span>
      </div>
      <div className="shrink-0 text-right">
        <div className="tabular-nums text-zinc-100">
          {formatAmount(entry.amountMinor, currency)}
        </div>
        <span className={`text-[11px] font-semibold ${ok ? 'text-emerald-400' : 'text-red-400'}`}>
          {ok ? 'refunded' : 'declined'}
        </span>
      </div>
    </li>
  );
}

export function RefundPanel({ txn }: { txn: TxnRecord }): JSX.Element | null {
  const [open, setOpen] = useState(false);
  const ledger = refundLedger(txn);
  const refundable = isRefundable(txn);
  if (!refundable && ledger.refunds.length === 0) return null;
  return (
    <div className="rounded-lg border border-zinc-800 bg-zinc-900 p-3 text-xs">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <div className="text-zinc-500">Refunds</div>
          <div className="mt-0.5 text-sm text-zinc-200 tabular-nums">
            {formatAmount(ledger.refundedMinor, txn.currency)} refunded ·{' '}
            {formatAmount(ledger.refundableMinor, txn.currency)} left
          </div>
        </div>
        {refundable && ledger.refundableMinor > 0 && (
          <button type="button" className="btn" onClick={() => setOpen(true)}>
            ↩ Refund
          </button>
        )}
      </div>
      {ledger.refunds.length > 0 && (
        <ul className="mt-2 divide-y divide-zinc-800 border-t border-zinc-800">
          {[...ledger.refunds].reverse().map((entry) => (
            <RefundRow key={entry.refundId} entry={entry} currency={txn.currency} />
          ))}
        </ul>
      )}
      {open && (
        <RefundDialog
          txn={txn}
          refundableMinor={ledger.refundableMinor}
          onClose={() => setOpen(false)}
        />
      )}
    </div>
  );
}
