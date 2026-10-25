# Rocket (Dutch-Bangla Bank)

Fidelity: **unverified**. DBBL publishes a WSDL for its e-commerce service but no prose
docs; message formats come from a legacy open-source integration.

Sources:

- WSDL/XSD (public): <https://ecomtest.dutchbanglabank.com/ecomws/dbblecomtxn?wsdl>
- Redirect and result formats: [fattah/banglapay](https://github.com/fattah/banglapay)
  (`api/dbbl_lib.php`, `dbblcallback.php`)

## Simulator

Create a Rocket app with `userid`, `pwd` and `return_url`, then point your SOAP client at
`<PaySim base>/ecomws/dbblecomtxn` (namespace `http://ecom.dbbl/`).

| Call                                                            | What PaySim does                                                                                                                                                    |
| --------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `getransid(userid, pwd, amount, cardtype, txnrefnum, clientip)` | Opens a session. `amount` is in **paisa** (legacy jar: BDT × 100). Returns `TRANSACTION_ID: <28 chars>`. Put `SIM:<scenario>` in `txnrefnum` to choose the outcome. |
| `GET /ecomm2/ClientHandler?card_type=<code>&trans_id=<id>`      | The mock Rocket wallet page: number → OTP → PIN (any test values; nothing is stored), or fail / cancel.                                                             |
| Browser return                                                  | `302`-style hop to your `return_url?trans_id=<id>`. DBBL documents **no IPN**, so the return is unsigned. Always confirm it with `getresult`.                       |
| `getresult` / `getresultrocket(userid, pwd, transid, clientip)` | `RESULT: OK` / `RESULT_PS: FINISHED` / `RESULT_CODE: 000` on success; `RESULT: TIMEOUT` / `RESULT_PS: CANCELLED` on cancel.                                         |

Errors: bad credentials return `Wrong Merchant ID`, and an unknown transid returns
`RESULT>Invalid Transaction ID`. Both strings were observed on DBBL's test host. The failure
line (`RESULT: FAILED`, code `116`), the pending line and the getransid input errors are
**simulator-invented**.

Refunds: DBBL documents no refund API. Refund a Rocket payment (fully or partly) from the
dashboard. In real mode, refunds happen in the DBBL merchant panel.

## Real sandbox

Open **Real sandbox** in the sidebar and save the credentials DBBL issues: user ID,
password and the Rocket card type code. You can also set a base URL (the default is
`https://ecomtest.dutchbanglabank.com`) and a client IP. Until then, Rocket stays on the
simulator. In real mode:

- PaySim forwards `getransid` to DBBL.
- `ClientHandler` redirects to DBBL's own page.
- `getresult` / `getresultrocket` are proxied, and the local payment is settled from DBBL's answer.

**Test connection** calls `getransid`, because `getresult` checks the transid before the
credentials. That opens one unpaid 1-taka session at DBBL.

Open questions: the Rocket `cardtype` code, whether SOAP `getransid` expects paisa, and how
`getresult` differs from `getresultrocket`.
