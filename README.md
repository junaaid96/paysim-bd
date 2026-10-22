# PaySim BD

[![CI](https://github.com/junaaid96/paysim-bd/actions/workflows/ci.yml/badge.svg)](https://github.com/junaaid96/paysim-bd/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-teal.svg)](LICENSE)
[![PRs welcome](https://img.shields.io/badge/PRs-welcome-teal.svg)](CONTRIBUTING.md)

> **SANDBOX ONLY — no real money.** PaySim BD imitates Bangladeshi payment
> gateways (SSLCommerz, bKash, Nagad) for development and testing. It never
> talks to production gateways or moves real money. The optional Real sandbox
> mode only forwards to the providers' official sandboxes, with sandbox keys you
> save (encrypted at rest).

Open-source, local-first simulator for Bangladeshi payment gateways. Point your
app's gateway base URL at PaySim BD instead of the real sandbox, then drive
success, failure, timeout, and edge-case flows on demand and inspect every
request your app makes.

**Live playground:** [paysim-bd-codejborg.vercel.app](https://paysim-bd-codejborg.vercel.app) ·
API health: [/api/health](https://paysim-bd-codejborg.vercel.app/api/health)

**Status: all phases done.** SSLCommerz, bKash and Nagad plugins, the scenario
engine, the parity suite and the docs site are all in (see the
[roadmap](#roadmap)). Docs: **https://junaaid96.github.io/paysim-bd/**

## Why

Real gateway sandboxes are slow, flaky, rate-limited, and make it hard to
reproduce the cases that break integrations: a cancelled payment, a late or
duplicated IPN, a validation call that times out. PaySim BD gives you a
deterministic stand-in you fully control.

## Features

- **Drop-in mock gateways** — one plugin per gateway (SSLCommerz first, then
  bKash and Nagad), matching the official request/response shapes.
- **Realistic checkout pages** — bKash and Nagad wallet flows (account number,
  OTP, PIN) and an SSLCommerz method picker (cards, mobile banking, net
  banking), each with a persistent "PaySim sandbox — test only, no real money"
  label and test-value hints. OTP, PIN and card fields are never sent or stored.
- **Optional Real sandbox mode** — per app, switch from the simulator to the
  provider's own sandbox (SSLCommerz and bKash) without changing your app: PaySim
  proxies session/create, validation/execute, query and refunds, and keeps the
  timeline, live feed and callbacks working. Nagad needs merchant credentials
  and stays on the simulator. See [Real sandbox mode](#real-sandbox-mode-optional).
- **Scenario engine** — choose the outcome of each payment (success, failure,
  cancel, pending, timeout) instead of hoping the sandbox cooperates.
- **Refunds** — full and partial refunds on all three gateways through their
  own refund API shapes (SSLCommerz refund + refund status, bKash refund +
  refund status, Nagad sealed refund) or one click in the dashboard. Over-refunds
  are blocked, retries are idempotent, and `SIM:refund_fail` simulates a
  declined refund.
- **Fake clock** — fast-forward expiries and delayed callbacks.
- **Callback / IPN delivery** with retries, plus an **SSRF guard** so the hosted
  playground can never be used to reach private networks.
- **Request timeline** — every inbound request and outbound callback is
  recorded, with secrets redacted before storage.
- **Large-body storage** — bodies over 16 KB spill to object storage (local disk
  or any S3-compatible bucket; the hosted playground uses Neon object storage).
- **Run anywhere** — Docker Compose locally, or the hosted one-deploy (Vercel +
  Neon).

## Screenshots

One run through the simulator, from setup to a settled payment.

|                                                                                                                                                |                                                                                                                                                                       |
| ---------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| ![Get started](docs/screenshots/start.png)                                                                                                     | ![SSLCommerz checkout](docs/screenshots/checkout-sslcommerz.png)                                                                                                      |
| **Get started** — copy the base URL, pick a `SIM:` marker for the outcome you want, and fire your first test payment with the ready-made curl. | **SSLCommerz checkout** — pick cards, mobile banking or net banking with test values; simulator controls cover failure and cancel.                                    |
| ![bKash checkout](docs/screenshots/checkout-bkash.png)                                                                                         | ![Nagad checkout](docs/screenshots/checkout-nagad.png)                                                                                                                |
| **bKash checkout** — wallet number, OTP and PIN steps after grant-token and create payment (any test values); fail or cancel on demand.        | **Nagad checkout** — reached after the RSA-sealed initialize and complete calls; account number, OTP and PIN steps, or fail/cancel.                                   |
| ![Live event feed](docs/screenshots/live-feed.png)                                                                                             | ![Transaction timeline](docs/screenshots/transaction-timeline.png)                                                                                                    |
| **Live event feed** — every gateway event streams in as it happens, next to totals per outcome and the latest transactions.                    | **Test payment timeline** — one SSLCommerz payment end to end: init, scenario attached, checkout viewed, success, IPN, each with a redacted payload and copy-as-curl. |
| ![Transactions](docs/screenshots/transactions.png)                                                                                             | ![Scenarios & clock](docs/screenshots/scenarios.png)                                                                                                                  |
| **Transactions** — filter by gateway or search by reference; any row opens its full request/callback timeline.                                 | **Scenarios & clock** — the per-gateway scenario catalog plus a fake clock to fast-forward expiries and delayed callbacks.                                            |
| ![Gateways](docs/screenshots/gateways.png)                                                                                                     |                                                                                                                                                                       |
| **Gateways** — merchant apps per gateway: default scenario plus the Simulator / Real sandbox switch and masked sandbox keys.                   |                                                                                                                                                                       |

## Real sandbox mode (optional)

The simulator is the default for every app. When you want a final rehearsal
against a provider's own sandbox, open **Gateways**, save that gateway's sandbox
keys and switch the app to **Real sandbox**. Your app keeps calling PaySim with
the same PaySim credentials, so client code (QuickFood included) needs no change.

| Gateway    | Real sandbox                  | Provider calls                                                                                            |
| ---------- | ----------------------------- | --------------------------------------------------------------------------------------------------------- |
| SSLCommerz | Available                     | `sandbox.sslcommerz.com` session API, validation API (every return and IPN), refund API                   |
| bKash      | Available                     | Tokenized checkout sandbox: grant token (cached in `kv_entries`), create, execute, payment status, refund |
| Nagad      | Requires merchant credentials | Not offered; Nagad issues sandbox keys only to registered merchants                                       |

- Keys are AES-256-GCM encrypted with `PAYSIM_SECRETS_KEY` and never returned by
  the API (the dashboard shows identifiers and a masked hint).
- SSLCommerz successes are always re-checked with the validation API before
  PaySim records them and calls your `success_url` and IPN.
- Public test keys are one click away (SSLCommerz `testbox`, bKash's shared
  tokenized sandbox keys). The public bKash sandbox allows one refund per payment.
- Scenarios, `SIM:` markers and the fake clock apply to simulator mode only.

Details: [docs → Real sandbox mode](https://junaaid96.github.io/paysim-bd/concepts/real-sandbox).

## Used in QuickFood

[QuickFood](https://quickfood-frontend.vercel.app/), a food delivery demo app, takes its online payments through PaySim BD:

- **Checkout** offers bKash (tokenized checkout), Nagad and SSLCommerz next to cash on delivery. The Django backend talks to PaySim BD with the real gateways' request shapes, so pointing it at a real sandbox only means changing the base URL and credentials.
- **Every outcome is handled**: success, failure and cancellation all return the customer to the order page with a clear result. They can retry on any gateway or switch to cash, and the kitchen only sees the order once it's paid.
- **Callbacks are verified** with the gateway (bKash execute, Nagad verify, SSLCommerz validator and IPN) and the amount is checked before an order is marked paid.
- **Refunds**: the restaurant refunds all or part of a payment with a confirm step, and cancelling a paid order refunds it automatically through the same gateway.

Code: [quickfood_backend/payments](https://github.com/junaaid96/quickfood_backend/tree/main/payments) · [quickfood_frontend](https://github.com/junaaid96/quickfood_frontend)

## Tech stack

| Layer      | Tech                                                       |
| ---------- | ---------------------------------------------------------- |
| API        | Node.js 22+, Express 5, TypeScript, Zod, Pino              |
| Database   | PostgreSQL 17 (Neon when hosted), Drizzle ORM + migrations |
| Storage    | Local filesystem or S3-compatible (Neon object storage)    |
| Dashboard  | React 19, Vite, TanStack Query, Tailwind CSS 4             |
| Tooling    | pnpm workspaces, Vitest, Supertest, ESLint, Prettier       |
| Deployment | Docker Compose (local), Vercel + Neon (hosted playground)  |

## Gateways

| Gateway    | Flow                                  | Badge      | Magic field                            |
| ---------- | ------------------------------------- | ---------- | -------------------------------------- |
| SSLCommerz | Session init + hosted page + IPN      | docs-only  | `value_d` = `SIM:<name>`               |
| bKash      | Tokenized checkout (v2, no agreement) | docs-only  | `merchantInvoiceNumber` = `SIM:<name>` |
| Nagad      | Sealed checkout (community flow)      | unverified | `orderId` = `SIM:<name>[:suffix]`      |

Refunds work on every gateway (full or partial, idempotent, never above the
paid amount). See [Refunds](https://junaaid96.github.io/paysim-bd/concepts/refunds)
for the request shapes.

Each plugin ships `spec/vN.json` listing every endpoint/field with sources and
`verified | docs-only | unverified` fidelity. No official Nagad docs are publicly
reachable, so Nagad is entirely `unverified`. A gateway earns `verified` only
when the [parity suite](https://junaaid96.github.io/paysim-bd/parity) replays
passing real-sandbox fixtures for every implemented endpoint.

## Repo layout

```text
apps/api/            Express API, Drizzle schema/migrations, storage drivers
apps/web/            React dashboard (Vite + TanStack Query + Tailwind)
apps/docs/           VitePress docs (GitHub Pages)
packages/core/       Scenario engine, fake clock, redaction, fake-guard
packages/parity/     Parity suite: replay fixtures, diff shapes, enforce badges
packages/gateways/   One plugin per gateway (routes, state machine, spec)
examples/sslcommerz-client/  Sample Express client (init → redirect → IPN → validation)
api/index.js         Vercel serverless entry (shared boot with the Express app)
docs/decisions/      Architecture decision records
```

## Getting started

### Option A — Docker (recommended)

```sh
cp .env.example .env
docker compose up
```

- Dashboard: http://localhost:8080
- API health: http://localhost:3001/api/health

### Option B — from source

Requirements: Node.js 22+, pnpm 12, PostgreSQL 17+ (local or a free Neon
database).

```sh
pnpm install
cp .env.example .env   # set DATABASE_URL
pnpm db:migrate        # apply migrations
pnpm dev               # API on :3001, dashboard on :5173 (proxies /api)
```

The API also runs migrations and creates the default workspace on boot, so
`pnpm db:migrate` is optional.

### 60-second check

Create a fake store, then init a payment with a magic scenario marker
(`SIM:` names drive success/failure/edge cases; unknown names fail loudly):

```sh
curl -s -X POST http://localhost:3001/api/apps \
  -H 'content-type: application/json' -H 'x-workspace-key: local-default' \
  -d '{"gateway":"sslcommerz","name":"demo","credentials":{"store_id":"testbox","store_passwd":"qwerty"}}'

curl -s -X POST http://localhost:3001/gwprocess/v4/api.php \
  -d store_id=testbox -d store_passwd=qwerty \
  -d total_amount=100.00 -d currency=BDT -d tran_id=DEMO-1 \
  -d product_category=demo \
  -d success_url=http://localhost:4000/success \
  -d fail_url=http://localhost:4000/fail \
  -d cancel_url=http://localhost:4000/cancel \
  -d value_d='SIM:immediate-success' | head -c 300
```

Open the `GatewayPageURL` from the response and watch the dashboard timeline
update live.

## Environment variables

All configuration is environment variables, validated at boot with Zod
(`apps/api/src/env.ts`). See [.env.example](.env.example) for defaults.

| Variable                                       | Required | Description                                                                      |
| ---------------------------------------------- | -------- | -------------------------------------------------------------------------------- |
| `DATABASE_URL`                                 | Yes      | Postgres URL. For Neon use the pooled string with `sslmode=require`.             |
| `TEST_DATABASE_URL`                            | Tests    | Database the integration tests may create tables in and truncate.                |
| `DB_POOL_MAX`                                  | No       | Connection pool size (default `5`).                                              |
| `NODE_ENV`                                     | No       | `development`, `test` or `production`.                                           |
| `PORT` / `HOST`                                | No       | API listen address (default `0.0.0.0:3001`).                                     |
| `LOG_LEVEL`                                    | No       | Pino log level (default `info`).                                                 |
| `STORAGE_DRIVER`                               | No       | `fs` (local disk) or `s3`. `fs` is refused in production.                        |
| `STORAGE_FS_DIR`                               | No       | Directory for the `fs` driver.                                                   |
| `S3_ENDPOINT`                                  | If `s3`  | S3-compatible endpoint (e.g. Neon object storage).                               |
| `S3_REGION`                                    | No       | Region (default `auto`).                                                         |
| `S3_BUCKET`                                    | If `s3`  | Bucket name.                                                                     |
| `S3_ACCESS_KEY_ID`                             | If `s3`  | Access key ID.                                                                   |
| `S3_SECRET_ACCESS_KEY`                         | If `s3`  | Secret access key.                                                               |
| `S3_FORCE_PATH_STYLE`                          | No       | Path-style addressing (default `true`).                                          |
| `ALLOW_PRIVATE_CALLBACK_TARGETS`               | No       | `true` lets callbacks reach localhost/private IPs (local only). Default `false`. |
| `CORS_ORIGIN`                                  | No       | Comma-separated extra allowed origins.                                           |
| `WEB_DIST_DIR`                                 | No       | Built dashboard directory served by Express (auto-detected).                     |
| `NEON_REALTIME_SECRET`                         | No       | Neon Realtime secret for sealing live queries (unset = feed falls back to REST). |
| `PAYSIM_SECRETS_KEY`                           | No       | Encrypts Real sandbox keys at rest (unset = Real sandbox mode disabled).         |
| `NEON_REALTIME_URL` / `VITE_NEON_REALTIME_URL` | No       | Realtime WebSocket URL (server / public Vite var, same value).                   |

## Scripts

| Command             | What it does                                         |
| ------------------- | ---------------------------------------------------- |
| `pnpm dev`          | API + dashboard in watch mode                        |
| `pnpm build`        | Build every package                                  |
| `pnpm test`         | Unit + integration tests (needs `TEST_DATABASE_URL`) |
| `pnpm typecheck`    | `tsc --noEmit` in every workspace                    |
| `pnpm lint`         | ESLint                                               |
| `pnpm format:check` | Prettier check (`pnpm format` to fix)                |
| `pnpm db:generate`  | Generate a Drizzle migration from the schema         |
| `pnpm db:migrate`   | Apply migrations to `DATABASE_URL`                   |
| `pnpm parity`       | Replay parity fixtures, enforce fidelity badges      |

## Run modes

| Mode              | How                 | Callbacks to localhost? |
| ----------------- | ------------------- | ----------------------- |
| Local (primary)   | `docker compose up` | Yes                     |
| Hosted playground | Vercel + Neon       | **Never** — SSRF guard  |

The hosted instance cannot reach your localhost. This is deliberate SSRF
protection (`ALLOW_PRIVATE_CALLBACK_TARGETS=false`), not a bug. Run it locally
to receive callbacks on your own machine.

In every mode the dashboard origin doubles as the gateway base URL: point your
app at it and call `/gwprocess/*`, `/validator/*`, `/v2/tokenized-checkout/*`,
`/bkash/*`, `/remote-payment-gateway-1.0/*` or `/nagad/*` directly (Vercel
rewrites, the compose nginx proxy and the Vite dev proxy all route these to
the API).

## Deployment

The hosted playground is a single Vercel project: `vercel.json` builds every
package with pnpm, serves `apps/web/dist` as static files, and rewrites
`/api/*` to `api/index.js`, which runs the same Express app (migrations run on
cold start). To deploy your own:

1. Import the repo into Vercel (framework preset: **Other**).
2. Add a Postgres database (e.g. the Neon integration) so `DATABASE_URL` is set.
3. Set `ALLOW_PRIVATE_CALLBACK_TARGETS=false`, `CORS_ORIGIN` to your domain, and
   for durable large-body storage `STORAGE_DRIVER=s3` plus the `S3_*` variables.
4. Deploy. Check `/api/health` and `/api/ready`.

Serverless caveat: scheduler timers only run while a function is warm, so
scenario steps and delivery retries fire on invocation (cold starts process
anything overdue) rather than precisely on time. Prefer the long-lived hosts
below when timing fidelity matters.

### Alternative: Render + GHCR

Tagged releases publish the one-deploy image
`ghcr.io/junaaid96/paysim-bd` (API + dashboard, migrations on boot). Point a
Render web service (or any container host) at it with the same env vars —
see the [deploy guide](https://junaaid96.github.io/paysim-bd/deploy).

## Roadmap

- [x] Phase 0: monorepo, CI, migrations, storage, hosted deploy
- [x] Phase 1: core + SSLCommerz plugin + dashboard timeline + SSE
- [x] Phase 2: scenario engine, fake clock, callback delivery, SSRF guard
- [x] Phase 3: bKash plugin
- [x] Phase 4: Nagad plugin
- [x] Phase 5: parity suite, docs site, GHCR release, hosted deploy guide
- [x] Refunds: full/partial refunds for SSLCommerz, bKash and Nagad, dashboard refund action

## Contributing

Contributions are welcome — see [CONTRIBUTING.md](CONTRIBUTING.md) and the
[Code of Conduct](CODE_OF_CONDUCT.md). Report security issues privately per
[SECURITY.md](SECURITY.md). Changes are tracked in [CHANGELOG.md](CHANGELOG.md).

## Disclaimer

PaySim BD is an independent open-source project and is not affiliated with,
endorsed by, or connected to SSLCommerz, bKash, Nagad, or any payment provider.
Gateway names are used only to describe compatibility.

## License

MIT © Md. Junaidul Islam (CodeJBorg) — see [LICENSE](LICENSE).

---

Developed by **&lt;CodeJBorg /&gt;**
