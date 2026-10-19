# Gateway plugins (Phase 1+)

One workspace package per gateway, e.g. `packages/gateways/sslcommerz/`.
Each plugin exports mounted mock routes, request validation, response
builders, a transaction state machine and callback/IPN builders, plus a
`spec/vN.json` fidelity manifest. See the repo brief for the hard rules
(official docs first, never real credentials, no trademarked assets).
