# 0009 — Parity suite, docs, release (Phase 5)

## Parity replays HTTP, diffs shape

- `@paysim/parity` replays v1 JSON fixtures over HTTP against a running
  simulator (never in-process): it exercises the real stack including
  content types, status codes and the management API. The same fixtures
  run three ways: `apps/api/tests/parity.integration.test.ts` (inside
  `pnpm test`), the `paysim-parity` CLI (manual/CI against any deploy),
  and a CI step that boots the API hosted-like
  (`ALLOW_PRIVATE_CALLBACK_TARGETS` unset = false).
- Shape diff is strict both ways (missing AND unexpected keys mismatch)
  with `$any`/`$regex`/`$optional` placeholders; a single-item expected
  array is a per-item shape. Strictness is deliberate: a sim that emits
  fields the sandbox never sends is lying by addition.
- Honesty labels (`docs-sample` < `community-sample` < `real-sandbox`)
  cap the badge; `evaluateBadges` rejects a `verified` claim unless
  every implemented endpoint has passing `real-sandbox` coverage, and
  rejects empty coverage for claimed gateways. Verified locally by
  flipping a spec to `verified` and watching the CLI exit 1.
- No Nagad fixtures: sealed envelopes can't be captured statically, and
  replaying our own invented shapes would be theater. Nagad stays
  `unverified` with zero coverage, stated in the report and docs.
- Large bodies: `jsonKey`/`shapeKey` refs resolve from the fixtures dir
  or `s3://bucket/key` (one bkash step proves the fs path; s3 via an
  injected client test, no live bucket needed).

## Docs + release versions (checked 2026-10-19)

- `vitepress@1.6.4`, `vue@3.5.44` (npm registry). Base `/paysim-bd/`
  for project Pages at `junaaid96.github.io/paysim-bd`.
- Release workflow pins (GitHub releases pages):
  `docker/build-push-action@v7` (v7.4.0),
  `docker/login-action@v4` (v4.6.0),
  `docker/metadata-action@v6` (v6.2.0),
  plus the repo's existing `actions/checkout@v7`.
  Docs deploy uses `actions/upload-pages-artifact@v4` +
  `actions/deploy-pages@v4` (same as the existing CI file's era).

## One image, full-copy Dockerfiles

- Phase 5 found the Dockerfiles stale (missing bkash/nagad/parity, so
  `--frozen-lockfile` installs were broken). Both Dockerfiles now
  `COPY . .` + full install + dependency-filtered builds
  (`--filter @paysim/api... --filter @paysim/web...`): always correct,
  never a hand-kept package.json list. `docker compose build` in CI is
  the backstop (no local daemon to verify with).
- The API image bakes the dashboard (`WEB_DIST_DIR=/app/web-dist`) —
  the GHCR image is the one-deploy hosted target. Compose keeps nginx
  on :8080; the dashboard port was corrected in the docs (:8080
  compose, :5173 `pnpm dev`, API :3001).
