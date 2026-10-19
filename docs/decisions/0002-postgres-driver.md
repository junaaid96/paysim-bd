# 0002 — Postgres driver and connection handling

## Driver: postgres.js (`postgres@3.4.9`)

Alternatives were `pg` (node-postgres, 8.23.1) and `@neondatabase/serverless`.
postgres.js won because:

- Single dependency with built-in pooling and its own types (no `@types/*`).
- First-class Drizzle support (`drizzle-orm/postgres-js` + migrator), including
  the documented Neon recipe (`prepare: false`).
- The API runs on long-lived compute (local docker, Render web service), so
  Neon's HTTP/WebSocket serverless driver buys nothing — a normal pooled TCP
  connection to the pooled endpoint is correct.

`prepare: false` is set unconditionally: required for PgBouncer-style pooled
endpoints (Neon pooled), harmless for direct connections.

## sslmode handling (`sslForDatabaseUrl`)

Neon dashboard strings carry `?sslmode=require`; local docker Postgres has no
TLS. The client maps libpq `sslmode` explicitly:

- `require` → enforce TLS
- `disable` → plain TCP
- absent / `prefer` / `allow` → try TLS, fall back to plain
- `verify-ca` / `verify-full` / anything else → throw at boot

Verification modes fail loudly instead of being silently downgraded: claiming
verification without a CA bundle would be a lie.

## Neon scale-to-zero

Free Neon compute sleeps and wakes slowly, so boot calls `waitForDb`: `SELECT 1`
with exponential backoff (250ms → 5s cap) over a 60s budget. The pool is small
(`DB_POOL_MAX`, default 5) to stay kind to free-tier compute.
