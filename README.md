# paysim-bd

> **SIMULATOR — fake money, fake credentials.** This tool imitates Bangladeshi
> payment gateways (SSLCommerz, bKash, Nagad) for local development. It never
> accepts or stores real credentials, and ships no gateway logos or trademarked assets.

Point your app's gateway base URL at the simulator instead of the real sandbox,
then drive success/failure/edge-case flows on demand and inspect every request.
Real sandboxes can't deliver IPN to localhost and edge cases (duplicate/late IPN,
amount mismatch, pending-then-settled) are hard to reproduce — this fixes both.

Docs: **https://junaaid96.github.io/paysim-bd/** · License: MIT

## 60-second quickstart

```sh
git clone https://github.com/junaaid96/paysim-bd.git
cd paysim-bd
cp .env.example .env
docker compose up
```

- Dashboard: **http://localhost:8080** (look for the SIMULATOR banner)
- API: **http://localhost:3001**
- Create a fake store, then init with a magic scenario marker:

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

Open the `GatewayPageURL` from the response, or watch the `immediate-success`
scenario settle it while the dashboard timeline updates live.

Or run from source (needs PostgreSQL 17+ and Node 22 + pnpm 12):

```sh
pnpm install
pnpm db:migrate   # DATABASE_URL from .env
pnpm dev          # API on :3001, dashboard on :5173
```

## Run modes

| Mode            | How                 | Callbacks to localhost? |
| --------------- | ------------------- | ----------------------- |
| Local (primary) | `docker compose up` | Yes                     |
| Hosted          | Render + Neon + R2  | **Never** — SSRF guard  |

The hosted instance cannot reach your localhost. This is a deliberate SSRF
protection (`ALLOW_PRIVATE_CALLBACK_TARGETS=false`), not a bug. A CLI tunnel
relay is a planned future item. See the [deploy guide](https://junaaid96.github.io/paysim-bd/deploy).

## Gateways

| Gateway    | Flow                                  | Badge      | Magic field                            |
| ---------- | ------------------------------------- | ---------- | -------------------------------------- |
| SSLCommerz | Session init + hosted page + IPN      | docs-only  | `value_d` = `SIM:<name>`               |
| bKash      | Tokenized checkout (v2, no agreement) | docs-only  | `merchantInvoiceNumber` = `SIM:<name>` |
| Nagad      | Sealed checkout (community flow)      | unverified | `orderId` = `SIM:<name>[:suffix]`      |

Each plugin ships `spec/vN.json` listing every endpoint/field with sources and
`verified | docs-only | unverified` fidelity. No official Nagad docs are publicly
reachable, so Nagad is entirely `unverified`.

## Repo layout

```text
apps/api/            Express API, Drizzle schema/migrations, storage drivers
apps/web/            React dashboard (Vite + TanStack Query + Tailwind, SSE)
apps/docs/           VitePress docs (GitHub Pages)
packages/core/       Scenario engine, fake clock, redaction, fake-guard
packages/parity/     Parity suite: replay fixtures, diff shapes, enforce badges
packages/gateways/   One plugin per gateway (routes, state machine, spec)
examples/sslcommerz-client/  Sample Express client (init → redirect → IPN → validation)
docs/decisions/      Architecture decision records
```

## Config

All config is environment variables — see [.env.example](.env.example), validated
at boot with zod. Bodies over 16 KB go to object storage (`fs` locally, S3/R2
hosted); secrets are redacted in storage and logs.

## Parity & releases

```sh
pnpm parity -- --base-url http://127.0.0.1:3001   # replay fixtures, enforce badges
```

Tagged releases publish `ghcr.io/junaaid96/paysim-bd`. A gateway's badge becomes
`verified` only when every implemented endpoint is covered by a passing
real-sandbox fixture — see the [parity suite](https://junaaid96.github.io/paysim-bd/parity).

## Roadmap

- [x] Phase 0: monorepo, CI, migrations, storage
- [x] Phase 1: core + SSLCommerz plugin + dashboard timeline + SSE
- [x] Phase 2: scenario engine, fake clock, callback delivery, SSRF guard
- [x] Phase 3: bKash plugin
- [x] Phase 4: Nagad plugin
- [x] Phase 5: parity suite, docs site, GHCR release, hosted deploy guide

## License

MIT — see [LICENSE](LICENSE).
