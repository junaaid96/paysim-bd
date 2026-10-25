import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useMemo, useState, type JSX } from 'react';

import ActivityFeed from './ActivityFeed';
import RealSandboxPage from './SandboxPanel';
import Onboarding, { CreateAppForm, QuickstartSnippet } from './Onboarding';
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
  type TxnRecord,
} from './api';
import { useLiveUpdates } from './sse';
import {
  EmptyState,
  GATEWAYS,
  GatewayMark,
  LiveBadge,
  SectionHeader,
  StateChip,
  formatAmount,
  gatewayName,
  useTheme,
} from './ui';
import { RefundChip } from './Refunds';

type View = 'overview' | 'transactions' | 'gateways' | 'scenarios' | 'sandbox' | 'start';

const NAV: Array<{ id: View; label: string; icon: string; extra?: boolean }> = [
  { id: 'overview', label: 'Overview', icon: '◧' },
  { id: 'transactions', label: 'Transactions', icon: '⇄' },
  { id: 'gateways', label: 'Gateways', icon: '▣' },
  { id: 'scenarios', label: 'Scenarios & clock', icon: '◷' },
  { id: 'sandbox', label: 'Real sandbox', icon: '◇', extra: true },
  { id: 'start', label: 'Get started', icon: '➜' },
];

const START_SEEN_KEY = 'paysim-start-seen';

function RocketIcon(): JSX.Element {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className="size-4 shrink-0"
    >
      <path d="M4.5 16.5c-1.5 1.26-2 5-2 5s3.74-.5 5-2c.71-.84.7-2.13-.09-2.91a2.18 2.18 0 0 0-2.91-.09z" />
      <path d="m12 15-3-3a22 22 0 0 1 2-3.95A12.88 12.88 0 0 1 22 2c0 2.72-.78 7.5-6 11a22.35 22.35 0 0 1-4 2z" />
      <path d="M9 12H4s.55-3.03 2-4c1.62-1.08 5 0 5 0" />
      <path d="M12 15v5s3.03-.55 4-2c1.08-1.62 0-5 0-5" />
    </svg>
  );
}

const REPO_URL = 'https://github.com/junaaid96/paysim-bd';

function viewFromHash(): View {
  const id = window.location.hash.replace('#', '');
  return NAV.some((item) => item.id === id) ? (id as View) : 'overview';
}

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
        ? 'bg-zinc-800 text-zinc-300'
        : 'bg-amber-950 text-amber-300';
  return (
    <div className="flex flex-wrap items-center gap-1.5 text-[11px]">
      <span className={`rounded-full px-2 py-0.5 font-semibold ${badge}`}>
        {spec.data.fidelity}
      </span>
      <span className="text-zinc-500">
        {implemented}/{endpoints.length} endpoints · {verifiedFields} verified fields
      </span>
    </div>
  );
}

/** Human reference per gateway: invoice id, or the sim handle for bKash/Nagad/Upay. */
function txnReference(txn: TxnRecord): string {
  if (txn.gateway === 'bkash' || txn.gateway === 'nagad' || txn.gateway === 'upay')
    return txn.gatewaySessionKey ?? txn.id;
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
    <div className="card p-4">
      <div className="eyebrow">Fake clock</div>
      <div className="mt-2 flex flex-wrap items-baseline gap-2">
        <code className="text-lg font-semibold text-zinc-100">
          {clock.data ? new Date(clock.data.now).toLocaleString() : '…'}
        </code>
        <span className="rounded-full bg-zinc-800 px-2 py-0.5 text-xs text-zinc-400">
          {clock.data ? formatOffset(clock.data.offsetMs) : '…'}
        </span>
      </div>
      <p className="mt-1 text-xs text-zinc-500">
        Jump ahead to fire delayed callbacks, expiries and scheduled scenario steps instantly.
      </p>
      <div className="mt-3 flex flex-wrap gap-1.5">
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
            className="btn"
          >
            {step.label}
          </button>
        ))}
        <button type="button" disabled={busy} onClick={reset} className="btn">
          Reset
        </button>
      </div>
      {notice && <p className="mt-2 text-xs text-zinc-500">{notice}</p>}
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
    <label className="block text-xs text-zinc-500">
      Default scenario
      <select
        value={app.defaultScenarioId ?? ''}
        onChange={(event) => onChange(event.target.value)}
        className="input"
      >
        <option value="">manual (checkout page buttons)</option>
        {(scenarios.data ?? []).map((scenario) => (
          <option key={scenario.id} value={scenario.id}>
            {scenario.name}
            {scenario.global ? '' : ' (workspace)'}
          </option>
        ))}
      </select>
      {error && <span className="mt-1 block text-red-400">{error}</span>}
    </label>
  );
}

