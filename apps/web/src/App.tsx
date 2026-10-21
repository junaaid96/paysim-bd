import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState, type JSX } from 'react';

import ActivityFeed from './ActivityFeed';
import Onboarding from './Onboarding';
import TxnDetail from './TxnDetail';
import {
  advanceClock,
  fetchApps,
  fetchClock,
  fetchHealth,
  fetchScenarios,
  fetchSpec,
  fetchTxns,
  resetClock,
  updateAppDefault,
  workspaceKey,
  type AppRecord,
} from './api';
import { useLiveUpdates } from './sse';

function FidelityBadge({ gateway }: { gateway: string }): JSX.Element {
  const spec = useQuery({ queryKey: ['spec', gateway], queryFn: () => fetchSpec(gateway) });
  if (spec.isPending) return <span className="text-xs text-zinc-500">…</span>;
  if (spec.isError || !spec.data) return <span className="text-xs text-red-400">spec error</span>;
  const endpoints = spec.data.endpoints;
  const implemented = endpoints.filter((endpoint) => endpoint.implemented).length;
  const verifiedFields = spec.data.fields.filter((field) => field.fidelity === 'verified').length;
  const badge =
    spec.data.fidelity === 'verified'
      ? 'bg-emerald-900 text-emerald-300'
      : spec.data.fidelity === 'unverified'
        ? 'bg-zinc-700 text-zinc-300'
        : 'bg-amber-900 text-amber-300';
  return (
    <span className={`rounded px-2 py-0.5 text-xs font-semibold ${badge}`}>
      {spec.data.fidelity} · {implemented}/{endpoints.length} endpoints · {verifiedFields} verified
      fields
    </span>
  );
}

/** Human reference per gateway: invoice id, or the sim handle for bKash/Nagad. */
function txnReference(txn: {
  gateway: string;
  gatewayTxnId: string | null;
  gatewaySessionKey: string | null;
  id: string;
}): string {
  if (txn.gateway === 'bkash' || txn.gateway === 'nagad') return txn.gatewaySessionKey ?? txn.id;
  return txn.gatewayTxnId ?? txn.id;
}

function formatOffset(ms: number): string {
  if (ms === 0) return 'wall clock';
  const sign = ms > 0 ? '+' : '−';
  const abs = Math.abs(ms);
  if (abs < 60_000) return `${sign}${Math.round(abs / 1000)}s`;
  if (abs < 3_600_000) return `${sign}${Math.round(abs / 60_000)}m`;
  return `${sign}${(abs / 3_600_000).toFixed(1)}h`;
}

function ClockPanel({ workspace }: { workspace: string }): JSX.Element {
  const queryClient = useQueryClient();
  const clock = useQuery({
    queryKey: ['clock', workspace],
    queryFn: () => fetchClock(workspace),
    refetchInterval: 5000,
  });
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const jump = (ms: number): void => {
    setBusy(true);
    advanceClock(workspace, ms)
      .then((state) => {
        setNotice(`+${formatOffset(ms).slice(1)} → shifted ${state.jobsShifted ?? 0} job(s)`);
        return queryClient.invalidateQueries();
      })
      .catch((err: unknown) => setNotice(err instanceof Error ? err.message : String(err)))
      .finally(() => setBusy(false));
  };
  const reset = (): void => {
    setBusy(true);
    resetClock(workspace)
      .then(() => {
        setNotice('clock reset to wall time');
        return queryClient.invalidateQueries();
      })
      .catch((err: unknown) => setNotice(err instanceof Error ? err.message : String(err)))
      .finally(() => setBusy(false));
  };

  return (
    <div className="rounded border border-zinc-800 bg-zinc-900 p-2 text-sm">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-zinc-400">fake clock:</span>
        <code className="text-zinc-200">
          {clock.data ? new Date(clock.data.now).toLocaleString() : '…'}
        </code>
        <span className="text-xs text-zinc-500">
          ({clock.data ? formatOffset(clock.data.offsetMs) : '…'})
        </span>
      </div>
      <div className="mt-2 flex flex-wrap gap-1">
        {[
          { label: '+10s', ms: 10_000 },
          { label: '+1m', ms: 60_000 },
          { label: '+10m', ms: 600_000 },
          { label: '+1h', ms: 3_600_000 },
        ].map((step) => (
          <button
            key={step.label}
            type="button"
            disabled={busy}
            onClick={() => jump(step.ms)}
            className="rounded border border-zinc-700 px-2 py-0.5 text-xs hover:bg-zinc-800 disabled:opacity-50"
          >
            {step.label}
          </button>
        ))}
        <button
          type="button"
          disabled={busy}
          onClick={reset}
          className="rounded border border-zinc-700 px-2 py-0.5 text-xs hover:bg-zinc-800 disabled:opacity-50"
        >
          reset
        </button>
      </div>
      {notice && <p className="mt-1 text-xs text-zinc-500">{notice}</p>}
    </div>
  );
}

