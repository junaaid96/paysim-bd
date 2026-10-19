import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type JSX } from 'react';

import {
  attachTxnScenario,
  fetchScenarios,
  fetchTxnDetail,
  replayDelivery,
  workspaceKey,
  type DeliveryRecord,
  type EventRecord,
  type TxnRecord,
} from './api';
import { buildCurl, copyText, type HttpCapture } from './curl';

function formatTime(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : date.toLocaleTimeString();
}

function formatAmount(minor: number, currency: string): string {
  return `${(minor / 100).toFixed(2)} ${currency}`;
}

function StateChip({ state }: { state: string }): JSX.Element {
  const color =
    state === 'valid' || state === 'completed' || state === 'success'
      ? 'bg-emerald-900 text-emerald-300'
      : state === 'initiated'
        ? 'bg-zinc-700 text-zinc-200'
        : state === 'verified' || state === 'checkout'
          ? 'bg-sky-900 text-sky-300'
          : state === 'failed' || state === 'cancelled' || state === 'expired'
            ? 'bg-red-900 text-red-300'
            : 'bg-zinc-700 text-zinc-200';
  return <span className={`rounded px-2 py-0.5 text-xs font-semibold ${color}`}>{state}</span>;
}

function CopyCurlButton({ capture }: { capture: HttpCapture }): JSX.Element {
  const [label, setLabel] = useState('Copy as curl');
  const command = buildCurl(capture, window.location.origin);
  if (!command) return <span />;
  const onClick = (): void => {
    void copyText(command).then((ok) => {
      setLabel(ok ? 'Copied!' : 'Copy failed');
      setTimeout(() => setLabel('Copy as curl'), 1500);
    });
  };
  return (
    <button
      type="button"
      onClick={onClick}
      className="rounded border border-zinc-700 px-2 py-0.5 text-xs hover:bg-zinc-800"
    >
      {label}
    </button>
  );
}

function EventRow({ event }: { event: EventRecord }): JSX.Element {
  const http = (event.data['http'] ?? null) as HttpCapture | null;
  return (
    <li className="rounded border border-zinc-800 bg-zinc-900 p-2">
      <div className="flex items-center justify-between gap-2">
        <div className="text-sm">
          <span className="text-zinc-500">{formatTime(event.createdAt)}</span>{' '}
          <code className="text-zinc-200">{event.type}</code>
        </div>
        {http ? <CopyCurlButton capture={http} /> : null}
      </div>
      <details className="mt-1">
        <summary className="cursor-pointer text-xs text-zinc-500">
          payload (secrets redacted)
        </summary>
        <pre className="mt-1 overflow-auto rounded bg-zinc-950 p-2 text-xs text-zinc-300">
          {JSON.stringify(event.data, null, 2)}
        </pre>
      </details>
    </li>
  );
}

function ReplayButton({ txnId, deliveryId }: { txnId: string; deliveryId: string }): JSX.Element {
  const queryClient = useQueryClient();
  const [label, setLabel] = useState('Replay');
  const onClick = (): void => {
    setLabel('…');
    replayDelivery(txnId, deliveryId)
      .then(() => {
        setLabel('Sent!');
        return queryClient.invalidateQueries();
      })
      .catch((err: unknown) => {
        setLabel(err instanceof Error ? err.message : 'failed');
      })
      .finally(() => {
        setTimeout(() => setLabel('Replay'), 2000);
      });
  };
  return (
    <button
      type="button"
      onClick={onClick}
      title="Re-POST this callback payload as a fresh attempt"
      className="rounded border border-zinc-700 px-2 py-0.5 text-xs hover:bg-zinc-800"
    >
      {label}
    </button>
  );
}

