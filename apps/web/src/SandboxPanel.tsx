// "Real sandbox" (optional extra): connect a store to the provider's own
// sandbox instead of the simulator. The simulator stays the default and is
// untouched; client apps keep calling the same PaySim endpoints. Saved keys
// are encrypted server-side and only come back as masked hints.

import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useId, useState, type FormEvent, type JSX } from 'react';

import {
  fetchGateways,
  fetchSandboxStatus,
  testAppSandbox,
  updateAppSandbox,
  type AppRecord,
  type GatewayInfo,
  type SandboxCheck,
} from './api';
import { EmptyState, SectionHeader } from './ui';

const ORDER = ['sslcommerz', 'bkash', 'nagad'];

type Status = 'not_configured' | 'untested' | 'connected' | 'error';

function statusOf(app: AppRecord, check: SandboxCheck | undefined): Status {
  if (!app.sandbox.configured) return 'not_configured';
  if (!check) return 'untested';
  return check.ok ? 'connected' : 'error';
}

const STATUS_STYLE: Record<Status, { label: string; cls: string }> = {
  not_configured: { label: 'Not configured', cls: 'border-zinc-700 text-zinc-400' },
  untested: { label: 'Keys saved · not tested', cls: 'border-amber-400/40 text-amber-300' },
  connected: { label: 'Connected', cls: 'border-emerald-400/40 text-emerald-300' },
  error: { label: 'Error', cls: 'border-red-400/40 text-red-400' },
};

