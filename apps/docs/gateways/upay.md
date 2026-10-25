# Upay (UCB Fintech)

Fidelity: **unverified**. Upay's PGW API v4.1.0 document is not public. Every path below comes
from community integrations that cite it:

- <https://bdpaygate.github.io/docs/upay>
- [byteminus/laravel-bdpaygate](https://github.com/byteminus/laravel-bdpaygate)
  (`src/Drivers/UpayGateway.php`, `tests/Conformance/UpayScenario.php`)

## Simulator

Create a Upay app with `merchant_id` and `merchant_key`. Every path ends in `/`.

| Call                                                         | Reply                                                                                                                            |
| ------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------- |
| `POST /payment/merchant-auth/` `{merchant_id, merchant_key}` | `MAS2001`, `data.token`; send it as `Authorization: UPAY <token>`                                                                |
| `POST /payment/merchant-payment-init/`                       | `MPIS2002`, `data.gateway_url` (mock wallet page). Duplicate `txn_id` → `DTP4003`. `SIM:<scenario>` in `invoice_id` or `txn_id`. |
| `GET /payment/single-payment-status/{txn_id}/`               | `PS2005`, `data.status` = success / failed / cancelled / expired / pending; unknown → `PNF4012`                                  |
| `POST /payment/bulk/refund/` `[{txn_id, refund_amount}]`     | `MPR_200`, `data.success_list` / `data.failed_list`                                                                              |

The checkout page runs number → OTP → PIN (nothing is stored), then sends the browser to
`redirect_url?status=…&invoice_id=…`. Upay documents **no IPN**, so confirm every payment with
single-payment-status.

The bad-credential code `MAE4001` is simulator-invented. Partial `refund_amount` works in the
simulator, but upstream support for it is unconfirmed: BDPayGate only sends full refunds.

## Real sandbox

Open **Real sandbox** in the sidebar and save the credentials Upay issues: merchant ID and key,
merchant code, name, mobile and category code. City and base URL are optional; the default
base URL is the UAT host `https://uat-pg.upay.systems`. Until then, Upay stays on the simulator.
In real mode:

- PaySim authenticates. The token is cached for 9 minutes and refreshed once on a 401/403.
- PaySim initialises the payment at Upay and returns Upay's `gateway_url`.
- Upay sends the browser back to PaySim. PaySim confirms with single-payment-status and checks
  the amount before forwarding to your `redirect_url`.
- Refunds go to `bulk/refund/`. "Your request is under process" counts as accepted and still pending.

The live host `pg.upaysystem.com` is cited by BDPayGate only. Live access needs Upay to
allow-list your server IP.
