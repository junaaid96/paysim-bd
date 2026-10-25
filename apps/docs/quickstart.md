# 60-second quickstart

Prerequisites: Docker, or Node 22 + pnpm 12 + a local Postgres.

## 1. Start the simulator

```sh
git clone https://github.com/junaaid96/paysim-bd.git
cd paysim-bd
cp .env.example .env
docker compose up
```

Open the dashboard at `http://localhost:8080` (look for the "Sandbox only" note in the sidebar). The API listens on `http://localhost:3001`.

## 2. Create a fake store

```sh
curl -s -X POST http://localhost:3001/api/apps \
  -H 'content-type: application/json' \
  -H 'x-workspace-key: local-default' \
  -d '{"gateway":"sslcommerz","name":"demo","credentials":{"store_id":"testbox","store_passwd":"qwerty"}}'
```

Credentials must be obviously fake — production-looking keys and real gateway hosts are rejected.

## 3. Init a payment from your app

Point your gateway base URL at `http://localhost:3001` and init with a magic scenario marker:

```sh
curl -s -X POST http://localhost:3001/gwprocess/v4/api.php \
  -d store_id=testbox -d store_passwd=qwerty \
  -d total_amount=100.00 -d currency=BDT -d tran_id=DEMO-1 \
  -d product_category=demo \
  -d success_url=http://localhost:4000/success \
  -d fail_url=http://localhost:4000/fail \
  -d cancel_url=http://localhost:4000/cancel \
  -d value_d='SIM:immediate-success' | head -c 300
```

The response carries `GatewayPageURL`. Open it to see the mock payment page, or let the `immediate-success` scenario settle the payment for you.

## 4. Watch it live

Back in the dashboard: the transaction appears with a timeline (events + callback attempts), a request inspector with copy-as-curl, and a replay button.

Next: [Scenarios](/concepts/scenarios) · [Fake clock](/concepts/clock) · [bKash](/gateways/bkash) · [Nagad](/gateways/nagad) · [Rocket](/gateways/rocket) · [Upay](/gateways/upay)

## Next: Real sandbox (optional extra)

Once your flows pass on the simulator, you can rehearse SSLCommerz, bKash, Nagad, Rocket and Upay against the providers' own sandboxes from the
**Real sandbox** page in the sidebar. See [Real sandbox mode](./concepts/real-sandbox).
