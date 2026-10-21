import { useLiveQuery } from '@neon/realtime-react';
import { useQuery } from '@tanstack/react-query';
import { useCallback, useEffect, useState, type JSX } from 'react';

import type { SealedLiveQuery } from '@neon/realtime/client';

import { fetchSealedActivity, fetchTxns, type ActivityRow } from './api';
import { realtimeClient } from './realtime';
import { EmptyState, GatewayMark, LiveBadge, StateChip, formatAmount } from './ui';

function formatTime(date: Date): string {
  return Number.isNaN(date.getTime()) ? '—' : date.toLocaleTimeString();
}

function statusLabel(status: string): string {
  if (status === 'live') return 'Connected';
  if (status === 'connecting') return 'Connecting…';
  if (status === 'stale') return 'Updating…';
  if (status === 'closed') return 'Closed';
  return status;
}

function FeedRow({
  time,
  title,
  gateway,
  amount,
  state,
}: {
  time: string;
  title: string;
  gateway: string;
  amount: string;
  state: string;
}): JSX.Element {
  return (
    <li className="flex items-center gap-3 border-b border-zinc-800 py-2 last:border-0">
      <GatewayMark gateway={gateway} size="sm" />
      <div className="min-w-0 flex-1">
        <code className="block truncate text-xs text-zinc-200">{title}</code>
        <span className="text-[11px] text-zinc-500">
          {time} · {amount}
        </span>
      </div>
      <StateChip state={state} />
    </li>
  );
}

/** Refund events show the refund outcome instead of the payment state. */
function feedState(row: ActivityRow): string {
  if (row.type.endsWith('.refund.completed')) return 'refunded';
  if (row.type.endsWith('.refund.failed')) return 'refund declined';
  return row.state;
}

function ActivityRowView({ row }: { row: ActivityRow }): JSX.Element {
  return (
    <FeedRow
      time={formatTime(row.created_at)}
      title={row.type}
      gateway={row.gateway}
      amount={formatAmount(row.amount_minor, row.currency)}
      state={feedState(row)}
    />
  );
}

function fetchFailedRealtime(err: unknown): boolean {
  return err instanceof Error && err.message.includes('realtime_not_configured');
}

interface SealedActivity {
  workspace: string;
  sealedQuery?: SealedLiveQuery<ActivityRow>;
  fallback: boolean;
}

function useSealedActivity(workspace: string): SealedActivity | undefined {
  const [sealed, setSealed] = useState<SealedActivity>();

  useEffect(() => {
    if (realtimeClient() === null) {
      setSealed({ workspace, fallback: true });
      return;
    }
    let cancelled = false;
    fetchSealedActivity(workspace).then(
      (sealedQuery) => {
        if (!cancelled) setSealed({ workspace, sealedQuery, fallback: false });
      },
      (error: unknown) => {
        // API without NEON_REALTIME_SECRET: fall back to REST data.
        if (!cancelled) setSealed({ workspace, fallback: fetchFailedRealtime(error) });
      },
    );
    return () => {
      cancelled = true;
    };
  }, [workspace]);

  // Never hand the previous workspace's sealed query to the new workspace.
  if (!sealed || sealed.workspace !== workspace) return undefined;
  return sealed;
}

function LiveFeed({
  sealedQuery,
  refreshQuery,
}: {
  sealedQuery: SealedLiveQuery<ActivityRow>;
  refreshQuery: () => Promise<SealedLiveQuery<ActivityRow>>;
}): JSX.Element {
  const { data, status, error } = useLiveQuery(sealedQuery, { refreshQuery });

  if (status === 'error') {
    return (
      <p role="alert" className="text-xs text-red-400">
        Live updates stopped: {error.message}
      </p>
    );
  }
  return (
    <div>
      <div className="flex items-center justify-between gap-2">
        <LiveBadge status={status} label={statusLabel(status)} />
        <span className="text-[11px] text-zinc-500">Neon Realtime</span>
      </div>
      {data === undefined ? (
        <p className="mt-3 text-sm text-zinc-500">Loading activity…</p>
      ) : data.length === 0 ? (
        <div className="mt-3">
          <EmptyState title="No activity yet" icon="〰">
            Run a payment and watch it land here instantly.
          </EmptyState>
        </div>
      ) : (
        <ul className="mt-2 max-h-[26rem] overflow-auto pr-1">
          {data.map((row) => (
            <ActivityRowView key={row.id} row={row} />
          ))}
        </ul>
      )}
    </div>
  );
}

/** REST fallback when Realtime is not configured (same panel, no live query). */
function FallbackFeed({ workspace }: { workspace: string }): JSX.Element {
  const txns = useQuery({ queryKey: ['txns', workspace], queryFn: () => fetchTxns(workspace) });
  const rows = (txns.data ?? []).slice(0, 10);
  return (
    <div>
      <div className="flex items-center justify-between gap-2">
        <LiveBadge status="polling" label="Recent updates" />
        <span className="text-[11px] text-zinc-500">Neon Realtime not configured</span>
      </div>
      {txns.isPending && <p className="mt-3 text-sm text-zinc-500">Loading…</p>}
      {txns.isError && (
        <p className="mt-3 text-sm text-red-400">Failed: {(txns.error as Error).message}</p>
      )}
      <ul className="mt-2 max-h-[26rem] overflow-auto pr-1">
        {rows.map((txn) => (
          <FeedRow
            key={txn.id}
            time={formatTime(new Date(txn.createdAt))}
            title={txn.gatewayTxnId ?? txn.id.slice(0, 8)}
            gateway={txn.gateway}
            amount={formatAmount(txn.amountMinor, txn.currency)}
            state={txn.state}
          />
        ))}
      </ul>
      {txns.data && txns.data.length === 0 && (
        <div className="mt-3">
          <EmptyState title="No transactions yet" />
        </div>
      )}
    </div>
  );
}

export default function ActivityFeed({ workspace }: { workspace: string }): JSX.Element {
  const sealed = useSealedActivity(workspace);
  const refreshQuery = useCallback(() => fetchSealedActivity(workspace), [workspace]);

  if (sealed?.fallback) return <FallbackFeed workspace={workspace} />;
  if (sealed?.sealedQuery) {
    return <LiveFeed sealedQuery={sealed.sealedQuery} refreshQuery={refreshQuery} />;
  }
  // Sealed fetch failed for a real error (not "unconfigured"): surface it.
  if (sealed && !sealed.fallback && !sealed.sealedQuery) {
    return (
      <p role="alert" className="text-xs text-red-400">
        Couldn&apos;t open the live feed.
      </p>
    );
  }
  return <p className="text-sm text-zinc-500">Connecting to the live feed…</p>;
}
