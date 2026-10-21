import { useLiveQuery } from '@neon/realtime-react';
import { useQuery } from '@tanstack/react-query';
import { useCallback, useEffect, useState, type JSX } from 'react';

import type { SealedLiveQuery } from '@neon/realtime/client';

import { fetchSealedActivity, fetchTxns, type ActivityRow } from './api';
import { realtimeClient } from './realtime';

function formatTime(date: Date): string {
  return Number.isNaN(date.getTime()) ? '—' : date.toLocaleTimeString();
}

function statusLabel(status: string): string {
  if (status === 'live') return '● live';
  if (status === 'connecting') return 'connecting…';
  if (status === 'stale') return 'updating…';
  if (status === 'closed') return 'closed';
  return status;
}

function ActivityRowView({ row }: { row: ActivityRow }): JSX.Element {
  return (
    <li className="rounded border border-zinc-800 bg-zinc-900 px-2 py-1 text-xs">
      <span className="text-zinc-500">{formatTime(row.created_at)}</span>{' '}
      <code className="text-zinc-200">{row.type}</code>{' '}
      <span className="text-zinc-500">
        {row.gateway} · {(row.amount_minor / 100).toFixed(2)} {row.currency} · {row.state}
      </span>
    </li>
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
      <p role="alert" className="mt-2 text-xs text-red-400">
        Live updates stopped: {error.message}
      </p>
    );
  }
  return (
    <div>
      <p className="mt-1 text-xs text-zinc-500">
        <span
          className={
            status === 'live'
              ? 'font-semibold text-emerald-400'
              : status === 'closed'
                ? 'text-red-400'
                : 'text-amber-400'
          }
        >
          {statusLabel(status)}
        </span>{' '}
        · streaming from Neon Realtime
      </p>
      {data === undefined ? (
        <p className="mt-2 text-sm text-zinc-500">Loading activity…</p>
      ) : data.length === 0 ? (
        <p className="mt-2 text-sm text-zinc-500">
          No activity yet — run a payment and watch it land here instantly.
        </p>
      ) : (
        <ul className="mt-2 max-h-64 space-y-1 overflow-auto">
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
      <p className="mt-1 text-xs text-zinc-500">Neon Realtime not configured — recent updates</p>
      {txns.isPending && <p className="mt-2 text-sm text-zinc-500">Loading…</p>}
      {txns.isError && (
        <p className="mt-2 text-sm text-red-400">Failed: {(txns.error as Error).message}</p>
      )}
      <ul className="mt-2 max-h-64 space-y-1 overflow-auto">
        {rows.map((txn) => (
          <li key={txn.id} className="rounded border border-zinc-800 bg-zinc-900 px-2 py-1 text-xs">
            <span className="text-zinc-500">{formatTime(new Date(txn.createdAt))}</span>{' '}
            <code className="text-zinc-200">{txn.gatewayTxnId ?? txn.id.slice(0, 8)}</code>{' '}
            <span className="text-zinc-500">
              {txn.gateway} · {(txn.amountMinor / 100).toFixed(2)} {txn.currency} · {txn.state}
            </span>
          </li>
        ))}
      </ul>
      {txns.data && txns.data.length === 0 && (
        <p className="mt-2 text-sm text-zinc-500">No transactions yet.</p>
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
      <p role="alert" className="mt-2 text-xs text-red-400">
        Couldn&apos;t open the live feed.
      </p>
    );
  }
  return <p className="mt-2 text-sm text-zinc-500">Loading activity…</p>;
}
