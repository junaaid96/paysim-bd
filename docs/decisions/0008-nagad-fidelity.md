# 0008 — Nagad plugin fidelity calls (Phase 4)

Source of truth for field-level fidelity is
`packages/gateways/nagad/spec/v1.json`; this records the judgment calls.

## No official docs: everything unverified

- `developer.nagad.com.bd` did not resolve (DNS failure) and `nagad.com.bd`
  blocks non-browser fetches (403), so there is no official source to ground
  in. Every endpoint, field and hash rule is `fidelity: "unverified"` and the
  manifest top level is `"unverified"` (see the `Fidelity` enum extension).
- The flow shape comes from community SDKs (`nagadpy`,
  `foxses-pay/nagad`, `nagad-api`): initialize carries a sealed
  `{merchantId, orderId, challenge}`, complete echoes the challenge with the
  amount, verify polls `paymentReferenceId`. Sandbox hosts disagree across
  sources (`sandboxapi.nagad.com.bd` vs `sandbox.mynagad.com:10080`); both
  are listed with a dispute note and neither is trusted.
- Error and verify response shapes are invented for the sim (spec-noted):
  `{status, reason}` errors, verify `{status, amount, currency, trxId,
paymentReferenceId, merchantId, orderId}`. The verify status vocabulary
  (`Success`/`FAIL`/`ABORTED`/`PENDING`, camelCase `Cancel` redirect param)
  is community-observed. The real API surely differs; the suite in Phase 5
  cannot promote this gateway until real-sandbox fixtures exist.

## Mutual RSA with published fake keys

- Crypto shape (RSAES-PKCS1-v1_5 encrypt, RSASSA-PKCS1-v1_5 + SHA256 sign,
  base64 transport, exact-plaintext signing) mirrors the community code.
  Keys (`spec/fixtures/FAKE-*.pem`) prove message shape, never identity;
  the fixture README says so and the private keys are public by design.
- The simulator plays "Nagad" with the fixture keypair: decrypts requests,
  verifies merchant signatures, encrypts responses for the merchant's
  stored `merchant_public_key`, signs responses with the sim key.
- Hardness found during implementation: Node's base64 decoder never
  throws and OpenSSL 3.x `privateDecrypt` may return garbage bytes for
  short garbage input instead of erroring, so `rsaDecrypt` validates
  base64 strictly and requires ciphertext length == key size before
  decrypting. Garbage fails loudly at the crypto boundary.
- Date format `YYYYMMDDHHMMSS` renders in Asia/Dhaka (no DST) via
  `Intl.DateTimeFormat` with `timeZone: 'Asia/Dhaka'`; strict 14-digit
  regex on input.

## Two-step completion shapes selection and state

- `orderId` carries magic (`SIM:<name>[:suffix]`); unknown names fail
  loudly at initialize with no rows written. The envelope challenge is
  minted at initialize, echoed at complete (mismatch → 400), and
  cross-checked against the stored order (path/orderId/merchantId/order
  consistency all enforced).
- States: `initiated` (amount unknown, expiry-only) → `checkout` →
  `success`/`failed`/`cancelled`/`expired`. Initialize attaches a manual
  expiry timer; the real scenario attaches at complete (when amount and
  callback URL exist). Redirect actions before complete skip tolerantly.
- `send_ipn*` skip with the no-server-callback reason: like bKash, the
  customer browser carries `merchant`+`order_id`+`payment_ref_id`+`status`
  to `merchantCallbackURL` (GET). `http` callback URLs are allowed for
  localhost dev.
- `gatewayTxnId` is `merchantId:orderId` (idempotency scope: duplicates
  rejected); the session key is `paymentReferenceId`. Verify emits a
  community-shaped `trxId` (`SIMTRX` + 10 hex) on success only.
