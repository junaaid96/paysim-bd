# Callbacks & SSRF

SSLCommerz delivers server-to-server IPN; bKash and Nagad settle through customer-browser redirects (no server POST — the sim renders a redirect page instead).

## Delivery policy (IPN)

- 6 attempts with backoff (2s → 4s → 8s → 16s → 32s, capped at 5m).
- Non-2xx responses retry; every attempt is recorded with latency and a response snippet.
- Exhaustion writes `callback.dead` (terminal); the dashboard **Replay** button re-queues a delivery.
- Jobs persist in Postgres with in-process timers; overdue jobs run on boot. The scheduler arms a timer only while jobs are pending — no continuous polling, so Neon can scale to zero.

## SSRF guard

`ALLOW_PRIVATE_CALLBACK_TARGETS` controls where callbacks may go:

| Mode                     | Value   | Behavior                                                                                                                            |
| ------------------------ | ------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| Local (`docker compose`) | `true`  | localhost/private IPs allowed — your app on `localhost:4000` receives IPN                                                           |
| Hosted                   | `false` | Loopback/private/link-local blocked; DNS is resolved and re-checked per hop; redirects, body size (64KB), and timeouts (10s) capped |

Blocked targets fail terminally (`callback.blocked`) — they never retry, because retrying a policy block is pointless.

::: warning Hosted cannot reach your laptop
The hosted playground can never deliver to `localhost`. That is a deliberate security property, not a bug. Develop redirect/callback flows locally; use hosted for exploring the dashboard and the mock pages. A CLI tunnel relay is a planned future item.
:::
