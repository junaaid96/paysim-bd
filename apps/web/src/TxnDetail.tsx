import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type JSX, type ReactNode } from 'react';

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
import { GatewayMark, StateChip, formatAmount, gatewayName } from './ui';

function formatTime(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : date.toLocaleTimeString();
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
    <button type="button" onClick={onClick} className="btn">
      {label}
    </button>
  );
}

function eventTone(type: string): string {
  if (/success|completed|valid|delivered|ready/.test(type)) return 'bg-emerald-400';
  if (/fail|cancel|dead|expire|error/.test(type)) return 'bg-red-400';
  if (/scenario|clock/.test(type)) return 'bg-violet-400';
  return 'bg-zinc-500';
}

function TimelineItem({ dot, children }: { dot: string; children: ReactNode }): JSX.Element {
  return (
    <li className="relative pb-4 pl-6 last:pb-0">
      <span className="absolute top-0 bottom-0 left-[5px] w-px bg-zinc-800" />
      <span
        className={`absolute top-3 left-0 h-[11px] w-[11px] rounded-full ring-4 ring-zinc-950 ${dot}`}
      />
      <div className="rounded-lg border border-zinc-800 bg-zinc-900 p-3">{children}</div>
    </li>
  );
}

function EventRow({ event }: { event: EventRecord }): JSX.Element {
  const http = (event.data['http'] ?? null) as HttpCapture | null;
  return (
    <TimelineItem dot={eventTone(event.type)}>
      <div className="flex items-center justify-between gap-2">
        <div className="min-w-0 text-sm">
          <code className="text-zinc-100">{event.type}</code>
          <div className="text-[11px] text-zinc-500">{formatTime(event.createdAt)}</div>
        </div>
        {http ? <CopyCurlButton capture={http} /> : null}
      </div>
      <details className="mt-2">
        <summary className="cursor-pointer text-xs text-zinc-500 hover:text-zinc-300">
          Payload (secrets redacted)
        </summary>
        <pre className="mt-2 max-h-72 overflow-auto rounded-md bg-zinc-950 p-2 text-xs text-zinc-300">
          {JSON.stringify(event.data, null, 2)}
        </pre>
      </details>
    </TimelineItem>
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
      className="btn"
    >
      ↻ {label}
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
    <div className="rounded-lg border border-zinc-800 bg-zinc-900 p-3 text-xs">
      <div className="flex flex-wrap items-end gap-2">
        <label className="min-w-[14rem] flex-1 text-zinc-500">
          Scenario override
          <select
            value={txn.scenarioOverrideId ?? ''}
            disabled={busy}
            onChange={(event) => attach(event.target.value === '' ? null : event.target.value)}
            className="input"
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
          <button type="button" disabled={busy} onClick={() => attach(null)} className="btn">
            Detach
          </button>
        )}
      </div>
      {current?.definition.description && (
        <p className="mt-2 text-zinc-500">{current.definition.description}</p>
      )}
      {error && <p className="mt-2 text-red-400">{error}</p>}
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
    <TimelineItem dot={ok ? 'bg-emerald-400' : 'bg-red-400'}>
      <div className="flex items-center justify-between gap-2">
        <div className="min-w-0 text-sm">
          <code className="block truncate text-zinc-100">
            {delivery.kind.toUpperCase()} → {delivery.targetUrl}
          </code>
          <div className="text-[11px] text-zinc-500">{formatTime(delivery.createdAt)}</div>
        </div>
        <ReplayButton txnId={txnId} deliveryId={delivery.id} />
      </div>
      <div className="mt-2 flex flex-wrap gap-1.5 text-[11px]">
        <span
          className={`rounded-full px-2 py-0.5 font-semibold ${
            ok ? 'bg-emerald-900 text-emerald-300' : 'bg-red-900 text-red-300'
          }`}
        >
          {delivery.status}
        </span>
        <span className="rounded-full bg-zinc-800 px-2 py-0.5 text-zinc-400">
          attempt #{delivery.attemptNo}
        </span>
        {delivery.latencyMs !== null && (
          <span className="rounded-full bg-zinc-800 px-2 py-0.5 text-zinc-400">
            {delivery.latencyMs} ms
          </span>
        )}
        {delivery.responseStatus !== null && (
          <span className="rounded-full bg-zinc-800 px-2 py-0.5 text-zinc-400">
            HTTP {delivery.responseStatus}
          </span>
        )}
      </div>
      <details className="mt-2">
        <summary className="cursor-pointer text-xs text-zinc-500 hover:text-zinc-300">
          Request / response
        </summary>
        <pre className="mt-2 max-h-72 overflow-auto rounded-md bg-zinc-950 p-2 text-xs text-zinc-300">
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
    </TimelineItem>
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
    <div className="space-y-4">
      <div className="flex items-start gap-3">
        <GatewayMark gateway={txn.gateway} />
        <div className="min-w-0 flex-1">
          <h2 className="truncate text-lg font-semibold text-zinc-100">
            <code>{txn.gatewayTxnId ?? txn.id}</code>
          </h2>
          <div className="mt-0.5 flex flex-wrap items-center gap-2 text-sm text-zinc-400">
            <StateChip state={txn.state} />
            <span>{gatewayName(txn.gateway)}</span>
          </div>
        </div>
        <div className="text-xl font-semibold text-zinc-100 tabular-nums">
          {formatAmount(txn.amountMinor, txn.currency)}
        </div>
      </div>
      <dl className="grid grid-cols-1 gap-2 rounded-lg border border-zinc-800 bg-zinc-900 p-3 text-xs sm:grid-cols-2">
        <div>
          <dt className="text-zinc-500">Session</dt>
          <dd className="truncate text-zinc-300">
            <code>{txn.gatewaySessionKey ?? '—'}</code>
          </dd>
        </div>
        <div>
          <dt className="text-zinc-500">Created</dt>
          <dd className="text-zinc-300">{new Date(txn.createdAt).toLocaleString()}</dd>
        </div>
      </dl>
      <ScenarioPicker txn={txn} />
      <div>
        <h3 className="eyebrow mb-3">Timeline · live</h3>
        <ul>{timeline.map((entry) => entry.node)}</ul>
      </div>
    </div>
  );
}
