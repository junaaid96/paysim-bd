# Nagad

Badge: **unverified** · Spec: `packages/gateways/nagad/spec/v1.json`

::: danger No official docs exist publicly
The Nagad developer portal is unreachable (DNS failure) and nagad.com.bd blocks non-browser fetches. This plugin is built from community SDKs (`nagadpy`, `foxses-pay`, `nagad-api`) and **every field is marked `unverified`**. Treat it as a shape sketch for local flow testing, not a faithful replica. It cannot be promoted without real-sandbox recordings.
:::

## Flow (community-observed)

1. **Initialize** — `POST /remote-payment-gateway-1.0/api/dfs/check-out/initialize/:merchantId/:orderId` with a sealed envelope (`sensitiveData` + `signature`) → returns `paymentReferenceId` + `challenge`.
2. **Complete** — `POST …/check-out/complete/:paymentReferenceId`, echoing the challenge with the amount → returns the mock-page `callBackUrl`.
3. **Customer pays** — mock page at `/nagad/checkout`, then the browser follows your `merchantCallbackURL` (GET) with `merchant`+`order_id`+`payment_ref_id`+`status`.
4. **Verify** — `GET …/verify/payment/:paymentReferenceId` polls `Success` / `FAIL` / `ABORTED` / `PENDING`.
5. **Refund** (optional) — `POST …/check-out/refund/:merchantId` with a sealed `{paymentRefId, originalAmount, cancelAmount, referenceNo, referenceMessage}` payload; full or partial. See [refunds](../concepts/refunds.md).

Magic: `orderId = SIM:<name>[:suffix]`. Unknown names fail initialize loudly.

## Crypto fixtures (fake keys, real shape)

Mutual RSA (PKCS1v15 encrypt, PKCS1v15+SHA256 sign) with **published fake keys** in `packages/gateways/nagad/spec/fixtures/FAKE-*.pem`. They prove message shape, never identity — the private keys are public by design and documented as such. Timestamps are `YYYYMMDDHHMMSS` in Asia/Dhaka.
