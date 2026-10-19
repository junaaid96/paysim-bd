# bKash

Badge: **docs-only** · Spec: `packages/gateways/bkash/spec/v1.json` · Sources: [developer.bka.sh](https://developer.bka.sh/docs/grant-token.md)

Tokenized checkout (v2, no agreement): grant → create → customer verifies → execute → query.

## Endpoints

| Method   | Path                                        | Notes                                                                                    |
| -------- | ------------------------------------------- | ---------------------------------------------------------------------------------------- |
| POST     | `/v2/tokenized-checkout/auth/grant-token`   | `username`/`password` headers + `app_key`/`app_secret` body → `id_token` (1h)            |
| POST     | `/v2/tokenized-checkout/auth/refresh-token` | Rotates both tokens                                                                      |
| POST     | `/v2/tokenized-checkout/payment/create`     | `Authorization: <id_token>` + `X-APP-Key` → `paymentId`, `bkashURL`, three callback URLs |
| POST     | `/v2/tokenized-checkout/payment/execute`    | Only after verification; completion burns the `paymentId` (2062)                         |
| POST     | `/v2/tokenized-checkout/query/payment`      | `Initiated`/`Completed` × `Incomplete`/`Complete`                                        |
| GET/POST | `/bkash/checkout`                           | Mock verification page                                                                   |

## No webhooks

Tokenized checkout documents no server callback: the customer browser follows your callback URL with `paymentID`+`status`+`signature` (GET). The sim renders a redirect page and POSTs nothing; `send_ipn*` scenario steps record a skip explaining this. (The `signature` algorithm is unpublished — marked `unverified`.)

## Driving flows

- Magic: `merchantInvoiceNumber = SIM:<name>`.
- Execute before verification → `2060`; double execute → `2062`; unknown paymentId → `2002`. Every emitted code is a real documented code.
- Tokens live in memory (restarts invalidate them) and lifetimes read the fake clock. The 2/hour grant limit is not enforced.
