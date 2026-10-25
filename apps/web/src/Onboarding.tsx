import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type JSX } from 'react';

import { createApp, fetchScenarios } from './api';
import { copyText } from './curl';
import { GatewayMark } from './ui';

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
      setState(ok ? 'Copied ✓' : 'Copy failed');
      setTimeout(() => setState(label), 1500);
    });
  };
  return (
    <button type="button" onClick={onClick} className="btn shrink-0">
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
        <code
          key={scenario.id}
          className="rounded-md border border-zinc-800 bg-zinc-950 px-1.5 py-0.5 text-[11px] text-zinc-300"
        >
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
    <div className="card flex flex-col p-4">
      <div className="flex items-center gap-2.5">
        <GatewayMark gateway={guide.gateway} />
        <div className="font-semibold text-zinc-100">{guide.displayName}</div>
      </div>
      <code
        className="mt-3 block truncate rounded-md bg-zinc-950 px-2 py-1.5 text-xs text-zinc-300"
        title={guide.init}
      >
        {guide.init}
      </code>
      <p className="mt-3 text-xs text-zinc-500">
        Pick the outcome per payment with <code className="text-zinc-300">{guide.magicField}</code>{' '}
        = <code className="text-zinc-300">{guide.magicExample}</code>
      </p>
      <div className="mt-2">
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

export function CreateAppForm({ workspace }: { workspace: string }): JSX.Element {
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
    <div className="card p-4 text-sm">
      <div className="flex flex-wrap gap-1.5">
        {(['sslcommerz', 'bkash', 'nagad'] as const).map((id) => (
          <button
            key={id}
            type="button"
            onClick={() => {
              setGateway(id);
              setValues({});
            }}
            className={`inline-flex items-center gap-2 rounded-lg border px-3 py-1.5 text-xs font-medium ${
              gateway === id
                ? 'border-emerald-500 bg-emerald-950 text-emerald-300'
                : 'border-zinc-800 text-zinc-400 hover:border-zinc-600'
            }`}
          >
            <GatewayMark gateway={id} size="sm" />
            {id === 'sslcommerz' ? 'SSLCommerz' : id === 'bkash' ? 'bKash' : 'Nagad'}
          </button>
        ))}
      </div>
      <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2">
        <label className="text-xs text-zinc-500">
          App name
          <input
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder="demo-shop"
            className="input"
          />
        </label>
        {fields.map((field) => (
          <label
            key={field.key}
            className={`text-xs text-zinc-500 ${field.textarea ? 'sm:col-span-2' : ''}`}
          >
            {field.label}
            {field.textarea ? (
              <textarea
                value={values[field.key] ?? ''}
                onChange={(event) => setValues({ ...values, [field.key]: event.target.value })}
                rows={3}
                placeholder="-----BEGIN PUBLIC KEY----- …"
                className="input font-mono text-xs"
              />
            ) : (
              <input
                type={field.secret ? 'password' : 'text'}
                value={values[field.key] ?? ''}
                onChange={(event) => setValues({ ...values, [field.key]: event.target.value })}
                autoComplete="off"
                className="input"
              />
            )}
            {field.hint && <span className="mt-1 block text-zinc-600">{field.hint}</span>}
          </label>
        ))}
      </div>
      <div className="mt-4 flex flex-wrap items-center gap-2">
        <button
          type="button"
          disabled={busy || name.trim() === ''}
          onClick={submit}
          className="btn-primary"
        >
          {busy ? 'Creating…' : 'Create app'}
        </button>
        <button type="button" onClick={fillDemo} className="btn">
          Fill demo values
        </button>
        {error && <span className="text-xs text-red-400">{error}</span>}
      </div>
      <p className="mt-3 text-xs text-zinc-600">
        Fake credentials only — the API rejects anything that looks like a real key. A default app
        already exists for each gateway; create more when you need extra stores.
      </p>
    </div>
  );
}

export function QuickstartSnippet(): JSX.Element {
  const base = window.location.origin;
  const snippet = `curl -X POST ${base}/gwprocess/v4/api.php \\
  -d store_id=testbox -d store_passwd=qwerty \\
  -d total_amount=100.00 -d currency=BDT -d tran_id=DEMO-1 \\
  -d product_category=demo \\
  -d success_url=https://your-app.test/success \\
  -d fail_url=https://your-app.test/fail \\
  -d cancel_url=https://your-app.test/cancel \\
  -d ipn_url=https://your-app.test/ipn \\
  -d value_d=SIM:manual`;
  return (
    <section className="card overflow-hidden">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-zinc-800 px-4 py-3">
        <div>
          <div className="font-semibold text-zinc-100">Your first payment</div>
          <p className="text-xs text-zinc-500">
            Open the returned <code>GatewayPageURL</code>, pick Success / Fail / Cancel, then
            validate with <code>/validator/api/validationserverAPI.php</code>.
          </p>
        </div>
        <CopyButton text={snippet} label="Copy curl" />
      </div>
      <pre className="overflow-x-auto bg-zinc-950 p-4 text-xs leading-relaxed text-zinc-300">
        {snippet}
      </pre>
    </section>
  );
}

