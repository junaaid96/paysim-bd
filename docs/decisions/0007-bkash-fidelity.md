# 0007 — bKash plugin fidelity calls (Phase 3)

Source of truth for field-level fidelity is
`packages/gateways/bkash/spec/v1.json`; this records the judgment calls.

## v2 API, no agreement

- Implemented surface: grant/refresh token, create, execute, query
  (`/v2/tokenized-checkout/…` on `tokenized.sandbox.bka.sh`). Agreements,
  auth & capture, refunds and search are out of scope; coupon/agreement
  response fields are omitted.
- The v2 production host is unpublished in the consulted docs, so
  `productionHosts` is empty (with a spec note) rather than pattern-guessed.

## No server-to-server callback

- Tokenized checkout documents no webhook: the create response hands the
  merchant three callback URLs carrying `paymentID`+`status`+`signature`,
  which the customer browser follows (GET redirect). The simulator renders a
  meta-refresh redirect page and POSTs nothing — teaching merchants to
  expect a POST would be unfaithful. `send_ipn*` scenario actions record a
  skipped step explaining this. Transport mechanism is `docs-only`.

## Errors: real codes, documented mappings

- Every code emitted is real (`payment-error-codes.md`): 2060
  execute-before-verify, 2056 execute-on-failed/cancelled, 2002
  unknown/expired paymentId, 2062 double-execute, per-field create codes.
- `internalCode` appears only with sample-verified values; otherwise the
  field is omitted (it is sample-observed, not contractually documented).
- Simulator mapping choices (spec-noted): bad/expired token → 2003,
  expired paymentId → 2002, malformed optionals → 2025, HTTP 200 for all
  gateway-shaped errors, `Bearer` prefix accepted though samples show raw
  tokens, `http` callbackURLs allowed for localhost dev.
- "Cannot be reused after an execute attempt regardless of the result" is
  read as accepted executions: pre-condition rejections (2060/2056) do not
  burn the paymentId; only completion does (2062). Docs-only interpretation.

## Tokens and identifiers

- Token registry is in-memory per router (per process in the API host);
  restarts invalidate tokens. The 2/hour grant limit is not enforced.
  Lifetimes read the plugin clock, so fake-clock jumps expire tokens.
- `paymentId`/`trxId`/datetime/signature shapes follow the doc samples;
  signature generation is `unverified` (algorithm unpublished), as is the
  `0011` paymentId infix (the `0001` variant appears only in
  agreement/auth-capture samples).
- Amounts normalize to 2dp from minor units; zero/negative/unparseable and
  > 2dp inputs are rejected with 2006 (strictness is the safer direction for
  > a simulator: a sim-only failure is visible, a prod-only failure is not).