function AppDefaultPicker({ app, workspace }: { app: AppRecord; workspace: string }): JSX.Element {
  const queryClient = useQueryClient();
  const scenarios = useQuery({
    queryKey: ['scenarios', workspace, app.gateway],
    queryFn: () => fetchScenarios(workspace, app.gateway),
  });
  const [error, setError] = useState<string | null>(null);

  const onChange = (scenarioId: string): void => {
    setError(null);
    updateAppDefault(app.id, scenarioId === '' ? null : scenarioId)
      .then(() => queryClient.invalidateQueries())
      .catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)));
  };

  return (
    <div className="mt-1 text-xs">
      <label className="text-zinc-500">
        default scenario:{' '}
        <select
          value={app.defaultScenarioId ?? ''}
          onChange={(event) => onChange(event.target.value)}
          className="rounded border border-zinc-700 bg-zinc-950 px-1 py-0.5 text-zinc-200"
        >
          <option value="">manual (dashboard buttons)</option>
          {(scenarios.data ?? []).map((scenario) => (
            <option key={scenario.id} value={scenario.id}>
              {scenario.name}
              {scenario.global ? '' : ' (workspace)'}
            </option>
          ))}
        </select>
      </label>
      {error && <span className="ml-2 text-red-400">{error}</span>}
    </div>
  );
}

function AppsPanel({ apps, workspace }: { apps: AppRecord[]; workspace: string }): JSX.Element {
  if (apps.length === 0) {
    return <p className="mt-2 text-sm text-zinc-500">No gateway apps yet.</p>;
  }
  return (
    <ul className="mt-2 space-y-2">
      {apps.map((app) => (
        <li key={app.id} className="rounded border border-zinc-800 bg-zinc-900 p-2 text-sm">
          <div className="flex items-center justify-between gap-2">
            <div>
              <div className="font-medium">{app.name}</div>
              <div className="text-xs text-zinc-500">
                {app.gateway} ·{' '}
                <code>
                  {String(
                    app.credentials['store_id'] ??
                      app.credentials['app_key'] ??
                      app.credentials['merchant_id'] ??
                      '?',
                  )}
                </code>
              </div>
            </div>
            <FidelityBadge gateway={app.gateway} />
          </div>
          <AppDefaultPicker app={app} workspace={workspace} />
        </li>
      ))}
    </ul>
  );
}

