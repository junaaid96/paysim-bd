# SSLCommerz

Badge: **docs-only** · Spec: `packages/gateways/sslcommerz/spec/v1.json` · Sources: [v4 docs](https://developer.sslcommerz.com/doc/v4/)

Session init + hosted payment page + server-to-server IPN.

## Endpoints

| Method   | Path                                     | Notes                                                                                                                                                   |
| -------- | ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| POST     | `/gwprocess/v4/api.php`                  | Init. Accepts JSON or form. Gateway-shaped failures answer HTTP 200 with `status: FAILED`; only malformed bodies get HTTP 400                           |
| GET/POST | `/gwprocess/v4/gw.php`                   | Mock payment page (`?Q=PAY&SESSIONKEY=…`), Success/Fail/Cancel buttons                                                                                  |
| GET      | `/validator/api/validationserverAPI.php` | Validation (`format=json&val_id&store_id&store_passwd`). First check returns `VALID`, repeats return `VALIDATED`, unknown returns `INVALID_TRANSACTION` |

## Driving flows

- Magic: `value_d = SIM:<name>` (e.g. `SIM:amount-mismatch`). Unknown names fail init loudly.
- Duplicate `tran_id` is rejected, like the real gateway.
- IPN posts to your `ipn_url` with retries; the success/fail/cancel browser redirect posts to your `*_url`. Point them at localhost in local mode.
- A sample Express client lives in `examples/sslcommerz-client/` — init → redirect → IPN → validation, end to end.

## Known gaps

`verify_sign` vectors, `val_id`/`bank_tran_id` generation formats, and a few range rejections are marked `unverified` in the spec — the docs don't pin them down. These need real-sandbox recordings to promote.
