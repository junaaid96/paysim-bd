# Sample SSLCommerz client

A tiny Express shop integrated against paysim-bd exactly like it would
integrate against the real sandbox: init → redirect to the hosted page →
IPN listener → success/fail/cancel callbacks → server-side validation.

```sh
# Terminal 1: simulator API (from the repo root)
pnpm --filter @paysim/api dev

# Terminal 2: this shop
pnpm --filter @paysim/example-sslcommerz-client start
```

Open http://localhost:4000, press Pay, then click Success/Fail/Cancel on
the simulated payment page. Watch the order land live in the dashboard
(http://localhost:5173 with `pnpm dev`, or :8080 via compose).

Environment: `SIM_BASE_URL` (default http://localhost:3001), `PORT`
(default 4000), `CLIENT_BASE_URL` (default http://localhost:PORT).
