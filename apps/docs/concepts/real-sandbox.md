# Real sandbox mode (optional)

Every gateway app starts in **Simulator** mode: PaySim answers every call itself and you
choose outcomes with scenarios. **Real sandbox** is an extra, per app: PaySim forwards the
payment to the provider's official sandbox using sandbox keys you save, and keeps doing
everything else (timeline, live feed, merchant callbacks/IPNs, refunds).

Your app does **not** change. It keeps calling PaySim with the same PaySim credentials;
only the dashboard switch changes where the money-side calls go.

| Gateway    | Real sandbox                  | What PaySim calls                                                                                                     |
| ---------- | ----------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| SSLCommerz | Available                     | `sandbox.sslcommerz.com`: session API, validation API (on every return/IPN), refund API                               |
| bKash      | Available                     | `tokenized.sandbox.bka.sh` (tokenized checkout v1.2.0-beta): grant token, create, execute, payment status, refund     |
| Nagad      | Requires merchant credentials | Not offered: Nagad sandbox access needs a merchant ID and RSA keys issued by Nagad. Nagad apps stay on the simulator. |

## Turn it on

1. Open **Gateways** in the dashboard and find the app.
2. Enter the provider's sandbox keys (or click **Use public test keys** where the provider
   publishes them) and press **Save keys & use Real sandbox**.
3. Switch back to **Simulator** any time; the keys stay saved (encrypted) until you remove them.

Keys are encrypted at rest with AES-256-GCM (`PAYSIM_SECRETS_KEY` on the server) and are never
returned by the API: the dashboard only shows identifiers and a masked hint. If the server
has no `PAYSIM_SECRETS_KEY`, real-sandbox mode stays disabled.

## How each flow maps

**SSLCommerz.** Your init hits PaySim; PaySim creates the session at the SSLCommerz sandbox
with its own success/fail/cancel/IPN URLs and returns the sandbox `GatewayPageURL`. When the
customer comes back (or the IPN arrives), PaySim calls the **validation API** — a success is
never trusted from the POST body — records the payment, then POSTs the usual callback to your
`success_url`/`fail_url`/`cancel_url` and your IPN, signed with your PaySim `store_passwd`.
`val_id` and `bank_tran_id` are the provider's. Your validation and refund calls go to PaySim
as before; refunds are executed at the SSLCommerz sandbox refund API.

**bKash.** Grant-token stays a PaySim token. On create, PaySim grants (and caches in
`kv_entries`) a real sandbox token and creates the payment at bKash; the `paymentID` and
`bkashURL` you get are bKash's. bKash returns the customer to PaySim, which redirects to your
`callbackURL` with the usual `paymentID`/`status`. Execute, query and refund are forwarded to
bKash; the `trxID` is bKash's. The public tokenized sandbox allows **one refund per payment**
(full or partial), so PaySim declines a second refund instead of double-counting it.

## Test values

- SSLCommerz public test store: `testbox` / `qwerty`. Test card `4111 1111 1111 1111`, any
  future expiry, CVV `111`, then pick **Success** or **Failed** on the sandbox OTP page.
- bKash public tokenized sandbox: shared keys are prefilled by **Use public test keys**.
  Test wallets such as `01929918378` or `01619777283`, OTP `123456`, PIN `12121`. Shared
  wallets can get locked by other testers; try another one if bKash reports a locked wallet.

## What does not apply in real mode

- Scenarios (`SIM:` markers, default scenarios) and the fake clock: the provider decides the
  outcome. Checkout pages are the provider's own.
- `SIM:refund_fail` and the dashboard's "simulate failure" toggle: refunds are real sandbox
  refunds.