export default function App(): JSX.Element {
  const workspace = workspaceKey();
  const streamStatus = useLiveUpdates(workspace);
  const health = useQuery({ queryKey: ['health'], queryFn: fetchHealth, refetchInterval: 30_000 });
  const apps = useQuery({ queryKey: ['apps', workspace], queryFn: () => fetchApps(workspace) });
  const txns = useQuery({ queryKey: ['txns', workspace], queryFn: () => fetchTxns(workspace) });
  const [selectedId, setSelectedId] = useState<string | null>(null);

  useEffect(() => {
    if (selectedId === null && txns.data && txns.data.length > 0) {
      const first = txns.data[0];
      if (first) setSelectedId(first.id);
    }
  }, [selectedId, txns.data]);

  return (
    <div className="min-h-screen bg-zinc-950 text-zinc-100">
      <div className="bg-amber-400 px-4 py-2 text-center text-sm font-bold tracking-wide text-black">
        SIMULATOR — fake money, fake credentials. Never use real keys or real customer data here.
      </div>

      <main className="mx-auto max-w-6xl px-4 py-6">
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="text-2xl font-bold">PaySim BD</h1>
          <span className="text-sm text-zinc-400">workspace: {workspace}</span>
          <span
            className={`rounded px-2 py-0.5 text-xs font-semibold ${
              streamStatus === 'live'
                ? 'bg-emerald-900 text-emerald-300'
                : 'bg-zinc-700 text-zinc-300'
            }`}
          >
            {streamStatus === 'live' ? '● live' : streamStatus}
          </span>
          <span className="text-xs text-zinc-500">
            api {health.data ? `${health.data.status} v${health.data.version}` : '…'}
          </span>
        </div>
        <p className="mt-1 text-sm text-zinc-400">
          Fake SSLCommerz, bKash and Nagad gateways for development and testing — drive any payment
          outcome on demand.
        </p>

        <Onboarding workspace={workspace} />

        <div className="mt-6 grid grid-cols-1 gap-6 lg:grid-cols-5">
          <section className="lg:col-span-2">
            <h2 className="text-sm font-semibold uppercase tracking-wide text-zinc-400">
              Live activity
            </h2>
            <ActivityFeed workspace={workspace} />

            <h2 className="mt-6 text-sm font-semibold uppercase tracking-wide text-zinc-400">
              Gateway apps
            </h2>
            {apps.isPending && <p className="mt-2 text-sm text-zinc-500">Loading…</p>}
            {apps.isError && (
              <p className="mt-2 text-sm text-red-400">Failed: {(apps.error as Error).message}</p>
            )}
            {apps.data && <AppsPanel apps={apps.data} workspace={workspace} />}

            <h2 className="mt-6 text-sm font-semibold uppercase tracking-wide text-zinc-400">
              Fake clock
            </h2>
            <div className="mt-2">
              <ClockPanel workspace={workspace} />
            </div>

            <h2 className="mt-6 text-sm font-semibold uppercase tracking-wide text-zinc-400">
              Transactions {txns.data ? `(${txns.data.length})` : ''}
            </h2>
            {txns.isPending && <p className="mt-2 text-sm text-zinc-500">Loading…</p>}
            {txns.isError && (
              <p className="mt-2 text-sm text-red-400">Failed: {(txns.error as Error).message}</p>
            )}
            <ul className="mt-2 space-y-1">
              {(txns.data ?? []).map((txn) => (
                <li key={txn.id}>
                  <button
                    type="button"
                    onClick={() => setSelectedId(txn.id)}
                    className={`w-full rounded border p-2 text-left text-sm ${
                      selectedId === txn.id
                        ? 'border-amber-400 bg-zinc-900'
                        : 'border-zinc-800 bg-zinc-900 hover:border-zinc-600'
                    }`}
                  >
                    <div className="flex justify-between gap-2">
                      <code className="truncate">{txnReference(txn)}</code>
                      <span className="text-zinc-400">{txn.state}</span>
                    </div>
                    <div className="text-xs text-zinc-500">
                      {txn.gateway} · {(txn.amountMinor / 100).toFixed(2)} {txn.currency}
                    </div>
                  </button>
                </li>
              ))}
            </ul>
            {txns.data && txns.data.length === 0 && (
              <p className="mt-2 text-sm text-zinc-500">
                No transactions yet — POST a payment init to the base URL above with a SIM: marker
                (e.g. <code>value_d=SIM:immediate-success</code>), then it will appear here live.
              </p>
            )}
          </section>

          <section className="lg:col-span-3">
            {selectedId ? (
              <TxnDetail key={selectedId} txnId={selectedId} />
            ) : (
              <p className="text-sm text-zinc-500">Select a transaction to inspect its timeline.</p>
            )}
          </section>
        </div>
      </main>
    </div>
  );
}
