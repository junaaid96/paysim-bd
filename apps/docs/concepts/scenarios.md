# Scenarios

A scenario is a declarative, zod-validated script: ordered steps of `{delayMs, action, params}`. The scheduler persists each step as a Postgres job and executes it through the gateway plugin, so restarts and clock jumps behave.

## Selection order

Highest priority first:

1. **Per-transaction override** — dashboard scenario picker, or `POST /api/txns/:id/scenario`.
2. **Magic init values** — like test card numbers; unknown `SIM:` names fail the init loudly before any row is written.
3. **App default** — dashboard picker, or `PATCH /api/apps/:id`.

| Gateway    | Magic field             | Example                                             |
| ---------- | ----------------------- | --------------------------------------------------- |
| SSLCommerz | `value_d`               | `SIM:immediate-success`                             |
| bKash      | `merchantInvoiceNumber` | `SIM:pending-then-success`                          |
| Nagad      | `orderId`               | `SIM:immediate-fail:run-42` (`:suffix` for repeats) |

## Actions

| Action                                                   | Meaning                                          |
| -------------------------------------------------------- | ------------------------------------------------ |
| `redirect_success` / `redirect_fail` / `redirect_cancel` | Settle via the customer-redirect path            |
| `send_ipn`                                               | Deliver a server-to-server IPN (SSLCommerz only) |
| `send_ipn_duplicate`                                     | Deliver the same IPN twice (idempotency test)    |
| `send_ipn_late`                                          | Deliver after a long delay                       |
| `mutate_amount`                                          | Change the settled amount (`params.deltaMinor`)  |
| `stay_pending`                                           | Record a pending step, settle nothing            |
| `settle_later`                                           | Stay pending now; settle on a later step         |
| `timeout`                                                | Expire the transaction                           |

Gateways without server-to-server callbacks (bKash, Nagad) record `send_ipn*` steps as skipped with an explanation — teaching your app to expect a POST that never comes would be unfaithful.

## Built-ins

Each gateway seeds built-ins such as `manual` (mock page only), `immediate-success`, `immediate-fail`, `pending-then-success`, and `amount-mismatch`. List them with `GET /api/scenarios?gateway=sslcommerz`.
