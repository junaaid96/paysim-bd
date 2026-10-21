import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type JSX } from 'react';

import { createApp, fetchScenarios } from './api';
import { copyText } from './curl';

interface GatewayGuide {
  gateway: string;
  displayName: string;
  init: string;
  magicField: string;
  magicExample: string;
}

// Mirrors the plugin routes and magic markers in packages/gateways/*/src.
// Scenario names below are loaded live from the API; only the endpoint
// shapes and marker fields are static.
const GUIDES: GatewayGuide[] = [
  {
    gateway: 'sslcommerz',
    displayName: 'SSLCommerz',
    init: 'POST /gwprocess/v4/api.php',
    magicField: 'value_d',
    magicExample: 'SIM:immediate-success',
  },
  {
    gateway: 'bkash',
    displayName: 'bKash',
    init: 'POST /v2/tokenized-checkout/payment/create (after auth/grant-token)',
    magicField: 'merchantInvoiceNumber',
    magicExample: 'SIM:immediate-success',
  },
  {
    gateway: 'nagad',
    displayName: 'Nagad',
    init: 'POST /remote-payment-gateway-1.0/api/dfs/check-out/initialize/:merchantId/:orderId',
    magicField: 'orderId',
    magicExample: 'SIM:immediate-success:my-order-1',
  },
];

function CopyButton({ text, label }: { text: string; label: string }): JSX.Element {
  const [state, setState] = useState(label);
  const onClick = (): void => {
    void copyText(text).then((ok) => {
      setState(ok ? 'Copied' : 'Copy failed');
      setTimeout(() => setState(label), 1500);
    });
  };
  return (
    <button
      type="button"
      onClick={onClick}
      className="shrink-0 rounded border border-zinc-700 px-2 py-0.5 text-xs hover:bg-zinc-800"
    >
      {state}
    </button>
  );
}

function ScenarioNames({
  workspace,
  gateway,
}: {
  workspace: string;
  gateway: string;
}): JSX.Element {
  const scenarios = useQuery({
    queryKey: ['scenarios', workspace, gateway],
    queryFn: () => fetchScenarios(workspace, gateway),
  });
  if (scenarios.isPending) return <span className="text-xs text-zinc-500">loading…</span>;
  if (scenarios.isError || !scenarios.data)
    return <span className="text-xs text-red-400">failed to load</span>;
  return (
    <span className="flex flex-wrap gap-1">
      {scenarios.data.map((scenario) => (
        <code key={scenario.id} className="rounded bg-zinc-950 px-1.5 py-0.5 text-xs text-zinc-300">
          SIM:{scenario.name}
        </code>
      ))}
    </span>
  );
}

function GatewayGuideRow({
  workspace,
  guide,
}: {
  workspace: string;
  guide: GatewayGuide;
}): JSX.Element {
  return (
    <div className="rounded border border-zinc-800 bg-zinc-900 p-3">
      <div className="font-medium">{guide.displayName}</div>
      <code className="mt-1 block truncate text-xs text-zinc-400" title={guide.init}>
        {guide.init}
      </code>
      <p className="mt-2 text-xs text-zinc-500">
        Pick the outcome per payment with <code className="text-zinc-300">{guide.magicField}</code>{' '}
        = <code className="text-zinc-300">{guide.magicExample}</code>
      </p>
      <div className="mt-1.5">
        <ScenarioNames workspace={workspace} gateway={guide.gateway} />
      </div>
    </div>
  );
}

interface CredentialField {
  key: string;
  label: string;
  secret?: boolean;
  textarea?: boolean;
  hint?: string;
}

const CREDENTIAL_FIELDS: Record<string, CredentialField[]> = {
  sslcommerz: [
    { key: 'store_id', label: 'store_id' },
    { key: 'store_passwd', label: 'store_passwd', secret: true },
  ],
  bkash: [
    { key: 'app_key', label: 'app_key' },
    { key: 'app_secret', label: 'app_secret', secret: true },
    { key: 'username', label: 'username' },
    { key: 'password', label: 'password', secret: true },
  ],
  nagad: [
    { key: 'merchant_id', label: 'merchant_id' },
    { key: 'merchant_number', label: 'merchant_number', hint: '11 digits, starts with 01' },
    {
      key: 'merchant_public_key',
      label: 'merchant_public_key',
      textarea: true,
      hint: 'RSA public key (PEM or base64) — used to seal Nagad payloads',
    },
  ],
};

function demoCredentials(gateway: string): Record<string, string> {
  const suffix = Math.random().toString(36).slice(2, 6);
  if (gateway === 'bkash') {
    return {
      app_key: `sim-app-key-${suffix}`,
      app_secret: 'sim-app-secret-key',
      username: 'sim-merchant',
      password: 'sim-merchant-password',
    };
  }
  if (gateway === 'nagad') {
    return { merchant_id: `SIM-MERCHANT-${suffix.toUpperCase()}`, merchant_number: '01700000000' };
  }
  return { store_id: `testbox-${suffix}`, store_passwd: 'qwerty' };
}