function appIdentifier(app: AppRecord): string {
  return String(
    app.credentials['store_id'] ??
      app.credentials['app_key'] ??
      app.credentials['merchant_id'] ??
      '?',
  );
}

function AppCard({ app, workspace }: { app: AppRecord; workspace: string }): JSX.Element {
  return (
    <div className="card flex flex-col gap-3 p-4">
      <div className="flex items-start gap-3">
        <GatewayMark gateway={app.gateway} />
        <div className="min-w-0 flex-1">
          <div className="truncate font-medium text-zinc-100">{app.name}</div>
          <div className="truncate text-xs text-zinc-500">
            {gatewayName(app.gateway)} · <code>{appIdentifier(app)}</code>
          </div>
        </div>
      </div>
      <FidelityBadge gateway={app.gateway} />
      <AppDefaultPicker app={app} workspace={workspace} />
    </div>
  );
}

function GatewaySummaryCards({
  apps,
  txns,
  onOpen,
}: {
  apps: AppRecord[];
  txns: TxnRecord[];
  onOpen: () => void;
}): JSX.Element {
  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
      {Object.entries(GATEWAYS).map(([id, meta]) => {
        const count = txns.filter((txn) => txn.gateway === id).length;
        const appCount = apps.filter((app) => app.gateway === id).length;
        return (
          <button
            key={id}
            type="button"
            onClick={onOpen}
            className="card flex items-center gap-3 p-4 text-left transition hover:border-zinc-600"
          >
            <GatewayMark gateway={id} />
            <div className="min-w-0 flex-1">
              <div className="font-medium text-zinc-100">{meta.name}</div>
              <div className="text-xs text-zinc-500">
                {appCount} app{appCount === 1 ? '' : 's'} · {count} transaction
                {count === 1 ? '' : 's'}
              </div>
            </div>
            <span className="text-zinc-600">›</span>
          </button>
        );
      })}
    </div>
  );
}

function StatCards({ txns }: { txns: TxnRecord[] }): JSX.Element {
  const ok = txns.filter((t) => ['valid', 'completed', 'success'].includes(t.state)).length;
  const bad = txns.filter((t) => ['failed', 'cancelled', 'expired'].includes(t.state)).length;
  const open = txns.length - ok - bad;
  const stats = [
    { label: 'Transactions', value: txns.length, tone: 'text-zinc-100' },
    { label: 'Succeeded', value: ok, tone: 'text-emerald-400' },
    { label: 'Failed / cancelled', value: bad, tone: 'text-red-400' },
    { label: 'In flight', value: open, tone: 'text-amber-300' },
  ];
  return (
    <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
      {stats.map((stat) => (
        <div key={stat.label} className="card p-4">
          <div className="eyebrow">{stat.label}</div>
          <div className={`mt-1 text-2xl font-semibold ${stat.tone}`}>{stat.value}</div>
        </div>
      ))}
    </div>
  );
}

