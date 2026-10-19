# 0004 — Secure-by-default config

Two Phase 0 defaults deliberately favour the hosted threat model over
local convenience; local mode opts out explicitly.

## ALLOW_PRIVATE_CALLBACK_TARGETS defaults to false

The SSRF guard (enforced from Phase 2) blocks loopback/private/link-local
callback targets when false. A forgotten env var on a hosted deploy must fail
closed, not open an SSRF hole — so the default is `false`, and local mode sets
`true` in `.env.example` and `docker-compose.yml`.

## `fs` storage is refused in production

`createStorageFromEnv` throws when `STORAGE_DRIVER=fs` meets
`NODE_ENV=production`: the hosted filesystem is ephemeral, so hosted mode must
use the `s3` driver (R2). Local compose runs with `NODE_ENV=development`, so
local `fs` storage keeps working; production-local runs get a clear error
telling them to switch to `s3`.

## Bodies over 16 KB

`MAX_INLINE_BODY_BYTES = 16 * 1024` (`@paysim/core`). `storeBody` redacts via
`redactValue`, then stores inline or spills to object storage. Response
previews are capped separately at 2 KB (`MAX_RESPONSE_SNIPPET_BYTES`).
