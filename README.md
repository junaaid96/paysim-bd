# PaySim BD

[![CI](https://github.com/junaaid96/paysim-bd/actions/workflows/ci.yml/badge.svg)](https://github.com/junaaid96/paysim-bd/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-teal.svg)](LICENSE)
[![PRs welcome](https://img.shields.io/badge/PRs-welcome-teal.svg)](CONTRIBUTING.md)

> **SIMULATOR — fake money, fake credentials.** PaySim BD imitates Bangladeshi
> payment gateways (SSLCommerz, bKash, Nagad) for development and testing. It
> never accepts, forwards, or stores real credentials or real payments.

Open-source, local-first simulator for Bangladeshi payment gateways. Point your
app's gateway base URL at PaySim BD instead of the real sandbox, then drive
success, failure, timeout, and edge-case flows on demand and inspect every
request your app makes.

**Live playground:** [paysim-bd-codejborg.vercel.app](https://paysim-bd-codejborg.vercel.app) ·
API health: [/api/health](https://paysim-bd-codejborg.vercel.app/api/health)

**Status: Phase 0 (scaffold).** The monorepo, database, migrations, storage and
dashboard shell are in place; gateway plugins land from Phase 1 (see the
[roadmap](#roadmap)).

## Why

Real gateway sandboxes are slow, flaky, rate-limited, and make it hard to
reproduce the cases that break integrations: a cancelled payment, a late or
duplicated IPN, a validation call that times out. PaySim BD gives you a
deterministic stand-in you fully control.

## Features

- **Drop-in mock gateways** — one plugin per gateway (SSLCommerz first, then
  bKash and Nagad), matching the official request/response shapes.
- **Scenario engine** — choose the outcome of each payment (success, failure,
  cancel, pending, timeout) instead of hoping the sandbox cooperates.
- **Fake clock** — fast-forward expiries and delayed callbacks.
- **Callback / IPN delivery** with retries, plus an **SSRF guard** so the hosted
  playground can never be used to reach private networks.
- **Request timeline** — every inbound request and outbound callback is
  recorded, with secrets redacted before storage.
- **Large-body storage** — bodies over 16 KB spill to object storage (local disk
  or any S3-compatible bucket such as Cloudflare R2).
- **Run anywhere** — Docker Compose locally, or the hosted one-deploy (Vercel +
  Neon).

## Tech stack

| Layer      | Tech                                                       |
| ---------- | ---------------------------------------------------------- |
| API        | Node.js 22+, Express 5, TypeScript, Zod, Pino              |
| Database   | PostgreSQL 17 (Neon when hosted), Drizzle ORM + migrations |
| Storage    | Local filesystem or S3-compatible (Cloudflare R2)          |
| Dashboard  | React 19, Vite, TanStack Query, Tailwind CSS 4             |
| Tooling    | pnpm workspaces, Vitest, Supertest, ESLint, Prettier       |
| Deployment | Docker Compose (local), Vercel + Neon (hosted playground)  |

## Repo layout

```text
apps/api/            Express API, Drizzle schema/migrations, storage drivers
apps/web/            React dashboard (Vite + TanStack Query + Tailwind)
packages/core/       Shared scenario-engine / clock / redaction helpers
packages/gateways/   One plugin per gateway (SSLCommerz first, Phase 1+)
api/index.js         Vercel serverless entry (wraps the Express app)
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

## Environment variables

All configuration is environment variables, validated at boot with Zod
(`apps/api/src/env.ts`). See [.env.example](.env.example) for defaults.

| Variable                         | Required | Description                                                                      |
| -------------------------------- | -------- | -------------------------------------------------------------------------------- |
| `DATABASE_URL`                   | Yes      | Postgres URL. For Neon use the pooled string with `sslmode=require`.             |
| `TEST_DATABASE_URL`              | Tests    | Database the integration tests may create tables in and truncate.                |
| `DB_POOL_MAX`                    | No       | Connection pool size (default `5`).                                              |
| `NODE_ENV`                       | No       | `development`, `test` or `production`.                                           |
| `PORT` / `HOST`                  | No       | API listen address (default `0.0.0.0:3001`).                                     |
| `LOG_LEVEL`                      | No       | Pino log level (default `info`).                                                 |
| `STORAGE_DRIVER`                 | No       | `fs` (local disk) or `s3`. `fs` is refused in production.                        |
| `STORAGE_FS_DIR`                 | No       | Directory for the `fs` driver.                                                   |
| `S3_ENDPOINT`                    | If `s3`  | S3-compatible endpoint (e.g. Cloudflare R2).                                     |
| `S3_REGION`                      | No       | Region (default `auto`).                                                         |
| `S3_BUCKET`                      | If `s3`  | Bucket name.                                                                     |
| `S3_ACCESS_KEY_ID`               | If `s3`  | Access key ID.                                                                   |
| `S3_SECRET_ACCESS_KEY`           | If `s3`  | Secret access key.                                                               |
| `S3_FORCE_PATH_STYLE`            | No       | Path-style addressing (default `true`).                                          |
| `ALLOW_PRIVATE_CALLBACK_TARGETS` | No       | `true` lets callbacks reach localhost/private IPs (local only). Default `false`. |
| `CORS_ORIGIN`                    | No       | Comma-separated extra allowed origins.                                           |
| `WEB_DIST_DIR`                   | No       | Built dashboard directory served by Express (auto-detected).                     |

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

## Run modes

| Mode              | How                  | Callbacks to localhost? |
| ----------------- | -------------------- | ----------------------- |
| Local (primary)   | `docker compose up`  | Yes                     |
| Hosted playground | Vercel + Neon (+ R2) | **Never** — SSRF guard  |

The hosted instance cannot reach your localhost. This is deliberate SSRF
protection (`ALLOW_PRIVATE_CALLBACK_TARGETS=false`), not a bug. Run it locally
to receive callbacks on your own machine.

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

## Roadmap

- [x] Phase 0: monorepo, CI, migrations, storage, hosted deploy
- [ ] Phase 1: core + SSLCommerz plugin + dashboard timeline + SSE
- [ ] Phase 2: scenario engine, fake clock, callback delivery, SSRF guard
- [ ] Phase 3: bKash plugin
- [ ] Phase 4: Nagad plugin
- [ ] Phase 5: parity suite, docs site, GHCR release

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
