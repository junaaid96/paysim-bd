# 0005 — Gateway plugin architecture (Phase 1)

## Shape

- `packages/gateways/<name>` (`@paysim/gateway-<name>`): mock routes,
  request validation, response builders, state machine, callback/IPN
  builders, `spec/vN.json` manifest. Owns NO persistence code.
- `packages/core/src/plugin.ts`: the contract — `GatewaySpec` manifest
  schema, JSON-safe record schemas, the `PluginStores` persistence
  interface, `PluginContext`, `GatewayPlugin`.
- `apps/api`: hosts plugins. `PluginStores` is implemented once with
  Drizzle (`stores/drizzle-stores.ts`), which also publishes every write
  to the SSE bus and spills large bodies to object storage.

Plugins never import Drizzle or Express types from core (core stays
runtime-agnostic); `createRouter` is typed `unknown` in the contract and
cast once at mount time. Plugin unit tests run against in-memory fake
stores with zero database.

## Time

All simulator time reads go through `Clock.now(workspaceId)`
(`SystemClock` in Phase 1). Phase 2 adds the offset-aware fake clock
without touching call sites.

## Callback delivery

Phase 1 delivers callbacks with a direct POST (`deliver.ts`, 10s timeout,
attempt recorded). No retries, scheduler, or SSRF guard — Phase 2 owns
all three, and the hosted deploy (Phase 5) requires them.

## Unverified-by-default fields

Anything the official sources leave unstated is marked `unverified` (or
`docs-only`) in the gateway's `spec/vN.json` with a note — never silently
invented. The dashboard fidelity badge reads this manifest.