function TxnTable({
  txns,
  onSelect,
  selectedId,
  compact = false,
}: {
  txns: TxnRecord[];
  onSelect: (id: string) => void;
  selectedId: string | null;
  compact?: boolean;
}): JSX.Element {
  return (
    <div className="card overflow-hidden">
      <div className="overflow-x-auto">
        <table className="w-full text-left text-sm">
          <thead className="border-b border-zinc-800 text-xs text-zinc-500">
            <tr>
              <th className="px-4 py-2.5 font-medium">Reference</th>
              <th className="hidden px-4 py-2.5 font-medium sm:table-cell">Gateway</th>
              <th className="px-4 py-2.5 text-right font-medium">Amount</th>
              <th className="px-4 py-2.5 font-medium">State</th>
              {!compact && <th className="px-4 py-2.5 font-medium">Created</th>}
            </tr>
          </thead>
          <tbody>
            {txns.map((txn) => (
              <tr
                key={txn.id}
                onClick={() => onSelect(txn.id)}
                className={`cursor-pointer border-b border-zinc-800 last:border-0 hover:bg-zinc-800/40 ${
                  selectedId === txn.id ? 'bg-zinc-800/50' : ''
                }`}
              >
                <td className="max-w-[16rem] truncate px-4 py-2.5">
                  <code className="text-zinc-200">{txnReference(txn)}</code>
                </td>
                <td className="hidden px-4 py-2.5 sm:table-cell">
                  <span className="inline-flex items-center gap-2 text-zinc-300">
                    <GatewayMark gateway={txn.gateway} size="sm" />
                    {gatewayName(txn.gateway)}
                  </span>
                </td>
                <td className="px-4 py-2.5 text-right font-medium whitespace-nowrap text-zinc-200 tabular-nums">
                  {formatAmount(txn.amountMinor, txn.currency)}
                </td>
                <td className="px-4 py-2.5">
                  <span className="inline-flex flex-wrap items-center gap-1">
                    <StateChip state={txn.state} />
                    <RefundChip txn={txn} />
                  </span>
                </td>
                {!compact && (
                  <td className="px-4 py-2.5 text-xs whitespace-nowrap text-zinc-500">
                    {new Date(txn.createdAt).toLocaleString()}
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function TxnDrawer({ txnId, onClose }: { txnId: string | null; onClose: () => void }): JSX.Element {
  useEffect(() => {
    if (!txnId) return;
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [txnId, onClose]);

  return (
    <div
      className={`fixed inset-0 z-40 ${txnId ? 'visible' : 'pointer-events-none invisible'}`}
      aria-hidden={!txnId}
    >
      <div
        className={`absolute inset-0 bg-black/50 backdrop-blur-[2px] transition-opacity ${
          txnId ? 'opacity-100' : 'opacity-0'
        }`}
        onClick={onClose}
      />
      <aside
        role="dialog"
        aria-label="Transaction detail"
        className={`absolute top-0 right-0 flex h-full w-full max-w-2xl flex-col border-l border-zinc-800 bg-zinc-950 shadow-2xl transition-transform duration-200 ${
          txnId ? 'translate-x-0' : 'translate-x-full'
        }`}
      >
        <div className="flex items-center justify-between border-b border-zinc-800 px-5 py-3">
          <span className="eyebrow">Transaction</span>
          <button type="button" onClick={onClose} className="btn" aria-label="Close">
            Esc ✕
          </button>
        </div>
        <div className="flex-1 overflow-y-auto px-5 py-4">
          {txnId && <TxnDetail key={txnId} txnId={txnId} />}
        </div>
      </aside>
    </div>
  );
}

function ScenarioCatalog({ workspace }: { workspace: string }): JSX.Element {
  const [gateway, setGateway] = useState('sslcommerz');
  const scenarios = useQuery({
    queryKey: ['scenarios', workspace, gateway],
    queryFn: () => fetchScenarios(workspace, gateway),
  });
  const marker =
    gateway === 'sslcommerz'
      ? 'value_d'
      : gateway === 'bkash'
        ? 'merchantInvoiceNumber'
        : 'orderId';
  return (
    <div className="card p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <div className="eyebrow">Scenario catalog</div>
          <p className="mt-1 text-xs text-zinc-500">
            Put <code className="text-zinc-300">SIM:&lt;name&gt;</code> in{' '}
            <code className="text-zinc-300">{marker}</code> to pick the outcome of a payment.
          </p>
        </div>
        <div className="flex rounded-lg border border-zinc-800 p-0.5">
          {Object.entries(GATEWAYS).map(([id, meta]) => (
            <button
              key={id}
              type="button"
              onClick={() => setGateway(id)}
              className={`rounded-md px-2.5 py-1 text-xs font-medium ${
                gateway === id ? 'bg-zinc-800 text-zinc-100' : 'text-zinc-500 hover:text-zinc-300'
              }`}
            >
              {meta.name}
            </button>
          ))}
        </div>
      </div>
      {scenarios.isPending && <p className="mt-3 text-sm text-zinc-500">Loading…</p>}
      {scenarios.isError && <p className="mt-3 text-sm text-red-400">Failed to load scenarios.</p>}
      <ul className="mt-3 grid grid-cols-1 gap-2 md:grid-cols-2">
        {(scenarios.data ?? []).map((scenario) => (
          <li key={scenario.id} className="rounded-lg border border-zinc-800 bg-zinc-950 p-3">
            <div className="flex items-center justify-between gap-2">
              <code className="text-sm font-medium text-zinc-100">SIM:{scenario.name}</code>
              <span className="text-[11px] text-zinc-500">
                {scenario.definition.steps.length} step
                {scenario.definition.steps.length === 1 ? '' : 's'}
              </span>
            </div>
            {scenario.definition.description && (
              <p className="mt-1 text-xs text-zinc-500">{scenario.definition.description}</p>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}

const CREDIT_HREF = 'https://junaidul.pro.bd/codejborg';

/**
 * "Developed by <CodeJBorg />" credit: one centered monospace line pinned to
 * the bottom of the sidebar (desktop and mobile drawer). Colors come from the
 * sidebar theme tokens in index.css, so both themes stay in sync.
 */
function CodeJBorgCredit(): JSX.Element {
  return (
    <a
      href={CREDIT_HREF}
      target="_blank"
      rel="noopener noreferrer"
      aria-label="Developed by CodeJBorg — visit developer website"
      className="mt-4 flex items-center justify-center gap-1.5 border-t border-sidebar-border pt-3 font-mono text-[11px] text-sidebar-foreground/55 transition-colors hover:text-sidebar-foreground"
    >
      <svg
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
        className="size-3.5"
      >
        <path d="m18 16 4-4-4-4" />
        <path d="m6 8-4 4 4 4" />
        <path d="m14.5 4-5 16" />
      </svg>
      <span>Developed by</span>
      <span className="font-semibold text-sidebar-foreground">
        <span className="text-sidebar-primary">&lt;</span>CodeJBorg
        <span className="text-sidebar-primary"> /&gt;</span>
      </span>
    </a>
  );
}

export default function App(): JSX.Element {
  const workspace = workspaceKey();
  const streamStatus = useLiveUpdates(workspace);
  const [theme, toggleTheme] = useTheme();
  const health = useQuery({ queryKey: ['health'], queryFn: fetchHealth, refetchInterval: 30_000 });
  const apps = useQuery({ queryKey: ['apps', workspace], queryFn: () => fetchApps(workspace) });
  const txns = useQuery({ queryKey: ['txns', workspace], queryFn: () => fetchTxns(workspace) });
  const [view, setView] = useState<View>(viewFromHash);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [navOpen, setNavOpen] = useState(false);
  const [startSeen, setStartSeen] = useState(
    () => window.localStorage.getItem(START_SEEN_KEY) === '1',
  );
  const [gatewayFilter, setGatewayFilter] = useState('all');
  const [search, setSearch] = useState('');

  useEffect(() => {
    const onHash = (): void => setView(viewFromHash());
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);

  useEffect(() => {
    if (view === 'start' && !startSeen) {
      window.localStorage.setItem(START_SEEN_KEY, '1');
      setStartSeen(true);
    }
  }, [view, startSeen]);

  const go = (next: View): void => {
    window.location.hash = next;
    setView(next);
    setNavOpen(false);
  };

  const allTxns = useMemo(() => txns.data ?? [], [txns.data]);
  const filtered = useMemo(
    () =>
      allTxns.filter(
        (txn) =>
          (gatewayFilter === 'all' || txn.gateway === gatewayFilter) &&
          (search.trim() === '' ||
            txnReference(txn).toLowerCase().includes(search.trim().toLowerCase())),
      ),
    [allTxns, gatewayFilter, search],
  );
  const closeDrawer = useCallback((): void => setSelectedId(null), []);
  const title = NAV.find((item) => item.id === view)?.label ?? 'Overview';
  const firstRun = txns.data !== undefined && allTxns.length === 0;
  const showStartBadge = !startSeen && txns.data !== undefined && allTxns.length === 0;

  const txnsBody = (list: TxnRecord[], compact: boolean): JSX.Element => {
    if (txns.isPending) return <p className="text-sm text-zinc-500">Loading transactions…</p>;
    if (txns.isError)
      return <p className="text-sm text-red-400">Failed: {(txns.error as Error).message}</p>;
    if (list.length === 0)
      return (
        <EmptyState title="No transactions yet" icon="⇄">
          POST a payment init to this simulator with a SIM: marker (for example{' '}
          <code>value_d=SIM:immediate-success</code>) and it lands here live.
        </EmptyState>
      );
    return (
      <TxnTable txns={list} onSelect={setSelectedId} selectedId={selectedId} compact={compact} />
    );
  };

  return (
    <div className="min-h-screen bg-zinc-950 text-zinc-100">
      <aside
        className={`fixed inset-y-0 left-0 z-30 flex w-64 flex-col border-r border-zinc-800 bg-zinc-900 transition-transform lg:translate-x-0 ${
          navOpen ? 'translate-x-0' : '-translate-x-full'
        }`}
      >
        <div className="flex items-center gap-2.5 px-5 py-5">
          <span className="inline-flex h-9 w-9 items-center justify-center rounded-xl bg-emerald-500 text-base font-black text-black">
            ৳
          </span>
          <div>
            <div className="text-sm font-bold tracking-tight text-zinc-100">PaySim BD</div>
            <div className="text-[11px] text-zinc-500">Payment gateway simulator</div>
          </div>
        </div>
        <div className="px-3 pb-3">
          <button
            type="button"
            onClick={() => go('start')}
            aria-current={view === 'start' ? 'page' : undefined}
            className={`flex w-full items-center gap-2.5 rounded-lg border border-primary/40 bg-primary-soft px-3 py-2.5 text-sm font-semibold text-primary transition hover:border-primary ${
              view === 'start' ? 'border-primary ring-1 ring-primary/40' : ''
            }`}
          >
            <RocketIcon />
            Get started
            {showStartBadge && (
              <span className="ml-auto inline-flex items-center gap-1.5 rounded-full border border-primary/40 px-1.5 py-0.5 text-[10px] font-medium tracking-wide uppercase">
                <span className="relative flex size-1.5">
                  <span className="absolute inline-flex size-full rounded-full bg-primary opacity-75 motion-safe:animate-ping" />
                  <span className="relative inline-flex size-1.5 rounded-full bg-primary" />
                </span>
                Start here
              </span>
            )}
          </button>
        </div>
        <nav className="flex-1 space-y-0.5 px-3">
          {NAV.filter((item) => item.id !== 'start').map((item) => (
            <button
              key={item.id}
              type="button"
              onClick={() => go(item.id)}
              className={`flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-sm font-medium transition ${
                view === item.id
                  ? 'bg-zinc-800 text-zinc-100'
                  : 'text-zinc-400 hover:bg-zinc-800/60 hover:text-zinc-200'
              }`}
            >
              <span className="w-4 text-center text-zinc-500">{item.icon}</span>
              {item.label}
              {item.extra && (
                <span className="ml-auto rounded-full border border-zinc-700 px-1.5 py-0.5 text-[10px] font-medium tracking-wide text-zinc-400 uppercase">
                  Extra
                </span>
              )}
              {item.id === 'transactions' && allTxns.length > 0 && (
                <span className="ml-auto rounded-full bg-zinc-800 px-1.5 text-[11px] text-zinc-400">
                  {allTxns.length}
                </span>
              )}
            </button>
          ))}
        </nav>
        <div className="space-y-3 border-t border-zinc-800 px-5 py-4">
          <div className="rounded-lg bg-amber-950 px-3 py-2 text-[11px] leading-snug text-amber-300">
            <strong>Simulator</strong> — fake money and fake credentials only. Never use real keys
            or customer data.
          </div>
          <div className="flex items-center justify-between gap-2 text-[11px] text-zinc-500">
            <span
              className="min-w-0 truncate"
              title={`API ${health.data ? `v${health.data.version}` : '…'} · ${workspace}`}
            >
              API {health.data ? `v${health.data.version}` : '…'} · {workspace}
            </span>
            <a
              href={REPO_URL}
              target="_blank"
              rel="noreferrer"
              className="shrink-0 whitespace-nowrap hover:text-zinc-300"
            >
              GitHub ↗
            </a>
          </div>
          <CodeJBorgCredit />
        </div>
      </aside>
      {navOpen && (
        <div
          className="fixed inset-0 z-20 bg-black/50 lg:hidden"
          onClick={() => setNavOpen(false)}
        />
      )}

      <div className="lg:pl-64">
        <header className="sticky top-0 z-10 flex items-center gap-3 border-b border-zinc-800 bg-zinc-950/85 px-4 py-3 backdrop-blur sm:px-6">
          <button
            type="button"
            className="btn lg:hidden"
            onClick={() => setNavOpen(true)}
            aria-label="Open navigation"
          >
            ☰
          </button>
          <h1 className="text-lg font-semibold tracking-tight">{title}</h1>
          <div className="ml-auto flex items-center gap-2">
            <LiveBadge
              status={streamStatus}
              label={streamStatus === 'live' ? 'Live' : streamStatus}
            />
            <span className="hidden rounded-full border border-amber-400/40 px-2.5 py-1 text-xs font-semibold text-amber-300 sm:inline">
              Sandbox simulator
            </span>
            <button
              type="button"
              onClick={toggleTheme}
              className="btn"
              aria-label="Toggle theme"
              title="Toggle dark / light"
            >
              {theme === 'dark' ? '☀ Light' : '☾ Dark'}
            </button>
          </div>
        </header>

        <main className="mx-auto max-w-7xl space-y-6 px-4 py-6 sm:px-6">
          {view === 'overview' && (
            <>
              {firstRun && (
                <div className="card flex flex-wrap items-center justify-between gap-3 border-primary/40 bg-primary-soft p-4">
                  <div className="flex items-start gap-3">
                    <span className="mt-0.5 text-primary">
                      <RocketIcon />
                    </span>
                    <div>
                      <div className="font-semibold text-primary">
                        New here? Run your first test payment in 2 minutes
                      </div>
                      <p className="text-sm text-zinc-400">
                        Follow Get started to point your app at this simulator and watch the fake
                        payment land here live.
                      </p>
                    </div>
                  </div>
                  <button type="button" className="btn-primary" onClick={() => go('start')}>
                    Get started →
                  </button>
                </div>
              )}
              <StatCards txns={allTxns} />
              <GatewaySummaryCards
                apps={apps.data ?? []}
                txns={allTxns}
                onOpen={() => go('gateways')}
              />
              <div className="grid grid-cols-1 gap-6 xl:grid-cols-5">
                <section className="xl:col-span-3">
                  <SectionHeader
                    title="Recent transactions"
                    description="Click a row to inspect its full request/callback timeline."
                    action={
                      <button type="button" className="btn" onClick={() => go('transactions')}>
                        View all →
                      </button>
                    }
                  />
                  {txnsBody(allTxns.slice(0, 8), true)}
                </section>
                <section className="xl:col-span-2">
                  <SectionHeader
                    title="Live activity"
                    description="Every gateway event, streamed as it happens."
                  />
                  <div className="card p-4">
                    <ActivityFeed workspace={workspace} />
                  </div>
                </section>
              </div>
            </>
          )}

          {view === 'transactions' && (
            <section>
              <SectionHeader
                title="All transactions"
                description="Filter by gateway or search by reference. Rows open a detail drawer."
                action={
                  <div className="flex flex-wrap gap-2">
                    <input
                      value={search}
                      onChange={(event) => setSearch(event.target.value)}
                      placeholder="Search reference…"
                      className="input mt-0 w-48"
                    />
                    <select
                      value={gatewayFilter}
                      onChange={(event) => setGatewayFilter(event.target.value)}
                      className="input mt-0 w-36"
                    >
                      <option value="all">All gateways</option>
                      {Object.entries(GATEWAYS).map(([id, meta]) => (
                        <option key={id} value={id}>
                          {meta.name}
                        </option>
                      ))}
                    </select>
                  </div>
                }
              />
              {txnsBody(filtered, false)}
            </section>
          )}

          {view === 'gateways' && (
            <>
              <section>
                <SectionHeader
                  title="Gateway apps"
                  description="Fake merchant stores your app authenticates with. Set a default scenario per app."
                />
                {apps.isPending && <p className="text-sm text-zinc-500">Loading…</p>}
                {apps.isError && (
                  <p className="text-sm text-red-400">Failed: {(apps.error as Error).message}</p>
                )}
                {apps.data && apps.data.length === 0 && (
                  <EmptyState title="No gateway apps yet" icon="▣">
                    Create one below — demo values are one click away.
                  </EmptyState>
                )}
                <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
                  {(apps.data ?? []).map((app) => (
                    <AppCard key={app.id} app={app} workspace={workspace} />
                  ))}
                </div>
              </section>
              <section>
                <SectionHeader
                  title="New gateway app"
                  description="Add another fake store, wallet merchant, Nagad, Rocket or Upay merchant."
                />
                <CreateAppForm workspace={workspace} />
              </section>
            </>
          )}

          {view === 'scenarios' && (
            <div className="grid grid-cols-1 gap-6 xl:grid-cols-3">
              <div className="xl:col-span-2">
                <ScenarioCatalog workspace={workspace} />
              </div>
              <div className="space-y-6">
                <ClockPanel workspace={workspace} />
                <div className="card p-4 text-sm text-zinc-400">
                  <div className="eyebrow">Per-transaction override</div>
                  <p className="mt-2 text-xs">
                    Open any transaction and attach a different scenario mid-flight — handy for
                    replaying late or duplicate IPNs against the same order.
                  </p>
                  <button type="button" className="btn mt-3" onClick={() => go('transactions')}>
                    Open transactions →
                  </button>
                </div>
              </div>
            </div>
          )}

          {view === 'sandbox' && (
            <RealSandboxPage
              apps={apps.data}
              loading={apps.isPending}
              onCreateApp={() => go('gateways')}
            />
          )}

          {view === 'start' && (
            <>
              <Onboarding workspace={workspace} />
              <QuickstartSnippet />
            </>
          )}

          <footer className="flex flex-wrap items-center justify-between gap-2 border-t border-zinc-800 pt-4 text-xs text-zinc-500">
            <span>PaySim BD · open source (MIT) · not affiliated with any payment provider</span>
          </footer>
        </main>
      </div>

      <TxnDrawer txnId={selectedId} onClose={closeDrawer} />
    </div>
  );
}