function StoreCard({ app, info }: { app: AppRecord; info: GatewayInfo['sandbox'] }): JSX.Element {
  const queryClient = useQueryClient();
  const check = useQuery({
    queryKey: ['sandbox-status', app.id],
    queryFn: () => fetchSandboxStatus(app.id),
    enabled: app.sandbox.configured,
  });
  const [editing, setEditing] = useState(false);
  const [values, setValues] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<null | 'save' | 'test' | 'toggle' | 'remove'>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const switchId = useId();

  const available = info?.status === 'available';
  const configured = app.sandbox.configured;
  const on = app.sandbox.mode === 'real';
  const lastCheck = configured ? (check.data ?? undefined) : undefined;
  const status = statusOf(app, lastCheck);
  const showForm = available && (editing || !configured);

  async function act(kind: NonNullable<typeof busy>, fn: () => Promise<string>): Promise<void> {
    setBusy(kind);
    setError(null);
    setNotice(null);
    try {
      setNotice(await fn());
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  }

  const refresh = async (): Promise<void> => {
    await queryClient.invalidateQueries({ queryKey: ['apps'] });
    await queryClient.invalidateQueries({ queryKey: ['sandbox-status', app.id] });
  };

  function onSave(event: FormEvent): void {
    event.preventDefault();
    if (!info) return;
    const keys: Record<string, string> = {};
    for (const field of info.fields) keys[field.name] = (values[field.name] ?? '').trim();
    if (Object.values(keys).some((v) => v === '')) {
      setError('Fill in every key.');
      return;
    }
    void act('save', async () => {
      await updateAppSandbox(app.id, { mode: on ? 'real' : 'simulator', keys });
      setEditing(false);
      setValues({});
      await refresh();
      return 'Keys saved (encrypted). Test the connection, then switch it on.';
    });
  }

  const onTest = (): void =>
    void act('test', async () => {
      const result = await testAppSandbox(app.id);
      queryClient.setQueryData(['sandbox-status', app.id], result);
      if (result && !result.ok) throw new Error(result.message);
      return result?.message ?? 'Checked.';
    });

  const onToggle = (): void =>
    void act('toggle', async () => {
      await updateAppSandbox(app.id, { mode: on ? 'simulator' : 'real' });
      await refresh();
      return on
        ? 'Back on the simulator.'
        : 'Real sandbox on: new payments for this store go to the provider sandbox.';
    });

  const onRemove = (): void =>
    void act('remove', async () => {
      await updateAppSandbox(app.id, { mode: 'simulator', clearKeys: true });
      await refresh();
      return 'Keys removed. This store uses the simulator.';
    });

  const st = STATUS_STYLE[status];

  return (
    <div className="card space-y-3 p-4">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="truncate text-sm font-semibold text-zinc-100" title={app.name}>
            {app.name}
          </div>
          <div className="text-xs text-zinc-500">
            {on ? 'Using the real provider sandbox' : 'Using the simulator'}
          </div>
        </div>
        <span
          className={`rounded-full border px-2 py-0.5 text-[11px] font-medium ${st.cls}`}
          role="status"
        >
          {st.label}
        </span>
      </div>

      {lastCheck && (
        <p className={`text-xs ${lastCheck.ok ? 'text-zinc-400' : 'text-red-400'}`}>
          {lastCheck.message}{' '}
          <span className="text-zinc-500">· {new Date(lastCheck.checkedAt).toLocaleString()}</span>
        </p>
      )}

      {configured && !editing && (
        <dl className="space-y-1 text-xs text-zinc-500">
          {Object.entries(app.sandbox.hints).map(([name, hint]) => (
            <div key={name} className="flex justify-between gap-2">
              <dt>{info?.fields.find((f) => f.name === name)?.label ?? name}</dt>
              <dd>
                <code className="truncate text-zinc-300">{hint}</code>
              </dd>
            </div>
          ))}
        </dl>
      )}

      {showForm && info && (
        <form className="space-y-2" onSubmit={onSave} autoComplete="off">
          {info.fields.map((field) => (
            <label key={field.name} className="block text-xs text-zinc-500">
              {field.label}
              {field.name.endsWith('_key') && field.secret ? (
                <textarea
                  className="input min-h-16 font-mono"
                  autoComplete="off"
                  spellCheck={false}
                  value={values[field.name] ?? ''}
                  onChange={(event) =>
                    setValues((prev) => ({ ...prev, [field.name]: event.target.value }))
                  }
                />
              ) : (
                <input
                  className="input"
                  type={field.secret ? 'password' : 'text'}
                  autoComplete="off"
                  spellCheck={false}
                  value={values[field.name] ?? ''}
                  onChange={(event) =>
                    setValues((prev) => ({ ...prev, [field.name]: event.target.value }))
                  }
                />
              )}
            </label>
          ))}
          <div className="flex flex-wrap gap-2">
            <button type="submit" className="btn-primary text-xs" disabled={busy !== null}>
              {busy === 'save' ? 'Saving…' : 'Save keys'}
            </button>
            {info.publicTestKeys && (
              <button
                type="button"
                className="btn"
                disabled={busy !== null}
                onClick={() => setValues({ ...info.publicTestKeys })}
              >
                Fill public test keys
              </button>
            )}
            {configured && (
              <button type="button" className="btn" onClick={() => setEditing(false)}>
                Cancel
              </button>
            )}
          </div>
        </form>
      )}

      {configured && !editing && (
        <div className="flex flex-wrap items-center gap-2">
          <button type="button" className="btn" disabled={busy !== null} onClick={onTest}>
            {busy === 'test' ? 'Testing…' : 'Test connection'}
          </button>
          <button
            type="button"
            className="btn"
            disabled={busy !== null}
            onClick={() => setEditing(true)}
          >
            Replace keys
          </button>
          <button type="button" className="btn" disabled={busy !== null} onClick={onRemove}>
            Remove keys
          </button>
        </div>
      )}

      {configured && (
        <div className="flex items-center justify-between gap-3 border-t border-zinc-800 pt-3">
          <label htmlFor={switchId} className="text-xs text-zinc-300">
            Use Real sandbox for this store
          </label>
          <button
            id={switchId}
            type="button"
            role="switch"
            aria-checked={on}
            disabled={busy !== null}
            onClick={onToggle}
            className={`relative inline-flex h-5 w-9 shrink-0 items-center rounded-full border transition disabled:opacity-50 ${
              on ? 'border-primary bg-primary' : 'border-zinc-700 bg-zinc-800'
            }`}
          >
            <span
              className={`inline-block size-3.5 rounded-full bg-zinc-100 shadow transition ${
                on ? 'translate-x-4' : 'translate-x-0.5'
              }`}
            />
          </button>
        </div>
      )}

      {notice && (
        <p role="status" className="text-xs text-zinc-400">
          {notice}
        </p>
      )}
      {error && (
        <p role="alert" className="text-xs text-red-400">
          {error}
        </p>
      )}
    </div>
  );
}

export default function RealSandboxPage({
  apps,
  loading,
  onCreateApp,
}: {
  apps: AppRecord[] | undefined;
  loading: boolean;
  onCreateApp: () => void;
}): JSX.Element {
  const gateways = useQuery({ queryKey: ['gateways'], queryFn: fetchGateways, staleTime: 60_000 });
  const infos = [...(gateways.data ?? [])].sort(
    (a, b) => ORDER.indexOf(a.gateway) - ORDER.indexOf(b.gateway),
  );

  return (
    <div className="space-y-6">
      <section className="card space-y-2 p-4 text-sm text-zinc-400">
        <div className="flex flex-wrap items-center gap-2">
          <span className="rounded-full border border-zinc-700 px-1.5 py-0.5 text-[10px] font-medium tracking-wide text-zinc-400 uppercase">
            Optional extra
          </span>
          <h2 className="text-base font-semibold text-zinc-100">
            Connect a store to the provider’s own sandbox
          </h2>
        </div>
        <p>
          PaySim works fully without this page: every store uses the simulator by default. If you
          have sandbox keys from SSLCommerz, bKash or Nagad, save them here per store, test the
          connection and switch it on. Your app keeps calling the same PaySim endpoints, and
          webhooks, the live feed and refunds keep working. Scenarios don’t apply to stores on the
          real sandbox.
        </p>
        <p className="text-xs text-zinc-500">
          Sandbox keys only, never production keys. Keys are encrypted at rest and only shown
          masked.
        </p>
      </section>

      {(loading || gateways.isPending) && <p className="text-sm text-zinc-500">Loading…</p>}
      {gateways.isError && (
        <p className="text-sm text-red-400">Failed: {(gateways.error as Error).message}</p>
      )}

      {!loading && apps && apps.length === 0 && (
        <EmptyState title="No stores to connect yet" icon="⇆">
          Create a gateway app first, then come back to connect it to a real sandbox.
          <div className="mt-3">
            <button type="button" className="btn" onClick={onCreateApp}>
              Go to Gateways →
            </button>
          </div>
        </EmptyState>
      )}

      {apps &&
        apps.length > 0 &&
        infos.map((gw) => {
          const list = apps.filter((app) => app.gateway === gw.gateway);
          const info = gw.sandbox;
          return (
            <section key={gw.gateway}>
              <SectionHeader
                title={gw.displayName}
                description={info?.note ?? 'Simulator only.'}
                action={
                  info ? (
                    <div className="flex gap-3 text-xs">
                      {info.signupUrl && (
                        <a
                          href={info.signupUrl}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-primary underline-offset-2 hover:underline"
                        >
                          Get sandbox access ↗
                        </a>
                      )}
                      <a
                        href={info.docsUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-primary underline-offset-2 hover:underline"
                      >
                        Docs ↗
                      </a>
                    </div>
                  ) : undefined
                }
              />
              {list.length === 0 ? (
                <p className="text-xs text-zinc-500">
                  No {gw.displayName} store in this workspace yet.
                </p>
              ) : (
                <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
                  {list.map((app) => (
                    <StoreCard key={app.id} app={app} info={info} />
                  ))}
                </div>
              )}
            </section>
          );
        })}
    </div>
  );
}
