---
layout: home
hero:
  name: paysim-bd
  text: A local-first simulator for Bangladeshi payment gateways.
  tagline: Point your app at the simulator, drive success/failure/edge cases on demand, and inspect every request. SIMULATOR — fake money only.
  actions:
    - theme: brand
      text: 60-second quickstart
      link: /quickstart
    - theme: alt
      text: How scenarios work
      link: /concepts/scenarios
features:
  - title: Localhost callbacks work
    details: Run with docker compose and IPN/webhooks reach your app on localhost — the thing real sandboxes cannot do.
  - title: Edge cases on demand
    details: Duplicate IPN, late IPN, amount mismatch, pending-then-settled — declarative scenarios, magic test values, or one dashboard click.
  - title: Fake clock
    details: Expiry and reconciliation read a per-workspace clock you can advance, so 24-hour flows take seconds.
  - title: Fidelity badges
    details: Every gateway ships a spec manifest with sources. Only recorded real-sandbox replays earn a verified badge.
---

## Gateways

| Gateway    | Flow                             | Badge      | Magic field                            |
| ---------- | -------------------------------- | ---------- | -------------------------------------- |
| SSLCommerz | Session init + hosted page + IPN | docs-only  | `value_d` = `SIM:<name>`               |
| bKash      | Tokenized checkout (v2)          | docs-only  | `merchantInvoiceNumber` = `SIM:<name>` |
| Nagad      | Sealed checkout (community flow) | unverified | `orderId` = `SIM:<name>[:suffix]`      |

No official Nagad docs are publicly reachable, so every Nagad field is marked `unverified`. See [Nagad](/gateways/nagad).

## Two run modes

- **Local (primary):** `docker compose up`. Callbacks may target localhost/private IPs.
- **Hosted playground:** one Render service (API + dashboard) + Neon + R2. Callback delivery is SSRF-protected and **cannot reach your localhost** — see [Deploy](/deploy).
