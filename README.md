# paysim-bd

> **SIMULATOR — fake money, fake credentials.** This tool imitates Bangladeshi
> payment gateways (SSLCommerz, bKash, Nagad) for local development. It never
> accepts or stores real credentials.

Local-first simulator for Bangladeshi payment gateways. Point your app's
gateway base URL at the simulator instead of the real sandbox, then drive
success/failure/edge-case flows on demand and inspect every request.

**Status: Phase 0 (scaffold).** No gateway plugins yet — see the roadmap below.

## Quickstart (local mode)

```sh
cp .env.example .env
docker compose up
```

- Dashboard: http://localhost:8080
- API health: http://localhost:3001/api/health

Or run from source (needs PostgreSQL 17+):

```sh
pnpm install
pnpm db:migrate   # DATABASE_URL from .env
pnpm dev          # API on :3001, web on :5173
```

## Run modes

| Mode              | How                       | Callbacks to localhost? |
| ----------------- | ------------------------- | ----------------------- |
| Local (primary)   | `docker compose up`       | Yes                     |
| Hosted playground | Render + Neon + R2 (Ph.5) | **Never** — SSRF guard  |

The hosted instance cannot reach your localhost. This is a deliberate SSRF
protection (`ALLOW_PRIVATE_CALLBACK_TARGETS=false`), not a bug. A CLI tunnel
relay is a planned future item.

## Repo layout

```text
apps/api/            Express API, Drizzle schema/migrations, storage drivers
apps/web/            React dashboard (Vite + TanStack Query + Tailwind)
packages/core/       Shared scenario-engine / clock / redaction helpers
packages/gateways/   One plugin per gateway (SSLCommerz first, Phase 1+)
docs/decisions/      Architecture decision records
```

## Config

All config is environment variables — see [.env.example](.env.example), validated
at boot with zod. Bodies over 16 KB are stored in object storage (`fs` driver
locally, S3/R2 hosted) instead of Postgres.

## Roadmap

- [x] Phase 0: monorepo, CI, migrations, storage
- [ ] Phase 1: core + SSLCommerz plugin + dashboard timeline + SSE
- [ ] Phase 2: scenario engine, fake clock, callback delivery, SSRF guard
- [ ] Phase 3: bKash plugin
- [ ] Phase 4: Nagad plugin
- [ ] Phase 5: parity suite, docs site, GHCR release, hosted deploy guide

## License

MIT — see [LICENSE](LICENSE).