function CreateAppForm({ workspace }: { workspace: string }): JSX.Element {
  const queryClient = useQueryClient();
  const [gateway, setGateway] = useState('sslcommerz');
  const [name, setName] = useState('');
  const [values, setValues] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const fields = CREDENTIAL_FIELDS[gateway] ?? [];

  const fillDemo = (): void => {
    setValues(demoCredentials(gateway));
    if (name.trim() === '') setName(`demo-${gateway}`);
  };

  const submit = (): void => {
    setError(null);
    setBusy(true);
    createApp({ workspaceKey: workspace, gateway, name: name.trim(), credentials: values })
      .then(() => {
        setName('');
        setValues({});
        return queryClient.invalidateQueries();
      })
      .catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)))
      .finally(() => setBusy(false));
  };

  return (
    <div className="mt-2 rounded border border-zinc-800 bg-zinc-900 p-3 text-sm">
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
        <label className="text-xs text-zinc-500">
          gateway
          <select
            value={gateway}
            onChange={(event) => {
              setGateway(event.target.value);
              setValues({});
            }}
            className="mt-1 block w-full rounded border border-zinc-700 bg-zinc-950 px-2 py-1 text-sm text-zinc-200"
          >
            <option value="sslcommerz">SSLCommerz</option>
            <option value="bkash">bKash</option>
            <option value="nagad">Nagad</option>
          </select>
        </label>
        <label className="text-xs text-zinc-500">
          name
          <input
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder="demo-shop"
            className="mt-1 block w-full rounded border border-zinc-700 bg-zinc-950 px-2 py-1 text-sm text-zinc-200"
          />
        </label>
      </div>
      <div className="mt-2 grid grid-cols-1 gap-2 sm:grid-cols-2">
        {fields.map((field) => (
          <label key={field.key} className="text-xs text-zinc-500">
            {field.label}
            {field.textarea ? (
              <textarea
                value={values[field.key] ?? ''}
                onChange={(event) => setValues({ ...values, [field.key]: event.target.value })}
                rows={3}
                placeholder="-----BEGIN PUBLIC KEY----- …"
                className="mt-1 block w-full rounded border border-zinc-700 bg-zinc-950 px-2 py-1 font-mono text-xs text-zinc-200"
              />
            ) : (
              <input
                type={field.secret ? 'password' : 'text'}
                value={values[field.key] ?? ''}
                onChange={(event) => setValues({ ...values, [field.key]: event.target.value })}
                autoComplete="off"
                className="mt-1 block w-full rounded border border-zinc-700 bg-zinc-950 px-2 py-1 text-sm text-zinc-200"
              />
            )}
            {field.hint && <span className="text-zinc-600">{field.hint}</span>}
          </label>
        ))}
      </div>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <button
          type="button"
          disabled={busy || name.trim() === ''}
          onClick={submit}
          className="rounded bg-amber-400 px-3 py-1 text-sm font-semibold text-black hover:bg-amber-300 disabled:opacity-50"
        >
          {busy ? 'Creating…' : 'Create app'}
        </button>
        <button
          type="button"
          onClick={fillDemo}
          className="rounded border border-zinc-700 px-2 py-1 text-xs hover:bg-zinc-800"
        >
          Fill demo values
        </button>
        {error && <span className="text-xs text-red-400">{error}</span>}
      </div>
      <p className="mt-2 text-xs text-zinc-600">
        Fake credentials only — the API rejects anything that looks like a real key. A default app
        already exists for each gateway; create more when you need extra stores.
      </p>
    </div>
  );
}

export default function Onboarding({ workspace }: { workspace: string }): JSX.Element {
  const baseUrl = window.location.origin;
  return (
    <div className="mt-4 space-y-4">
      <section className="rounded border border-zinc-800 bg-zinc-900 p-4">
        <h2 className="font-semibold">What is PaySim BD?</h2>
        <p className="mt-1 max-w-3xl text-sm text-zinc-400">
          A simulator that imitates Bangladeshi payment gateways — SSLCommerz, bKash and Nagad — for
          development and testing. Point your app&apos;s gateway base URL here instead of the real
          sandbox, then drive success, failure, cancel and timeout flows on demand and inspect every
          request below. No real money or credentials ever touch this service.
        </p>
        <ol className="mt-3 grid grid-cols-1 gap-2 text-sm md:grid-cols-3">
          <li className="rounded bg-zinc-950 p-2.5">
            <span className="font-semibold text-amber-400">1.</span>{' '}
            <span className="text-zinc-300">
              Set your app&apos;s gateway base URL to this page&apos;s origin and create a gateway
              app below.
            </span>
          </li>
          <li className="rounded bg-zinc-950 p-2.5">
            <span className="font-semibold text-amber-400">2.</span>{' '}
            <span className="text-zinc-300">
              Send a payment init with a <code>SIM:&lt;name&gt;</code> marker to choose its outcome.
            </span>
          </li>
          <li className="rounded bg-zinc-950 p-2.5">
            <span className="font-semibold text-amber-400">3.</span>{' '}
            <span className="text-zinc-300">
              Watch the transaction timeline update live; replay callbacks and bend time with the
              fake clock.
            </span>
          </li>
        </ol>
      </section>

      <section className="rounded border border-zinc-800 bg-zinc-900 p-4">
        <div className="flex flex-wrap items-center gap-2">
          <h2 className="font-semibold">Connect your app</h2>
          <code className="rounded bg-zinc-950 px-2 py-0.5 text-sm text-zinc-200">{baseUrl}</code>
          <CopyButton text={baseUrl} label="Copy base URL" />
        </div>
        <div className="mt-3 grid grid-cols-1 gap-2 md:grid-cols-3">
          {GUIDES.map((guide) => (
            <GatewayGuideRow key={guide.gateway} workspace={workspace} guide={guide} />
          ))}
        </div>
        <p className="mt-2 text-xs text-zinc-600">
          Unknown SIM: names fail loudly so typos never pass silently. Full request/response shapes
          live in each gateway&apos;s spec — see the docs site linked in the README.
        </p>
      </section>

      <section>
        <h2 className="text-sm font-semibold uppercase tracking-wide text-zinc-400">
          New gateway app
        </h2>
        <CreateAppForm workspace={workspace} />
      </section>
    </div>
  );
}
