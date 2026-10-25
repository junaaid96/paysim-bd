# Real sandbox (optional extra)

Every gateway app starts in **Simulator** mode: PaySim answers every call itself and you
choose outcomes with scenarios. **Real sandbox** is an optional extra with its own sidebar
page, per store: PaySim forwards the
payment to the provider's official sandbox using sandbox keys you save, and keeps doing
everything else (timeline, live feed, merchant callbacks/IPNs, refunds).

Your app does **not** change. It keeps calling PaySim with the same PaySim credentials;
only the switch on the Real sandbox page changes where the money-side calls go.

| Gateway    | Real sandbox               | What PaySim calls                                                                                                                                                                                                                      |
| ---------- | -------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| SSLCommerz | Available                  | `sandbox.sslcommerz.com`: session API, validation API (on every return/IPN), refund API                                                                                                                                                |
| bKash      | Available                  | `tokenized.sandbox.bka.sh` (tokenized checkout v1.2.0-beta): grant token, create, execute, payment status, refund                                                                                                                      |
| Nagad      | Needs merchant credentials | `sandbox.mynagad.com`: check-out initialize + complete (RSA-encrypted `sensitiveData` + signature), verify payment, refund (`purchase/cancel`). Active only once a store saves merchant ID, merchant private key and Nagad public key. |

## Turn it on

1. Open **Real sandbox** in the sidebar (marked _Extra_) and find the store.
2. Enter the provider's sandbox keys (or click **Fill public test keys** where the provider
   publishes them) and press **Save keys**.
3. Press **Test connection**. SSLCommerz runs a transaction query, bKash grants a token
   (nothing is charged). Nagad only answers allow-listed merchant servers, so its test checks
   offline that the keys load and can seal a request.
4. Turn on **Use Real sandbox for this store**. Turn it off any time; the keys stay saved
   (encrypted) until you remove them. Status shows _Not configured_, _Connected_ or _Error_.

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

**Nagad.** Your initialize hits PaySim; PaySim seals the provider's initialize request with
the Nagad public key and your merchant private key, completes the check-out and returns the
Nagad sandbox `callBackUrl`. When Nagad redirects back, PaySim calls **verify payment**
before recording a success and forwarding your usual callback. Refunds go to Nagad's
purchase-cancel endpoint. Nagad publishes no public test keys, so this adapter is verified
with mocked Nagad responses only.

## Test values

- SSLCommerz public test store: `testbox` / `qwerty`. Test card `4111 1111 1111 1111`, any
  future expiry, CVV `111`, then pick **Success** or **Failed** on the sandbox OTP page.
- bKash public tokenized sandbox: shared keys are prefilled by **Fill public test keys**.
  Test wallets such as `01929918378` or `01619777283`, OTP `123456`, PIN `12121`. Shared
  wallets can get locked by other testers; try another one if bKash reports a locked wallet.

## What does not apply in real mode

- Scenarios (`SIM:` markers, default scenarios) and the fake clock: the provider decides the
  outcome. Checkout pages are the provider's own.
- `SIM:refund_fail` and the dashboard's "simulate failure" toggle: refunds are real sandbox
  refunds.
