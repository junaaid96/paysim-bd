// Per-app mode switch: Simulator (default) or Real sandbox (the provider's
// own sandbox, proxied by PaySim). Saved keys are encrypted server-side and
// only come back as masked hints.

import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useId, useState, type FormEvent, type JSX } from 'react';

import { fetchGateways, updateAppSandbox, type AppRecord } from './api';

export function SandboxPanel({ app }: { app: AppRecord }): JSX.Element {
  const queryClient = useQueryClient();
  const gateways = useQuery({ queryKey: ['gateways'], queryFn: fetchGateways, staleTime: 60_000 });
  const info = gateways.data?.find((g) => g.gateway === app.gateway)?.sandbox ?? null;
  const [editing, setEditing] = useState(false);
  const [values, setValues] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const groupId = useId();

  const available = info?.status === 'available';
  const mode = app.sandbox.mode;
  const configured = app.sandbox.configured;
  const showForm = available && (editing || !configured);

  async function run(input: Parameters<typeof updateAppSandbox>[1], done: string): Promise<void> {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await updateAppSandbox(app.id, input);
      await queryClient.invalidateQueries({ queryKey: ['apps'] });
      setNotice(done);
      setEditing(false);
      setValues({});
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  function setMode(next: 'simulator' | 'real'): void {
    if (next === mode) return;
    if (next === 'real' && !configured) {
      setEditing(true);
      setNotice('Save this gateway’s sandbox keys first, then switch to Real sandbox.');
      return;
    }
    void run(
      { mode: next },
      next === 'real'
        ? 'Real sandbox on: new payments go to the provider sandbox.'
        : 'Simulator on.',
    );
  }

  function onSave(event: FormEvent): void {
    event.preventDefault();
    if (!info) return;
    const keys: Record<string, string> = {};
    for (const field of info.fields) keys[field.name] = (values[field.name] ?? '').trim();
    if (Object.values(keys).some((v) => v === '')) {
      setError('Fill in every key.');
      return;
    }
    void run({ mode: 'real', keys }, 'Keys saved (encrypted). Real sandbox is on.');
  }

  return (
    <div className="rounded-lg border border-zinc-800 p-3">
      <div className="flex items-center justify-between gap-2">
        <span id={groupId} className="eyebrow">
          Mode
        </span>
        <div
          role="radiogroup"
          aria-labelledby={groupId}
          className="inline-flex rounded-lg border border-zinc-700 p-0.5 text-xs"
        >
          {(['simulator', 'real'] as const).map((option) => {
            const active = mode === option;
            const disabled = busy || (option === 'real' && !available);
            return (
              <button
                key={option}
                type="button"
                role="radio"
                aria-checked={active}
                disabled={disabled}
                onClick={() => setMode(option)}
                className={`rounded-md px-2.5 py-1 font-medium transition disabled:opacity-50 ${
                  active ? 'bg-primary-soft text-primary' : 'text-zinc-400 hover:text-zinc-200'
                }`}
              >
                {option === 'simulator' ? 'Simulator' : 'Real sandbox'}
              </button>
            );
          })}
        </div>
      </div>

      {gateways.isPending && <p className="mt-2 text-xs text-zinc-500">Loading…</p>}

      {info && !available && (
        <p className="mt-2 text-xs text-zinc-500">
          <span className="font-medium text-zinc-300">Requires Nagad merchant credentials.</span>{' '}
          {info.note}
        </p>
      )}

      {available && mode === 'real' && (
        <p className="mt-2 text-xs text-zinc-400">
          Payments open the provider’s own sandbox page. Scenarios and checkout buttons don’t apply;
          webhooks, the live feed and refunds keep working.
        </p>
      )}

      {available && configured && !editing && (
        <div className="mt-2 space-y-1 text-xs text-zinc-500">
          {Object.entries(app.sandbox.hints).map(([name, hint]) => (
            <div key={name} className="flex justify-between gap-2">
              <span>{info?.fields.find((f) => f.name === name)?.label ?? name}</span>
              <code className="truncate text-zinc-300">{hint}</code>
            </div>
          ))}
          <div className="flex flex-wrap gap-2 pt-1">
            <button type="button" className="btn" disabled={busy} onClick={() => setEditing(true)}>
              Replace keys
            </button>
            <button
              type="button"
              className="btn"
              disabled={busy}
              onClick={() => void run({ mode: 'simulator', clearKeys: true }, 'Keys removed.')}
            >
              Remove keys
            </button>
          </div>
        </div>
      )}

      {showForm && info && (
        <form className="mt-2 space-y-2" onSubmit={onSave} autoComplete="off">
          <p className="text-xs text-zinc-500">
            {info.note}{' '}
            <a
              href={info.docsUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="text-primary underline-offset-2 hover:underline"
            >
              Provider docs
            </a>
          </p>
          {info.fields.map((field) => (
            <label key={field.name} className="block text-xs text-zinc-500">
              {field.label}
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
            </label>
          ))}
          <div className="flex flex-wrap gap-2">
            <button type="submit" className="btn-primary text-xs" disabled={busy}>
              {busy ? 'Saving…' : 'Save keys & use Real sandbox'}
            </button>
            {info.publicTestKeys && (
              <button
                type="button"
                className="btn"
                disabled={busy}
                onClick={() => setValues({ ...info.publicTestKeys })}
              >
                Use public test keys
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

      {notice && (
        <p role="status" className="mt-2 text-xs text-zinc-400">
          {notice}
        </p>
      )}
      {error && (
        <p role="alert" className="mt-2 text-xs text-red-400">
          {error}
        </p>
      )}
    </div>
  );
}