function ScenarioPicker({ txn }: { txn: TxnRecord }): JSX.Element {
  const queryClient = useQueryClient();
  const workspace = workspaceKey();
  const scenarios = useQuery({
    queryKey: ['scenarios', workspace, txn.gateway],
    queryFn: () => fetchScenarios(workspace, txn.gateway),
  });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const current = (scenarios.data ?? []).find((scenario) => scenario.id === txn.scenarioOverrideId);

  const attach = (scenarioId: string | null): void => {
    setError(null);
    setBusy(true);
    attachTxnScenario(txn.id, scenarioId)
      .then(() => queryClient.invalidateQueries())
      .catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)))
      .finally(() => setBusy(false));
  };

  return (
    <div className="mt-2 flex flex-wrap items-center gap-2 text-xs">
      <label className="text-zinc-500">
        scenario override:{' '}
        <select
          value={txn.scenarioOverrideId ?? ''}
          disabled={busy}
          onChange={(event) => attach(event.target.value === '' ? null : event.target.value)}
          className="rounded border border-zinc-700 bg-zinc-950 px-1 py-0.5 text-zinc-200 disabled:opacity-50"
        >
          <option value="">none{current ? '' : ' (as attached at init)'}</option>
          {(scenarios.data ?? []).map((scenario) => (
            <option key={scenario.id} value={scenario.id}>
              {scenario.name}
              {scenario.global ? '' : ' (workspace)'} · {scenario.definition.steps.length} steps
            </option>
          ))}
        </select>
      </label>
      {txn.scenarioOverrideId && (
        <button
          type="button"
          disabled={busy}
          onClick={() => attach(null)}
          className="rounded border border-zinc-700 px-2 py-0.5 hover:bg-zinc-800 disabled:opacity-50"
        >
          Detach
        </button>
      )}
      {current?.definition.description && (
        <span className="text-zinc-500">{current.definition.description}</span>
      )}
      {error && <span className="text-red-400">{error}</span>}
    </div>
  );
}

function DeliveryRow({
  txnId,
  delivery,
}: {
  txnId: string;
  delivery: DeliveryRecord;
}): JSX.Element {
  const ok = delivery.status === 'delivered';
  return (
    <li className="rounded border border-zinc-800 bg-zinc-900 p-2">
      <div className="flex items-center justify-between gap-2">
        <div className="text-sm">
          <span className="text-zinc-500">{formatTime(delivery.createdAt)}</span>{' '}
          <code className="text-zinc-200">
            {delivery.kind} → {delivery.targetUrl}
          </code>
        </div>
        <ReplayButton txnId={txnId} deliveryId={delivery.id} />
      </div>
      <div className="mt-1 flex flex-wrap gap-2 text-xs text-zinc-400">
        <span className={ok ? 'text-emerald-400' : 'text-red-400'}>{delivery.status}</span>
        <span>attempt #{delivery.attemptNo}</span>
        {delivery.latencyMs !== null && <span>{delivery.latencyMs} ms</span>}
        {delivery.responseStatus !== null && <span>HTTP {delivery.responseStatus}</span>}
      </div>
      <details className="mt-1">
        <summary className="cursor-pointer text-xs text-zinc-500">request / response</summary>
        <pre className="mt-1 overflow-auto rounded bg-zinc-950 p-2 text-xs text-zinc-300">
          {JSON.stringify(
            {
              requestBody: delivery.requestBody,
              requestBodyKey: delivery.requestBodyKey,
              responseSnippet: delivery.responseSnippet,
              responseBodyKey: delivery.responseBodyKey,
            },
            null,
            2,
          )}
        </pre>
      </details>
    </li>
  );
}

export default function TxnDetail({ txnId }: { txnId: string }): JSX.Element {
  const detail = useQuery({ queryKey: ['txn', txnId], queryFn: () => fetchTxnDetail(txnId) });

  if (detail.isPending) return <p className="text-sm text-zinc-400">Loading…</p>;
  if (detail.isError)
    return <p className="text-sm text-red-400">Failed: {(detail.error as Error).message}</p>;

  const { txn, events, deliveries } = detail.data;
  const timeline: Array<{ at: string; node: JSX.Element }> = [
    ...events.map((event) => ({
      at: event.createdAt,
      node: <EventRow key={event.id} event={event} />,
    })),
    ...deliveries.map((delivery) => ({
      at: delivery.createdAt,
      node: <DeliveryRow key={delivery.id} txnId={txn.id} delivery={delivery} />,
    })),
  ].sort((a, b) => (a.at < b.at ? -1 : 1));

  return (
    <div>
      <div className="flex flex-wrap items-center gap-3">
        <h2 className="text-lg font-semibold">
          <code>{txn.gatewayTxnId ?? txn.id}</code>
        </h2>
        <StateChip state={txn.state} />
        <span className="text-sm text-zinc-400">
          {txn.gateway} · {formatAmount(txn.amountMinor, txn.currency)}
        </span>
      </div>
      <dl className="mt-2 grid grid-cols-2 gap-1 text-xs text-zinc-400">
        <dt>Session</dt>
        <dd className="truncate">
          <code>{txn.gatewaySessionKey ?? '—'}</code>
        </dd>
        <dt>Created</dt>
        <dd>{new Date(txn.createdAt).toLocaleString()}</dd>
      </dl>
      <ScenarioPicker txn={txn} />
      <h3 className="mt-4 text-sm font-semibold uppercase tracking-wide text-zinc-400">
        Timeline (live)
      </h3>
      <ul className="mt-2 space-y-2">{timeline.map((entry) => entry.node)}</ul>
    </div>
  );
}
