import { useQuery } from '@tanstack/react-query';
import type { JSX } from 'react';

import { fetchHealth } from './api';

const GATEWAY_ROADMAP = [
  { name: 'SSLCommerz', phase: 'Phase 1' },
  { name: 'bKash', phase: 'Phase 3' },
  { name: 'Nagad', phase: 'Phase 4' },
];

export default function App(): JSX.Element {
  const health = useQuery({ queryKey: ['health'], queryFn: fetchHealth, refetchInterval: 10_000 });

  return (
    <div className="min-h-screen bg-zinc-950 text-zinc-100">
      <div className="bg-amber-400 px-4 py-2 text-center text-sm font-bold tracking-wide text-black">
        SIMULATOR — fake money, fake credentials. Never use real keys or real customer data here.
      </div>

      <main className="mx-auto max-w-3xl px-4 py-8">
        <h1 className="text-2xl font-bold">PaySim BD</h1>
        <p className="mt-1 text-zinc-400">
          Local-first simulator for Bangladeshi payment gateways.
        </p>

        <section className="mt-6 rounded-lg border border-zinc-800 bg-zinc-900 p-4">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-zinc-400">
            API status
          </h2>
          {health.isPending && <p className="mt-2">Checking…</p>}
          {health.isError && (
            <p className="mt-2 text-red-400">API unreachable: {(health.error as Error).message}</p>
          )}
          {health.data && (
            <dl className="mt-2 grid grid-cols-2 gap-2 text-sm">
              <dt className="text-zinc-400">Status</dt>
              <dd className="text-emerald-400">{health.data.status}</dd>
              <dt className="text-zinc-400">Version</dt>
              <dd>{health.data.version}</dd>
              <dt className="text-zinc-400">Time</dt>
              <dd>{health.data.now}</dd>
            </dl>
          )}
        </section>

        <section className="mt-6 rounded-lg border border-zinc-800 bg-zinc-900 p-4">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-zinc-400">Gateways</h2>
          <ul className="mt-2 space-y-1 text-sm">
            {GATEWAY_ROADMAP.map((g) => (
              <li key={g.name} className="flex justify-between">
                <span>{g.name}</span>
                <span className="text-zinc-500">{g.phase}</span>
              </li>
            ))}
          </ul>
        </section>
      </main>
    </div>
  );
}
