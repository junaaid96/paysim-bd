# Refunds

All three gateways support **full and partial refunds** of completed payments,
through each gateway's own refund API shape and through the dashboard.

## Rules (same for every gateway)

- Only completed payments can be refunded: SSLCommerz `valid`, bKash
  `completed` (executed), Nagad `success`, Rocket `success`, Upay `success`.
- Refunds can be split into as many partial refunds as you like, but the total
  can never exceed the payment amount. The check is one atomic database update,
  so concurrent refund calls cannot over-refund.
- **Idempotent**: repeat a request with the same merchant reference
  (SSLCommerz `refund_trans_id`/`refe_id`, bKash `Idempotency-Key` header,
  Nagad `referenceNo`) and you get the original refund back. The same
  reference with a different amount is rejected.
- Refunds settle instantly. The payment state does not change, so validation
  and query calls keep working; the refund shows as `refundStatus`
  (`partial` / `full`) plus a refund list on the transaction.
- **Declined refund scenario**: put `SIM:refund_fail` in the refund reason
  (`refund_remarks`, `reason`, `referenceMessage`) or tick _Simulate a declined
  refund_ in the dashboard. The attempt is recorded as failed and no money moves.
- Every refund writes a `<gateway>.refund.completed` or
  `<gateway>.refund.failed` event to the timeline and the live feed.

## SSLCommerz

```bash
# Initiate (bank_tran_id comes from the success callback / validation API)
curl "$BASE/validator/api/merchantTransIDvalidationAPI.php?store_id=testbox&store_passwd=qwerty&format=json\
&bank_tran_id=$BANK_TRAN_ID&refund_amount=100.00&refund_remarks=Out%20of%20stock&refund_trans_id=RF-1001"
# → {"APIConnect":"DONE","status":"success","refund_ref_id":"SSLRF…",…}

# Status
curl "$BASE/validator/api/merchantTransIDvalidationAPI.php?store_id=testbox&store_passwd=qwerty&format=json&refund_ref_id=SSLRF…"
# → {"APIConnect":"DONE","status":"refunded",…}
```

## bKash

```bash
curl -X POST "$BASE/v2/tokenized-checkout/refund/payment/transaction" \
  -H "authorization: $ID_TOKEN" -H "x-app-key: sim-app-key" -H "Idempotency-Key: RF-1001" \
  -H "content-type: application/json" \
  -d '{"paymentId":"…","trxId":"…","refundAmount":"100.00","sku":"order-42","reason":"Out of stock"}'
# → {"refundTrxId":"BKRF…","refundTransactionStatus":"Completed",…}

curl -X POST "$BASE/v2/tokenized-checkout/refund/payment/status" \
  -H "authorization: $ID_TOKEN" -H "x-app-key: sim-app-key" -H "content-type: application/json" \
  -d '{"paymentId":"…","trxId":"…"}'
# → {"refundTransactions":[…]}
```

Refund error codes `2071` (invalid amount), `2072` (exceeds refundable amount)
and `2073` (duplicate reference) are simulator choices; a declined refund
answers `2003 Process failed`.

## Nagad

`POST /remote-payment-gateway-1.0/api/dfs/check-out/refund/{merchantId}` with
the usual sealed `{sensitiveData, signature}` envelope. Decrypted payload:

```json
{
  "merchantId": "SIM-MERCHANT-001",
  "paymentRefId": "SIMREF…",
  "originalRequestDate": "20261022",
  "originalAmount": "300.00",
  "cancelAmount": "100.00",
  "referenceNo": "RF-1001",
  "referenceMessage": "Out of stock"
}
```

The sealed response opens to
`{status, paymentRefId, cancelAmount, cancelTrxId, refundedAmount, refundStatus}`.
After a refund, `GET …/verify/payment/{paymentRefId}` also returns
`refundedAmount` and `refundStatus`.

## Dashboard

Open a completed payment and press **Refund**: enter the amount (or **Full**),
an optional reason, and confirm. The API behind it is
`POST /api/txns/:id/refunds` with `{amountMinor, reason?, idempotencyKey?, simulateFailure?}`.

## Rocket

DBBL documents no refund API. Rocket refunds (full or partial) are recorded from the dashboard; in real mode PaySim declines them and points you to the DBBL merchant panel.

## Upay

`POST /payment/bulk/refund/` with `[{txn_id, refund_amount}]`. Partial amounts work in the simulator; upstream partial support is unconfirmed.