const STEPS = [
  {
    title: 'Point your app here',
    body: 'Swap your gateway base URL for this simulator’s origin. Default fake stores already exist for every gateway.',
  },
  {
    title: 'Pick an outcome',
    body: 'Add a SIM:<name> marker to the payment (success, fail, cancel, late IPN, amount mismatch…) or leave it on manual.',
  },
  {
    title: 'Watch & replay',
    body: 'Follow every request and callback live, replay IPNs, override scenarios and fast-forward the fake clock.',
  },
];

export default function Onboarding({ workspace }: { workspace: string }): JSX.Element {
  const baseUrl = window.location.origin;
  return (
    <div className="space-y-6">
      <section className="card relative overflow-hidden p-6">
        <div className="pointer-events-none absolute -top-24 -right-24 h-64 w-64 rounded-full bg-emerald-500/10 blur-3xl" />
        <div className="eyebrow">Get started</div>
        <h2 className="mt-1 text-2xl font-semibold tracking-tight text-zinc-100">
          Test SSLCommerz, bKash and Nagad flows without a real sandbox
        </h2>
        <p className="mt-2 max-w-3xl text-sm text-zinc-400">
          PaySim BD imitates the gateways&apos; APIs and hosted checkout pages. Drive success,
          failure, cancel and timeout flows on demand and inspect every request. No real money or
          credentials ever touch this service.
        </p>
        <ol className="mt-5 grid grid-cols-1 gap-3 md:grid-cols-3">
          {STEPS.map((step, index) => (
            <li key={step.title} className="rounded-xl border border-zinc-800 bg-zinc-950 p-4">
              <span className="inline-flex h-6 w-6 items-center justify-center rounded-full bg-emerald-500 text-xs font-bold text-black">
                {index + 1}
              </span>
              <div className="mt-2 text-sm font-semibold text-zinc-100">{step.title}</div>
              <p className="mt-1 text-xs text-zinc-500">{step.body}</p>
            </li>
          ))}
        </ol>
      </section>

      <section>
        <div className="mb-3 flex flex-wrap items-center gap-2">
          <h2 className="text-base font-semibold text-zinc-100">Connect your app</h2>
          <code className="rounded-md border border-zinc-800 bg-zinc-900 px-2 py-1 text-sm text-zinc-200">
            {baseUrl}
          </code>
          <CopyButton text={baseUrl} label="Copy base URL" />
        </div>
        <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
          {GUIDES.map((guide) => (
            <GatewayGuideRow key={guide.gateway} workspace={workspace} guide={guide} />
          ))}
        </div>
        <p className="mt-2 text-xs text-zinc-600">
          Unknown SIM: names fail loudly so typos never pass silently. Full request/response shapes
          live in each gateway&apos;s spec — see the docs linked in the README.
        </p>
      </section>

      <section className="card p-5">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="max-w-3xl">
            <div className="eyebrow">Optional extra · Real sandbox</div>
            <h2 className="mt-1 text-base font-semibold text-zinc-100">
              Rehearse against the providers&apos; own sandboxes
            </h2>
            <p className="mt-1 text-sm text-zinc-400">
              You don&apos;t need this to use PaySim: every store runs on the simulator. For a final
              check, open <strong className="text-zinc-200">Real sandbox</strong> in the sidebar,
              save a store&apos;s sandbox keys, test the connection and switch it on. Your app keeps
              calling this URL with the same PaySim credentials; payments open the provider&apos;s
              sandbox page, and webhooks, the live feed and refunds keep working.
            </p>
            <ul className="mt-2 space-y-1 text-xs text-zinc-500">
              <li>
                <strong className="text-zinc-300">SSLCommerz</strong> — your sandbox store (free
                signup) or the public test store.
              </li>
              <li>
                <strong className="text-zinc-300">bKash</strong> — tokenized checkout sandbox keys;
                public test keys are one click away. One refund per payment in the bKash sandbox.
              </li>
              <li>
                <strong className="text-zinc-300">Nagad</strong> — needs credentials Nagad issues to
                registered merchants (merchant ID and key pair); until then it uses the simulator.
              </li>
            </ul>
          </div>
          <a href="#sandbox" className="btn">
            Open Real sandbox →
          </a>
        </div>
      </section>
    </div>
  );
}
