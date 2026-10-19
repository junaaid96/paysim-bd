# Deploy (Render + Neon + R2)

One Render web service (Express serves the built React app, so the API + dashboard deploy together), Neon Postgres, and Cloudflare R2 for object storage. All free-tier friendly.

::: warning The hosted instance cannot reach your localhost
`ALLOW_PRIVATE_CALLBACK_TARGETS=false` blocks loopback/private/link-local callback targets. Develop callback flows locally with `docker compose up`; use hosted for exploring and sharing.
:::

## 1. Neon (Postgres)

1. Create a free Neon project + database.
2. Copy the **pooled** connection string and append `?sslmode=require`.
3. The API retries the first query because free compute wakes slowly, and the scheduler only arms timers while jobs are pending — no polling burns your compute hours.

## 2. R2 (object storage)

1. Create an R2 bucket (e.g. `paysim-bd`) and an API token with read/write on it.
2. Note the endpoint: `https://<account-id>.r2.cloudflarestorage.com`.

Never use `STORAGE_DRIVER=fs` on Render — the filesystem is ephemeral and bodies would vanish on restart.

## 3. Render (web service)

Create a **Web Service** from this repo (or from the GHCR image — see below):

| Setting       | Value                                                             |
| ------------- | ----------------------------------------------------------------- |
| Build command | `pnpm install --frozen-lockfile && pnpm build && pnpm db:migrate` |
| Start command | `pnpm --filter @paysim/api start`                                 |
| Environment   | `NODE_ENV=production`                                             |

Environment variables:

```sh
DATABASE_URL=postgresql://…?sslmode=require   # Neon pooled string
DB_POOL_MAX=5
STORAGE_DRIVER=s3
S3_ENDPOINT=https://<account-id>.r2.cloudflarestorage.com
S3_REGION=auto
S3_BUCKET=paysim-bd
S3_ACCESS_KEY_ID=…
S3_SECRET_ACCESS_KEY=…
S3_FORCE_PATH_STYLE=true
ALLOW_PRIVATE_CALLBACK_TARGETS=false
SIM_BASE_URL=https://<your-service>.onrender.com
```

Run `pnpm db:migrate` with the same `DATABASE_URL` if you deploy the GHCR image instead (migrations are idempotent).

Free Render services sleep when idle: scheduled jobs persist in Postgres and overdue ones run on boot, so a sleeping instance catches up on wake.

## 4. GHCR image (alternative)

Tagged releases publish `ghcr.io/junaaid96/paysim-bd` (see [release workflow](https://github.com/junaaid96/paysim-bd/actions)). Point Render at the image and set the same env vars; run migrations once from your machine:

```sh
DATABASE_URL='postgresql://…?sslmode=require' pnpm db:migrate
```

## Future: CLI tunnel relay

A relay that lets the hosted instance deliver callbacks to your localhost through an outbound tunnel is planned but not built. Until then: callbacks to localhost require local mode.
